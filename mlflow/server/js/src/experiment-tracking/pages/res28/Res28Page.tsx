import React, { useEffect, useRef, useState } from 'react';
import { ScrollablePageWrapper } from '@mlflow/mlflow/src/common/components/ScrollablePageWrapper';
import { Button, Header, Spacer, useDesignSystemTheme } from '@databricks/design-system';
import { FormattedMessage } from 'react-intl';
import { withErrorBoundary } from '../../../common/utils/withErrorBoundary';
import ErrorUtils from '../../../common/utils/ErrorUtils';

const Res28Page = () => {
  const { theme } = useDesignSystemTheme();

  const DEFAULT_IFRAME_SRC = `https://res28.itu.dk`;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [iframeUrl, setIframeUrl] = useState<string>("undefined");

  const handleOpenInNewTab = () => {
    const current = iframeRef.current?.src || DEFAULT_IFRAME_SRC;
    window.open(current, '_blank');
  };

  // Improved message handler: accept messages regardless of evt.origin but validate the reported URL
  useEffect(() => {
    const onMessage = (evt: MessageEvent) => {
      const data = evt.data;
      console.log('Res28Page received message:', evt, data);
      let url: string | null = null;

      if (!data) return;
      if (data.type === 'href' && typeof data.href === 'string') {
        url = data.href;
      } else {
        return;
      }

      if (!url) return;

      try {
        // normalize relative urls by providing BASE_ORIGIN as base
        const parsed = new URL(url);

        // Compose display URL as BASE_ORIGIN + /res28 + params
        const display = `/res28${parsed.search || ''}${parsed.hash || ''}`;
        setIframeUrl(display);
      } catch {
        // ignore malformed urls
      }
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

      <div
        css={{
          padding: '8px 12px',
          background: theme.colors.background,
          borderBottom: `1px solid ${theme.colors.border}`,
          color: theme.colors.textPrimary,
          fontSize: '13px',
        }}
        title={iframeUrl}
      >
        <strong>
          <FormattedMessage defaultMessage="Iframe URL:" description="Label for iframe URL display" />
        </strong>{' '}
        <span css={{ overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block', maxWidth: '80%' }}>
          {iframeUrl}
        </span>
      </div>

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
          src={DEFAULT_IFRAME_SRC}
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
