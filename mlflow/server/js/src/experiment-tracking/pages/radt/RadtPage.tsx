import { useEffect, useRef, useState } from 'react';
import { ScrollablePageWrapper } from '@mlflow/mlflow/src/common/components/ScrollablePageWrapper';
import { Spacer, useDesignSystemTheme } from '@databricks/design-system';
import { useLocation, useNavigate } from '../../../common/utils/RoutingUtils';
import { withErrorBoundary } from '../../../common/utils/withErrorBoundary';
import ErrorUtils from '../../../common/utils/ErrorUtils';

// Baked in at build time by craco/webpack, so the deployed image cannot change
// it without a rebuild.
const RADT_URL = process.env['REACT_APP_RADT_URL']?.trim() || 'missing_radT_url';

/**
 * Only same-document suffixes are forwarded into our own pathname. Rejecting
 * anything else keeps a message from an unexpected frame from steering
 * navigation off this page.
 */
const isSameDocumentSuffix = (url: string) => /^[?#]/.test(url);

const RadtPage = () => {
  const { theme } = useDesignSystemTheme();
  const location = useLocation();
  const navigate = useNavigate();

  // Held in state rather than derived from `location`: radT drives the URL via
  // postMessage, and feeding those updates back into `src` would reload the
  // iframe and discard the state radT just reported.
  const [iframeSrc] = useState(() => `${RADT_URL}${location.search}`);

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
      </div>
    </ScrollablePageWrapper>
  );
};

export default withErrorBoundary(ErrorUtils.mlflowServices.EXPERIMENTS, RadtPage);
