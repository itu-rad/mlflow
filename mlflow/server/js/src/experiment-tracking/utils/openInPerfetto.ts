/**
 * Hands a trace to the hosted Perfetto UI.
 *
 * Perfetto also accepts a `?url=` deep link, but that makes ui.perfetto.dev
 * fetch the trace itself -- which would mean exposing the artifact store
 * publicly with permissive CORS. Posting the bytes keeps the fetch inside the
 * already-authenticated session instead, so nothing needs to be reachable from
 * outside.
 */
export const PERFETTO_ORIGIN = 'https://ui.perfetto.dev';

/** How long to keep pinging before giving up on the Perfetto tab. */
const HANDSHAKE_TIMEOUT_MS = 20_000;
const PING_INTERVAL_MS = 100;

export class PerfettoHandoffError extends Error {}

/**
 * Opens the Perfetto tab.
 *
 * Separate from {@link postTraceToPerfetto} because it must run synchronously
 * inside the click handler: browsers treat `window.open` after an `await` as an
 * unsolicited pop-up and block it.
 */
export const openPerfettoTab = (): Window | null => window.open(PERFETTO_ORIGIN);

/** Posts a trace into a tab previously opened by {@link openPerfettoTab}. */
export const postTraceToPerfetto = (target: Window, buffer: ArrayBuffer, title: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      window.clearInterval(pingTimer);
      window.clearTimeout(timeoutTimer);
      window.removeEventListener('message', onMessage);
    };

    // Perfetto answers PING with PONG once its service worker is ready. Nothing
    // about a cross-origin tab's load state is observable, so polling is the
    // documented way to discover readiness.
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== PERFETTO_ORIGIN || event.data !== 'PONG' || settled) {
        return;
      }
      settled = true;
      cleanup();
      target.postMessage({ perfetto: { buffer, title } }, PERFETTO_ORIGIN);
      resolve();
    };

    window.addEventListener('message', onMessage);
    const pingTimer = window.setInterval(() => target.postMessage('PING', PERFETTO_ORIGIN), PING_INTERVAL_MS);
    const timeoutTimer = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new PerfettoHandoffError('The Perfetto UI did not respond. Check that the new tab opened correctly.'));
    }, HANDSHAKE_TIMEOUT_MS);
  });
