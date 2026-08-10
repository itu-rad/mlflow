import { fetchAPI, getAjaxUrl, HTTPMethods } from '../../common/utils/FetchUtils';

/** Where an export would read spans from; null means there is nothing to export. */
export type RadtTraceSource = 'radt' | 'mlflow' | null;

export interface RadtTraceStatus {
  available: boolean;
  source: RadtTraceSource;
  artifact_path: string | null;
}

export interface RadtTraceExportResponse {
  artifact_path: string;
}

export const RadtTraceApi = {
  getStatus: (runUuid: string): Promise<RadtTraceStatus> =>
    fetchAPI(
      getAjaxUrl(`ajax-api/2.0/mlflow/radt-trace/status?run_id=${encodeURIComponent(runUuid)}`),
    ) as Promise<RadtTraceStatus>,

  /**
   * Builds the trace, or returns the cached one. Synchronous on the server: the
   * artifact is the cache, so only the first export pays the conversion cost.
   */
  export: (runUuid: string): Promise<RadtTraceExportResponse> =>
    fetchAPI(getAjaxUrl('ajax-api/2.0/mlflow/radt-trace/export'), {
      method: HTTPMethods.POST,
      body: { run_id: runUuid },
    }) as Promise<RadtTraceExportResponse>,
};
