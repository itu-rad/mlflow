import { useState } from 'react';
import { Button, Tooltip, useDesignSystemTheme } from '@databricks/design-system';
import { FormattedMessage, useIntl } from 'react-intl';
import { useMutation, useQuery } from '@mlflow/mlflow/src/common/utils/reactQueryHooks';
import Utils from '../../../common/utils/Utils';
import { getArtifactLocationUrl } from '../../../common/utils/ArtifactUtils';
import { openPerfettoTab, postTraceToPerfetto } from '../../utils/openInPerfetto';
import { RadtTraceApi } from '../../utils/radtTraceApi';

/**
 * Opens a run's radT trace in the Perfetto UI, exporting it first if needed.
 *
 * Renders nothing when the run has no spans, so ordinary runs are unaffected.
 */
export const RunViewOpenTraceButton = ({ runUuid, runName }: { runUuid: string; runName?: string }) => {
  const { theme } = useDesignSystemTheme();
  const intl = useIntl();
  const [isOpening, setIsOpening] = useState(false);

  const { data: status } = useQuery({
    queryKey: ['radt-trace-status', runUuid],
    queryFn: () => RadtTraceApi.getStatus(runUuid),
    // The answer only changes when we ourselves export, and we invalidate then.
    staleTime: Infinity,
    retry: false,
  });

  const exportTrace = useMutation({
    mutationFn: () => RadtTraceApi.export(runUuid),
  });

  const handleClick = async () => {
    // Opened first, while still inside the user gesture: after the awaits below
    // the browser would treat window.open as an unsolicited pop-up.
    const target = openPerfettoTab();
    if (!target) {
      Utils.logErrorAndNotifyUser(
        intl.formatMessage({
          defaultMessage: 'Could not open the Perfetto UI. Allow pop-ups for this site and try again.',
          description: 'Error shown when the browser blocks the Perfetto tab',
        }),
      );
      return;
    }

    setIsOpening(true);
    try {
      const artifactPath = status?.artifact_path ?? (await exportTrace.mutateAsync()).artifact_path;
      const response = await fetch(getArtifactLocationUrl(artifactPath, runUuid));
      if (!response.ok) {
        throw new Error(`Failed to download the trace (HTTP ${response.status})`);
      }
      await postTraceToPerfetto(target, await response.arrayBuffer(), runName ? `${runName} — radT trace` : runUuid);
    } catch (error: any) {
      // Don't leave an orphaned blank Perfetto tab behind on failure.
      target.close();
      Utils.logErrorAndNotifyUser(
        error?.message ??
          intl.formatMessage({
            defaultMessage: 'Could not open the trace.',
            description: 'Generic error when opening a radT trace fails',
          }),
      );
    } finally {
      setIsOpening(false);
    }
  };

  if (!status || (!status.available && !status.source)) {
    return null;
  }

  const label = status.available ? (
    <FormattedMessage defaultMessage="Open trace" description="Button opening a run's trace in the Perfetto UI" />
  ) : (
    <FormattedMessage
      defaultMessage="Generate trace"
      description="Button building a run's trace before opening it in the Perfetto UI"
    />
  );

  return (
    <Tooltip
      componentId="mlflow.run-view.open-trace-button.tooltip"
      content={
        status.available ? (
          <FormattedMessage
            defaultMessage="Open this run's trace in the Perfetto UI"
            description="Tooltip for the open trace button when a trace already exists"
          />
        ) : (
          <FormattedMessage
            defaultMessage="Build this run's Perfetto trace and open it. This may take a moment for large runs."
            description="Tooltip for the open trace button when the trace must be built first"
          />
        )
      }
    >
      <Button
        componentId="mlflow.run-view.open-trace-button"
        data-testid="run-open-trace-button"
        onClick={handleClick}
        loading={isOpening}
        css={{ marginRight: theme.spacing.sm }}
      >
        {label}
      </Button>
    </Tooltip>
  );
};
