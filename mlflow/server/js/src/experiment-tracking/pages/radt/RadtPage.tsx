import { useEffect, useMemo, useRef } from 'react';
import { ScrollablePageWrapper } from '@mlflow/mlflow/src/common/components/ScrollablePageWrapper';
import { Empty, Spacer, Spinner, useDesignSystemTheme } from '@databricks/design-system';
import { FormattedMessage } from 'react-intl';
import { useQuery } from '@mlflow/mlflow/src/common/utils/reactQueryHooks';
import { fetchAPI, getAjaxUrl } from '../../../common/utils/FetchUtils';
import { useLocation, useNavigate } from '../../../common/utils/RoutingUtils';
import { withErrorBoundary } from '../../../common/utils/withErrorBoundary';
import ErrorUtils from '../../../common/utils/ErrorUtils';

interface RadtConfigResponse {
  radt_url: string | null;
}

/**
 * Only same-document suffixes are forwarded into our own pathname. Rejecting
 * anything else keeps a message from an unexpected frame from steering
 * navigation off this page.
 */
const isSameDocumentSuffix = (url: string) => /^[?#]/.test(url);

const centeredEmptyStyles = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  minHeight: 400,
  width: '100%',
  '& > div': {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
  },
} as const;

const RadtPage = () => {
  const { theme } = useDesignSystemTheme();
  const location = useLocation();
  const navigate = useNavigate();

  // Resolved from the server rather than baked into the bundle, so one wheel can
  // be pointed at any radT instance.
  const { data, isLoading } = useQuery({
    queryKey: ['radt-config'],
    queryFn: () => fetchAPI(getAjaxUrl('ajax-api/2.0/mlflow/radt-config')) as Promise<RadtConfigResponse>,
    staleTime: Infinity,
  });

  const radtUrl = data?.radt_url;

  // Pinned to the search string we mounted with: radT drives the URL via
  // postMessage afterwards, and rebuilding `src` from the live location would
  // reload the iframe and discard the state radT just reported.
  const initialSearch = useRef(location.search);
  const iframeSrc = useMemo(() => (radtUrl ? `${radtUrl}${initialSearch.current}` : null), [radtUrl]);

  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;

  useEffect(() => {
    const onMessage = (evt: MessageEvent) => {
      const data = evt.data;
      if (!data || data.type !== 'href' || typeof data.href !== 'string') {
        return;
      }
      if (!isSameDocumentSuffix(data.href)) {
        return;
      }
      navigate(`${pathnameRef.current}${data.href}`);
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate]);

  const renderBody = () => {
    if (isLoading) {
      return (
        <div css={centeredEmptyStyles}>
          <Spinner />
        </div>
      );
    }

    if (!iframeSrc) {
      return (
        <div css={centeredEmptyStyles}>
          <Empty
            title={
              <FormattedMessage
                defaultMessage="radT is not configured"
                description="Title shown on the radT page when the server has no radT URL configured"
              />
            }
            description={
              <FormattedMessage
                defaultMessage="Set the MLFLOW_RADT_URL environment variable on the MLflow server to the address of your radT instance, then reload this page. The address must be reachable from your browser."
                description="Guidance shown on the radT page when the server has no radT URL configured"
              />
            }
          />
        </div>
      );
    }

    return (
      <iframe
        src={iframeSrc}
        title="radT Analyze"
        css={{
          border: 'none',
          width: '100%',
          height: '100%',
          flexGrow: 1,
        }}
        sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
      />
    );
  };

  return (
    <ScrollablePageWrapper css={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <Spacer shrinks={false} />
      <div
        css={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: `1px solid ${theme.colors.border}`,
          borderRadius: theme.general.borderRadiusBase,
        }}
      >
        {renderBody()}
      </div>
    </ScrollablePageWrapper>
  );
};

export default withErrorBoundary(ErrorUtils.mlflowServices.EXPERIMENTS, RadtPage);
