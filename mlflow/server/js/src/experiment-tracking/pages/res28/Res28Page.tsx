import React, { useEffect, useRef, useState } from 'react';
import { ScrollablePageWrapper } from '@mlflow/mlflow/src/common/components/ScrollablePageWrapper';
import { Button, Header, Spacer, useDesignSystemTheme } from '@databricks/design-system';
import { FormattedMessage } from 'react-intl';
import { withErrorBoundary } from '../../../common/utils/withErrorBoundary';
import ErrorUtils from '../../../common/utils/ErrorUtils';

const Res28Page = () => {
  const { theme } = useDesignSystemTheme();

  const BASE_ORIGIN = 'https://res28.itu.dk';
  // load the res28 app at /res28 by default
  const DEFAULT_IFRAME_SRC = `${BASE_ORIGIN}/res28`;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [iframeUrl, setIframeUrl] = useState<string>(DEFAULT_IFRAME_SRC);

  const handleOpenInNewTab = () => {
    const current = iframeRef.current?.src || DEFAULT_IFRAME_SRC;
    window.open(current, '_blank');
  };

  // helper: replace parent URL search/hash to match parsed iframe URL (no reload)
  const syncParentUrlWithIframe = (parsed: URL) => {
    try {
      // Always set parent's pathname to /res28 and append iframe search + hash
      const nextFull = `/res28${parsed.search || ''}${parsed.hash || ''}`;
      const currentFull = `${window.location.pathname}${window.location.search || ''}${window.location.hash || ''}`;
      if (currentFull !== nextFull) {
        window.history.replaceState(null, '', nextFull);
      }
    } catch {
      // ignore
    }
  };

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

      try {
        // normalize relative urls by providing BASE_ORIGIN as base
        const parsed = new URL(url, BASE_ORIGIN);
        // only accept URLs that belong to the expected base origin
        if (parsed.origin !== BASE_ORIGIN) return;

        // Compose display URL as BASE_ORIGIN + /res28 + params
        const display = `${BASE_ORIGIN}/res28${parsed.search || ''}${parsed.hash || ''}`;
        setIframeUrl(display);

        // update parent search/hash to match iframe (without reloading)
        syncParentUrlWithIframe(parsed);
      } catch {
        // ignore malformed urls
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Periodically request the iframe to send its current URL and also request on load.
  useEffect(() => {
    const POLL_INTERVAL_MS = 1000;
    let id: number | null = null;

    const requestUrl = () => {
      try {
        // ask iframe for its current href; use '*' so message is delivered even if origin differs slightly
        iframeRef.current?.contentWindow?.postMessage({ type: 'getHref' }, '*');
      } catch {
        // ignore
      }

      // As a best-effort fallback, try to read location href if same-origin (will throw on cross-origin)
      try {
        const maybeHref = iframeRef.current?.contentWindow?.location?.href;
        if (typeof maybeHref === 'string') {
          const parsed = new URL(maybeHref);
          if (parsed.origin === BASE_ORIGIN) {
            const display = `${BASE_ORIGIN}/res28${parsed.search || ''}${parsed.hash || ''}`;
            setIframeUrl(display);
            // sync parent's search/hash to match iframe
            syncParentUrlWithIframe(parsed);
          }
        }
      } catch {
        // cross-origin — ignore
      }
    };

    // request immediately and then periodically
    requestUrl();
    id = window.setInterval(requestUrl, POLL_INTERVAL_MS);

    return () => {
      if (id !== null) clearInterval(id);
    };
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
          onLoad={() => {
            try {
              // request url on load (use '*' so delivery is not blocked by a strict targetOrigin mismatch)
              iframeRef.current?.contentWindow?.postMessage({ type: 'res28:parent-request-url' }, '*');
            } catch {
              // ignore
            }
          }}
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
