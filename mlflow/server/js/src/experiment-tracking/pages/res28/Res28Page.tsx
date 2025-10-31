import React, { useEffect, useRef, useState } from 'react';
import { ScrollablePageWrapper } from '@mlflow/mlflow/src/common/components/ScrollablePageWrapper';
import { Button, Header, Spacer, useDesignSystemTheme } from '@databricks/design-system';
import { FormattedMessage } from 'react-intl';
import { withErrorBoundary } from '../../../common/utils/withErrorBoundary';
import ErrorUtils from '../../../common/utils/ErrorUtils';

import { useLocation, useNavigate } from 'react-router-dom';
import { useCallback } from 'react';

const Res28Page = () => {
  const { theme } = useDesignSystemTheme();

  const DEFAULT_IFRAME_SRC = `https://res28.itu.dk`;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  // keep a separate state for the iframe's src so changing the URL does not reload the iframe
  const [iframeSrc, setIframeSrc] = useState<string>(() => {
    // initialize iframe src once from current location.search
    try {
      return DEFAULT_IFRAME_SRC + (location.search || '');
    } catch {
      return DEFAULT_IFRAME_SRC;
    }
  });
  const initializedRef = useRef(true);

  const handleOpenInNewTab = () => {
    const current = iframeRef.current?.src || DEFAULT_IFRAME_SRC;
    window.open(current, '_blank');
  };

  const readParamsFromLocation = () => {
    try {
      console.log('Res28Page readParamsFromLocation:', location.search);
      const sp = new URLSearchParams(location.search);
      return {
        runs: sp.get('runs') ?? '',
        charts: sp.get('charts') ?? '',
      };
    } catch {
      return { runs: '', charts: '' };
    }
  };

  useEffect(() => {
    const onPopState = () => {
      const p = readParamsFromLocation();
      // setRunsParam(p.runs);
      // setGraphsParam(p.graphs);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Improved message handler: accept messages regardless of evt.origin but validate the reported URL
  useEffect(() => {
    const onMessage = (evt: MessageEvent) => {
      const data = evt.data;
      let url: string | null = null;

      if (!data) return;
      if (data.type === 'href' && typeof data.href === 'string') {
        url = data.href;
      } else {
        return;
      }

      if (!url) return;

      navigate(`${location.pathname}${url}`, { replace: false });

    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <ScrollablePageWrapper css={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <Spacer shrinks={false} />
      <Header
        title={<FormattedMessage defaultMessage="radT Res28" description="Header title for the RES28 page" />}
        buttons={
          <Button componentId="mlflow.res28.openInNewTab" type="primary" onClick={handleOpenInNewTab}>
            <FormattedMessage
              defaultMessage="Open in new tab"
              description="Label for button to open Res28 in a new browser tab"
            />
          </Button>
        }
      />
      <Spacer shrinks={false} />
      <div css={{ 
        flex: 1, 
        display: 'flex', 
        flexDirection: 'column', 
        overflow: 'hidden',
        border: `1px solid ${theme.colors.border}`,
        borderRadius: theme.general.borderRadiusBase,
      }}>
        <iframe 
          ref={iframeRef}
          src={iframeSrc}//buildIframeUrl()}
          title="radT Res28"
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

export default withErrorBoundary(ErrorUtils.mlflowServices.EXPERIMENTS, Res28Page);
