import gzip
import json
from types import SimpleNamespace

import pytest

from mlflow.entities import Metric
from mlflow.server import radt_trace
from mlflow.server.radt_trace import RadtTraceError, _Span, build_pftrace
from mlflow.store.artifact.local_artifact_repo import LocalArtifactRepository

perfetto = pytest.importorskip("perfetto", reason="perfetto is an optional 'radt' extra")
from perfetto.protos.perfetto.trace.perfetto_trace_pb2 import Trace, TrackEvent


def parse(payload):
    trace = Trace()
    trace.ParseFromString(payload)
    return trace


def events_of(trace, event_type):
    return [
        packet.track_event
        for packet in trace.packet
        if packet.HasField("track_event") and packet.track_event.type == event_type
    ]


def descriptors(trace, field):
    return [
        packet.track_descriptor
        for packet in trace.packet
        if packet.HasField("track_descriptor") and packet.track_descriptor.HasField(field)
    ]


@pytest.fixture
def artifact_repo(tmp_path):
    (tmp_path / radt_trace.ARTIFACT_DIR).mkdir()
    return LocalArtifactRepository(tmp_path.as_uri())


def write_batches(tmp_path, records, schema_version=max(radt_trace.SUPPORTED_SCHEMA_VERSIONS)):
    directory = tmp_path / radt_trace.ARTIFACT_DIR
    directory.mkdir(exist_ok=True)
    with gzip.open(directory / "spans-000001.jsonl.gz", "wt", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record) + "\n")
    (directory / radt_trace.MANIFEST_NAME).write_text(
        json.dumps({
            "schema_version": schema_version,
            "run_id": "r",
            "event_count": len(records),
            "batches": ["spans-000001.jsonl.gz"],
        })
    )


# --- conversion -----------------------------------------------------------


def test_spans_become_slices_on_a_track_per_thread():
    spans = [
        _Span("outer", 1000, 5000, {"thread_id": 0}),
        _Span("inner", 2000, 3000, {"thread_id": 0}),
        _Span("other", 1500, 4000, {"thread_id": 1}),
    ]
    trace = parse(build_pftrace(spans, {}))

    assert len(descriptors(trace, "process")) == 1
    assert [d.name for d in descriptors(trace, "thread")] == ["Thread 0", "Thread 1"]
    assert len(events_of(trace, TrackEvent.TYPE_SLICE_BEGIN)) == 3
    assert len(events_of(trace, TrackEvent.TYPE_SLICE_END)) == 3


def test_tracks_are_ordered_by_their_first_span():
    spans = [
        _Span("late", 9000, 9500, {"thread_id": "late"}),
        _Span("early", 1000, 1500, {"thread_id": "early"}),
    ]
    trace = parse(build_pftrace(spans, {}))
    assert [d.name for d in descriptors(trace, "thread")] == ["Thread early", "Thread late"]


def test_spans_without_thread_id_keep_their_own_track():
    """The workload supplies thread_id, so it is often absent; dropping those
    spans (as the original export script did) loses real work.
    """
    spans = [_Span("no-thread", 1000, 2000, {"__trace_id": 77})]
    trace = parse(build_pftrace(spans, {}))

    assert [d.name for d in descriptors(trace, "thread")] == ["Trace 77"]
    assert len(events_of(trace, TrackEvent.TYPE_SLICE_BEGIN)) == 1


@pytest.mark.parametrize(
    ("value", "expected_field"),
    [
        (True, "bool_value"),
        (3, "int_value"),
        (1.5, "double_value"),
        ("text", "string_value"),
    ],
)
def test_attributes_become_typed_debug_annotations(value, expected_field):
    trace = parse(build_pftrace([_Span("s", 1, 2, {"thread_id": 0, "k": value})], {}))
    begin = events_of(trace, TrackEvent.TYPE_SLICE_BEGIN)[0]
    annotation = next(a for a in begin.debug_annotations if a.name == "k")
    assert annotation.WhichOneof("value") == expected_field


def test_internal_attributes_are_not_leaked_as_annotations():
    trace = parse(build_pftrace([_Span("s", 1, 2, {"__trace_id": 5, "keep": 1})], {}))
    begin = events_of(trace, TrackEvent.TYPE_SLICE_BEGIN)[0]
    assert {a.name for a in begin.debug_annotations} == {"keep"}


def test_nested_attributes_are_flattened():
    trace = parse(build_pftrace([_Span("s", 1, 2, {"a": {"b": 1}})], {}))
    begin = events_of(trace, TrackEvent.TYPE_SLICE_BEGIN)[0]
    assert {a.name for a in begin.debug_annotations} == {"a.b"}


def test_metrics_become_counter_tracks_with_nanosecond_timestamps():
    trace = parse(build_pftrace([_Span("s", 1, 2, {})], {"gpu": [(5, 10.0), (6, 20.0)]}))

    assert [d.name for d in descriptors(trace, "counter")] == ["gpu"]
    counters = events_of(trace, TrackEvent.TYPE_COUNTER)
    assert [c.double_counter_value for c in counters] == [10.0, 20.0]
    timestamps = [
        p.timestamp
        for p in trace.packet
        if p.HasField("track_event") and p.track_event.type == TrackEvent.TYPE_COUNTER
    ]
    assert timestamps == [5_000_000, 6_000_000]  # mlflow logs milliseconds


def test_empty_span_list_still_serialises():
    assert isinstance(build_pftrace([], {}), bytes)


# --- reading radt batches -------------------------------------------------


def test_unknown_schema_version_is_refused(artifact_repo, tmp_path):
    write_batches(tmp_path, [["s", 1, None, 1, "a", {}, 10]], schema_version=999)
    manifest = radt_trace._radt_manifest(artifact_repo)
    with pytest.raises(RadtTraceError, match="schema version 999 is not supported"):
        radt_trace._read_radt_spans(artifact_repo, manifest)


def test_starts_and_ends_are_paired_into_spans(artifact_repo, tmp_path):
    write_batches(
        tmp_path,
        [["s", 1, None, 1, "work", {"thread_id": 0}, 100], ["e", 1, 900]],
    )
    manifest = radt_trace._radt_manifest(artifact_repo)
    spans = radt_trace._read_radt_spans(artifact_repo, manifest)

    assert len(spans) == 1
    assert (spans[0].name, spans[0].start_ns, spans[0].end_ns) == ("work", 100, 900)


# A workload killed mid-span leaves a start with no matching end.
def test_unclosed_span_becomes_zero_length(artifact_repo, tmp_path):
    write_batches(tmp_path, [["s", 1, None, 1, "killed", {}, 100]])
    manifest = radt_trace._radt_manifest(artifact_repo)
    spans = radt_trace._read_radt_spans(artifact_repo, manifest)

    assert (spans[0].start_ns, spans[0].end_ns) == (100, 100)


def test_missing_manifest_reports_no_radt_tracing(artifact_repo):
    assert radt_trace._radt_manifest(artifact_repo) is None


# --- orchestration --------------------------------------------------------


class _Store:
    def __init__(self, history=None):
        self._history = history or {}

    def get_metric_history(self, run_id, key):
        return self._history.get(key, [])


def _run(tmp_path):
    return SimpleNamespace(
        info=SimpleNamespace(run_id="r", experiment_id="0", artifact_uri=tmp_path.as_uri()),
        data=SimpleNamespace(metrics={}),
    )


def test_export_writes_the_trace_as_an_artifact(artifact_repo, tmp_path):
    write_batches(tmp_path, [["s", 1, None, 1, "work", {"thread_id": 0}, 100], ["e", 1, 900]])
    path = radt_trace.export_trace(_Store(), artifact_repo, _run(tmp_path))

    assert path == f"{radt_trace.ARTIFACT_DIR}/{radt_trace.TRACE_NAME}"
    assert (tmp_path / radt_trace.ARTIFACT_DIR / radt_trace.TRACE_NAME).exists()


def test_export_reuses_an_existing_trace(artifact_repo, tmp_path):
    write_batches(tmp_path, [["s", 1, None, 1, "work", {}, 100], ["e", 1, 900]])
    radt_trace.export_trace(_Store(), artifact_repo, _run(tmp_path))
    built = tmp_path / radt_trace.ARTIFACT_DIR / radt_trace.TRACE_NAME
    built.write_bytes(b"sentinel")

    radt_trace.export_trace(_Store(), artifact_repo, _run(tmp_path))
    assert built.read_bytes() == b"sentinel"


def test_force_rebuilds_an_existing_trace(artifact_repo, tmp_path):
    write_batches(tmp_path, [["s", 1, None, 1, "work", {}, 100], ["e", 1, 900]])
    radt_trace.export_trace(_Store(), artifact_repo, _run(tmp_path))
    built = tmp_path / radt_trace.ARTIFACT_DIR / radt_trace.TRACE_NAME
    built.write_bytes(b"sentinel")

    radt_trace.export_trace(_Store(), artifact_repo, _run(tmp_path), force=True)
    assert built.read_bytes() != b"sentinel"


def test_export_without_spans_explains_itself(artifact_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(radt_trace, "_read_mlflow_spans", lambda *a, **k: [])
    with pytest.raises(RadtTraceError, match="no spans to export"):
        radt_trace.export_trace(_Store(), artifact_repo, _run(tmp_path))


def test_status_reports_radt_source_before_export(artifact_repo, tmp_path):
    write_batches(tmp_path, [["s", 1, None, 1, "work", {}, 100], ["e", 1, 900]])
    status = radt_trace.trace_status(_Store(), artifact_repo, _run(tmp_path))
    assert status == {"available": False, "source": "radt", "artifact_path": None}


def test_status_reports_mlflow_source_when_only_tracing_spans_exist(
    artifact_repo, tmp_path, monkeypatch
):
    monkeypatch.setattr(radt_trace, "_has_mlflow_spans", lambda run: True)
    status = radt_trace.trace_status(_Store(), artifact_repo, _run(tmp_path))
    assert status == {"available": False, "source": "mlflow", "artifact_path": None}


# A null source is how the UI knows to hide the button entirely.
def test_status_reports_no_source_when_the_run_has_no_spans(artifact_repo, tmp_path, monkeypatch):
    monkeypatch.setattr(radt_trace, "_has_mlflow_spans", lambda run: False)
    status = radt_trace.trace_status(_Store(), artifact_repo, _run(tmp_path))
    assert status == {"available": False, "source": None, "artifact_path": None}


def test_status_reports_available_after_export(artifact_repo, tmp_path):
    write_batches(tmp_path, [["s", 1, None, 1, "work", {}, 100], ["e", 1, 900]])
    radt_trace.export_trace(_Store(), artifact_repo, _run(tmp_path))
    status = radt_trace.trace_status(_Store(), artifact_repo, _run(tmp_path))
    assert status["available"] is True
    assert status["artifact_path"] == f"{radt_trace.ARTIFACT_DIR}/{radt_trace.TRACE_NAME}"


# Through the store rather than a direct database connection, so any backend works
# and no separate credentials are needed.
def test_metrics_are_read_through_the_store(artifact_repo, tmp_path):
    write_batches(tmp_path, [["s", 1, None, 1, "work", {}, 100], ["e", 1, 900]])
    run = _run(tmp_path)
    run.data.metrics = {"gpu": 1.0}
    store = _Store({"gpu": [Metric("gpu", 5.0, 1000, 0), Metric("gpu", 6.0, 2000, 1)]})

    radt_trace.export_trace(store, artifact_repo, run)
    payload = (tmp_path / radt_trace.ARTIFACT_DIR / radt_trace.TRACE_NAME).read_bytes()
    counters = events_of(parse(payload), TrackEvent.TYPE_COUNTER)
    assert [c.double_counter_value for c in counters] == [5.0, 6.0]
