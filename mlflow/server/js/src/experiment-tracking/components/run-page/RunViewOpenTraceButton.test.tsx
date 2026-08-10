import { jest, describe, beforeEach, it, expect } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignSystemProvider } from '@databricks/design-system';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@mlflow/mlflow/src/common/utils/reactQueryHooks';
import { RunViewOpenTraceButton } from './RunViewOpenTraceButton';
import { RadtTraceApi } from '../../utils/radtTraceApi';
import * as perfetto from '../../utils/openInPerfetto';

jest.mock('../../utils/radtTraceApi', () => ({
  RadtTraceApi: { getStatus: jest.fn(), export: jest.fn() },
}));

const mockGetStatus = jest.mocked(RadtTraceApi.getStatus);
const mockExport = jest.mocked(RadtTraceApi.export);

const renderButton = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<RunViewOpenTraceButton runUuid="run-1" runName="my-run" />, {
    wrapper: ({ children }) => (
      <DesignSystemProvider>
        <QueryClientProvider client={queryClient}>
          <IntlProvider locale="en">{children}</IntlProvider>
        </QueryClientProvider>
      </DesignSystemProvider>
    ),
  });
};

describe('RunViewOpenTraceButton', () => {
  let openTab: jest.SpiedFunction<typeof perfetto.openPerfettoTab>;
  let postTrace: jest.SpiedFunction<typeof perfetto.postTraceToPerfetto>;
  let fakeTab: { close: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    fakeTab = { close: jest.fn() };
    openTab = jest.spyOn(perfetto, 'openPerfettoTab').mockReturnValue(fakeTab as any);
    postTrace = jest.spyOn(perfetto, 'postTraceToPerfetto').mockResolvedValue(undefined);
    global.fetch = jest.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })) as any;
  });

  it('renders nothing when the run has no spans to export', async () => {
    mockGetStatus.mockResolvedValue({ available: false, source: null, artifact_path: null });
    renderButton();

    await waitFor(() => expect(mockGetStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('run-open-trace-button')).not.toBeInTheDocument();
  });

  it('offers to generate the trace when spans exist but no trace has been built', async () => {
    mockGetStatus.mockResolvedValue({ available: false, source: 'radt', artifact_path: null });
    renderButton();

    await waitFor(() => expect(screen.getByTestId('run-open-trace-button')).toBeInTheDocument());
    expect(screen.getByText('Generate trace')).toBeInTheDocument();
  });

  it('offers to open the trace when one already exists', async () => {
    mockGetStatus.mockResolvedValue({
      available: true,
      source: 'radt',
      artifact_path: 'radt-trace/trace.pftrace',
    });
    renderButton();

    await waitFor(() => expect(screen.getByText('Open trace')).toBeInTheDocument());
  });

  it('skips the export when the trace is already available', async () => {
    mockGetStatus.mockResolvedValue({
      available: true,
      source: 'radt',
      artifact_path: 'radt-trace/trace.pftrace',
    });
    renderButton();
    await waitFor(() => expect(screen.getByTestId('run-open-trace-button')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('run-open-trace-button'));

    await waitFor(() => expect(postTrace).toHaveBeenCalled());
    expect(mockExport).not.toHaveBeenCalled();
    expect(postTrace.mock.calls[0][2]).toBe('my-run — radT trace');
  });

  it('exports first when no trace exists yet', async () => {
    mockGetStatus.mockResolvedValue({ available: false, source: 'radt', artifact_path: null });
    mockExport.mockResolvedValue({ artifact_path: 'radt-trace/trace.pftrace' });
    renderButton();
    await waitFor(() => expect(screen.getByTestId('run-open-trace-button')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('run-open-trace-button'));

    await waitFor(() => expect(mockExport).toHaveBeenCalledWith('run-1'));
    expect(postTrace).toHaveBeenCalled();
  });

  it('opens the Perfetto tab before awaiting, so it is not treated as a pop-up', async () => {
    mockGetStatus.mockResolvedValue({ available: false, source: 'radt', artifact_path: null });
    let exportStarted = false;
    let tabOpenedFirst = false;
    mockExport.mockImplementation(async () => {
      exportStarted = true;
      tabOpenedFirst = openTab.mock.calls.length > 0;
      return { artifact_path: 'radt-trace/trace.pftrace' };
    });
    renderButton();
    await waitFor(() => expect(screen.getByTestId('run-open-trace-button')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('run-open-trace-button'));

    await waitFor(() => expect(exportStarted).toBe(true));
    expect(tabOpenedFirst).toBe(true);
  });

  it('closes the orphaned tab when the export fails', async () => {
    mockGetStatus.mockResolvedValue({ available: false, source: 'radt', artifact_path: null });
    mockExport.mockRejectedValue(new Error('no spans to export'));
    renderButton();
    await waitFor(() => expect(screen.getByTestId('run-open-trace-button')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('run-open-trace-button'));

    await waitFor(() => expect(fakeTab.close).toHaveBeenCalled());
    expect(postTrace).not.toHaveBeenCalled();
  });

  it('does not attempt a handoff when the browser blocks the tab', async () => {
    mockGetStatus.mockResolvedValue({
      available: true,
      source: 'radt',
      artifact_path: 'radt-trace/trace.pftrace',
    });
    openTab.mockReturnValue(null);
    renderButton();
    await waitFor(() => expect(screen.getByTestId('run-open-trace-button')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('run-open-trace-button'));

    await waitFor(() => expect(openTab).toHaveBeenCalled());
    expect(postTrace).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
