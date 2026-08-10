"""Perfetto trace export for radT runs.

A run's spans reach the server one of two ways: radT's batch tracing uploads
them as gzipped JSONL artifacts, or mlflow tracing writes them through the
tracing API. Both are normalised to :class:`_Span` here so a single converter
produces the ``.pftrace``, which is written back as a run artifact and served
to the Perfetto UI.

The built trace is cached as an artifact: exporting is idempotent, and a second
"open trace" costs a lookup rather than a rebuild.
"""

import gzip
import json
import logging
import os
import tempfile
import uuid
from dataclasses import dataclass, field
from typing import Any

_logger = logging.getLogger(__name__)

#: Written by radt's batch exporter; mirrored from ``radt.run.trace``.
ARTIFACT_DIR = "radt-trace"
MANIFEST_NAME = "manifest.json"
TRACE_NAME = "trace.pftrace"
#: Record layouts this reader understands. radt writes the version it used into
#: the manifest; refusing unknown ones beats silently misreading a new layout.
SUPPORTED_SCHEMA_VERSIONS = frozenset({1})

# Perfetto wants a process to hang the thread tracks off; the value is arbitrary
# but must be stable across the descriptors we emit.
_PROCESS_PID = 100
_SEQUENCE_ID = 42


class RadtTraceError(Exception):
    """Raised for conditions the UI should report verbatim to the user."""


@dataclass
class _Span:
    name: str
    start_ns: int
    end_ns: int
    attributes: dict[str, Any] = field(default_factory=dict)

    @property
    def track_key(self):
        """Spans are laid out on a track per workload thread.

        ``thread_id`` is set by the workload, not by radt, so it is frequently
        absent. Falling back to the trace id keeps those spans on the timeline
        instead of dropping them -- and since a thread's spans share a root
        trace, the grouping stays meaningful.
        """
        thread_id = self.attributes.get("thread_id")
        if thread_id is not None:
            return ("thread", thread_id)
        return ("trace", self.attributes.get("__trace_id"))

    @property
    def track_label(self):
        kind, value = self.track_key
        return f"Thread {value}" if kind == "thread" else f"Trace {value}"


def _flatten(value, parent_key="", sep="."):
    items = {}
    for key, item in value.items():
        name = f"{parent_key}{sep}{key}" if parent_key else str(key)
        if isinstance(item, dict):
            items.update(_flatten(item, name, sep))
        else:
            items[name] = item
    return items


def _flow_id(value):
    """Perfetto flow ids are 64-bit; radt correlates spans with UUID strings."""
    if not value:
        return None
    try:
        return uuid.UUID(str(value)).int & ((1 << 63) - 1)
    except ValueError:
        return None


# --- span sources ---------------------------------------------------------


def _radt_manifest(artifact_repo):
    """The manifest, or None when this run has no radT batch tracing.

    radt writes it last, so its absence also distinguishes an interrupted upload
    from a complete one.
    """
    try:
        entries = artifact_repo.list_artifacts(ARTIFACT_DIR)
    except Exception:
        # A run without radT tracing simply has no such directory, so this is not
        # an error -- but an unreachable artifact store looks identical from here,
        # so leave a trail rather than silently reporting "no tracing" for both.
        _logger.debug("radt-trace: could not list %s/", ARTIFACT_DIR, exc_info=True)
        return None
    names = {os.path.basename(entry.path) for entry in entries}
    if MANIFEST_NAME not in names:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        local = artifact_repo.download_artifacts(f"{ARTIFACT_DIR}/{MANIFEST_NAME}", tmp)
        with open(local, encoding="utf-8") as handle:
            return json.load(handle)


def _read_radt_spans(artifact_repo, manifest):
    version = manifest.get("schema_version")
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        raise RadtTraceError(
            f"radT trace schema version {version} is not supported by this server "
            f"(supported: {sorted(SUPPORTED_SCHEMA_VERSIONS)}). Upgrade MLflow."
        )

    starts = {}
    ends = {}
    trace_ids = {}
    with tempfile.TemporaryDirectory() as tmp:
        for name in manifest.get("batches", []):
            local = artifact_repo.download_artifacts(f"{ARTIFACT_DIR}/{name}", tmp)
            with gzip.open(local, "rt", encoding="utf-8") as handle:
                for line in handle:
                    record = json.loads(line)
                    if record[0] == "s":
                        _, span_id, _parent, trace_id, span_name, attrs, ts = record
                        starts[span_id] = (span_name, attrs or {}, ts)
                        trace_ids[span_id] = trace_id
                    elif record[0] == "e":
                        ends[record[1]] = record[2]

    spans = []
    for span_id, (name, attrs, start_ns) in starts.items():
        end_ns = ends.get(span_id)
        if end_ns is None:
            # Workload died mid-span; a zero-length slice is more honest on the
            # timeline than inventing an end time.
            end_ns = start_ns
        attributes = dict(attrs)
        attributes["__trace_id"] = trace_ids.get(span_id)
        spans.append(_Span(name=name, start_ns=start_ns, end_ns=end_ns, attributes=attributes))
    return spans


def _read_mlflow_spans(run_id, experiment_id):
    """Spans recorded through the mlflow tracing API (the non-default backend)."""
    from mlflow.tracking import MlflowClient

    client = MlflowClient()
    trace_infos, _ = client._tracking_client.store.search_traces(
        locations=[experiment_id],
        filter_string=f"metadata.`mlflow.sourceRun` = '{run_id}'",
        max_results=10000,
    )

    spans = []
    for info in trace_infos:
        try:
            trace = client.get_trace(info.trace_id, display=False)
        except Exception:
            _logger.exception("radt-trace: failed to fetch trace %s", info.trace_id)
            continue
        for span in trace.data.spans:
            attributes = dict(span.attributes or {})
            attributes["__trace_id"] = info.trace_id
            spans.append(
                _Span(
                    name=span.name,
                    start_ns=span.start_time_ns,
                    end_ns=span.end_time_ns or span.start_time_ns,
                    attributes=attributes,
                )
            )
    return spans


def _read_metrics(store, run):
    """Metric history per key, as counter tracks.

    Goes through the tracking store rather than a direct database connection so
    this works on any backend and needs no separate credentials.
    """
    series = {}
    for key in run.data.metrics:
        try:
            history = store.get_metric_history(run.info.run_id, key)
        except Exception:
            _logger.exception("radt-trace: failed to read metric history for %s", key)
            continue
        if points := [(m.timestamp, m.value) for m in history if m.timestamp is not None]:
            series[key] = sorted(points)
    return series


# --- perfetto conversion --------------------------------------------------


def build_pftrace(spans, metrics):
    """Serialise normalised spans + metric series into a Perfetto trace."""
    try:
        from perfetto.protos.perfetto.trace.perfetto_trace_pb2 import TrackEvent
        from perfetto.trace_builder.proto_builder import TraceProtoBuilder
    except ImportError as exc:
        raise RadtTraceError(
            "Perfetto trace export requires the 'perfetto' package. "
            "Install MLflow with the 'radt' extra to enable it."
        ) from exc

    builder = TraceProtoBuilder()

    # Tracks are laid out in the order their first span starts, so the timeline
    # reads top-to-bottom in the order work actually began.
    first_start = {}
    labels = {}
    for span in spans:
        key = span.track_key
        labels.setdefault(key, span.track_label)
        if key not in first_start or span.start_ns < first_start[key]:
            first_start[key] = span.start_ns
    ordered_tracks = sorted(first_start, key=first_start.__getitem__)

    if ordered_tracks:
        packet = builder.add_packet()
        packet.track_descriptor.uuid = uuid.uuid4().int & ((1 << 63) - 1)
        packet.track_descriptor.process.pid = _PROCESS_PID
        packet.track_descriptor.process.process_name = "radT"

    track_uuids = {}
    for rank, key in enumerate(ordered_tracks):
        track_uuid = uuid.uuid4().int & ((1 << 63) - 1)
        track_uuids[key] = track_uuid
        packet = builder.add_packet()
        packet.track_descriptor.uuid = track_uuid
        packet.track_descriptor.name = labels[key]
        packet.track_descriptor.thread.pid = _PROCESS_PID
        packet.track_descriptor.thread.tid = rank
        # Without this Perfetto orders tracks by uuid, which is random here.
        packet.track_descriptor.sibling_order_rank = rank

    for span in sorted(spans, key=lambda s: s.start_ns):
        track_uuid = track_uuids[span.track_key]
        packet = builder.add_packet()
        packet.timestamp = int(span.start_ns)
        packet.trusted_packet_sequence_id = _SEQUENCE_ID
        packet.track_event.type = TrackEvent.TYPE_SLICE_BEGIN
        packet.track_event.track_uuid = track_uuid
        packet.track_event.name = span.name

        flows = [
            flow
            for flow in (
                _flow_id(span.attributes.get("in_flow_id")),
                _flow_id(span.attributes.get("out_flow_id")),
            )
            if flow
        ]
        if flows:
            packet.track_event.flow_ids.extend(flows)

        for name, value in _flatten(span.attributes).items():
            if name.startswith("__"):  # internal plumbing, not user data
                continue
            annotation = packet.track_event.debug_annotations.add()
            annotation.name = name
            if isinstance(value, bool):
                annotation.bool_value = value
            elif isinstance(value, int):
                annotation.int_value = value
            elif isinstance(value, float):
                annotation.double_value = value
            else:
                annotation.string_value = str(value)

        packet = builder.add_packet()
        packet.timestamp = int(span.end_ns)
        packet.trusted_packet_sequence_id = _SEQUENCE_ID
        packet.track_event.type = TrackEvent.TYPE_SLICE_END
        packet.track_event.track_uuid = track_uuid

    for key, points in metrics.items():
        track_uuid = uuid.uuid4().int & ((1 << 63) - 1)
        packet = builder.add_packet()
        packet.track_descriptor.uuid = track_uuid
        packet.track_descriptor.name = key
        packet.track_descriptor.counter.unit_name = "value"
        for timestamp_ms, value in points:
            packet = builder.add_packet()
            packet.timestamp = int(timestamp_ms) * 1_000_000  # mlflow logs ms
            packet.trusted_packet_sequence_id = _SEQUENCE_ID
            packet.track_event.type = TrackEvent.TYPE_COUNTER
            packet.track_event.track_uuid = track_uuid
            packet.track_event.double_counter_value = float(value)

    return builder.serialize()


# --- orchestration --------------------------------------------------------


def _existing_trace(artifact_repo):
    try:
        entries = artifact_repo.list_artifacts(ARTIFACT_DIR)
    except Exception:
        _logger.debug("radt-trace: could not list %s/", ARTIFACT_DIR, exc_info=True)
        return False
    return any(os.path.basename(entry.path) == TRACE_NAME for entry in entries)


def _has_mlflow_spans(run):
    """Whether the run has any mlflow-tracing spans, without fetching them.

    Asks for a single trace: this runs on every run-page load, and the UI only
    needs to know whether exporting is possible at all.
    """
    from mlflow.tracking import MlflowClient

    try:
        infos, _ = MlflowClient()._tracking_client.store.search_traces(
            locations=[run.info.experiment_id],
            filter_string=f"metadata.`mlflow.sourceRun` = '{run.info.run_id}'",
            max_results=1,
        )
    except Exception:  # absence is the answer the UI needs; don't fail the page
        _logger.exception("radt-trace: mlflow trace lookup failed for %s", run.info.run_id)
        return False
    return bool(infos)


def trace_status(store, artifact_repo, run):
    """What the UI needs to label its button without building anything.

    ``source`` is where an export would read from; ``None`` means there is
    nothing to export, which is how the UI decides whether to offer the button.
    """
    if _existing_trace(artifact_repo):
        return {
            "available": True,
            "source": "radt" if _radt_manifest(artifact_repo) else "mlflow",
            "artifact_path": f"{ARTIFACT_DIR}/{TRACE_NAME}",
        }
    if _radt_manifest(artifact_repo):
        source = "radt"
    elif _has_mlflow_spans(run):
        source = "mlflow"
    else:
        source = None
    return {"available": False, "source": source, "artifact_path": None}


def export_trace(store, artifact_repo, run, force=False):
    """Build (or reuse) the run's Perfetto trace and return its artifact path."""
    if not force and _existing_trace(artifact_repo):
        return f"{ARTIFACT_DIR}/{TRACE_NAME}"

    manifest = _radt_manifest(artifact_repo)
    if manifest is not None:
        spans = _read_radt_spans(artifact_repo, manifest)
    else:
        spans = _read_mlflow_spans(run.info.run_id, run.info.experiment_id)

    if not spans:
        raise RadtTraceError(
            "This run has no spans to export. Enable radT tracing "
            "(radt.run.trace.start) in the workload, or check that the run finished."
        )

    payload = build_pftrace(spans, _read_metrics(store, run))

    with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, TRACE_NAME)
        with open(local, "wb") as handle:
            handle.write(payload)
        artifact_repo.log_artifact(local, ARTIFACT_DIR)

    return f"{ARTIFACT_DIR}/{TRACE_NAME}"
