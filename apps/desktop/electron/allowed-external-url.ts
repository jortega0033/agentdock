/**
 * The single validated gate every "open this outside the app" path routes through: window-open,
 * blocked in-app navigation, and OAuth authorization launches. A fork that later renders
 * untrusted content (a link inside a tool result, a provider-supplied URL) must never be able to
 * make this app launch `file:`/`javascript:`/`data:`/a custom protocol handler, or reach a bare
 * UNC/filesystem path, through `shell.openExternal`.
 */
export type OpenExternal = (url: string) => Promise<void>;
export type ExternalUrlLog = (message: string, meta: Record<string, string>) => void;

const defaultLog: ExternalUrlLog = (message, meta) => console.log(`[main] ${message}`, meta);

/**
 * Parses `candidate` and returns it only if it is safe to hand to `shell.openExternal`: an
 * absolute `https:` URL with a non-empty host and no embedded username/password. Every other
 * scheme (`file:`, `javascript:`, `data:`, `blob:`, `mailto:`, `tel:`, a custom/unregistered
 * scheme), a bare UNC or filesystem path, and anything the `URL` constructor rejects as malformed
 * all fail closed to `undefined`.
 */
export function parseAllowedExternalUrl(candidate: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (!url.hostname) return undefined;
  if (url.username || url.password) return undefined;
  return url;
}

/** Bounded logging: only the scheme and host ever reach a log line, never the full URL. */
export function externalUrlLogSummary(url: URL): Record<string, string> {
  return { scheme: url.protocol, host: url.hostname };
}

/** Validates once, opens at most once, and only ever logs a bounded scheme/host summary -- never
 * the raw candidate (which may carry a sensitive query/fragment). */
export function openAllowedExternalUrl(
  candidate: string,
  openExternal: OpenExternal,
  log: ExternalUrlLog = defaultLog,
): void {
  const url = parseAllowedExternalUrl(candidate);
  if (!url) {
    log('rejected external URL launch: unsafe or malformed', {});
    return;
  }
  log('opening external URL', externalUrlLogSummary(url));
  void openExternal(url.toString());
}

/** `BrowserWindow.setWindowOpenHandler` callback body: always denies the child window, and opens
 * the target externally only if it passes the same validated gate. */
export function handleWindowOpen(
  url: string,
  openExternal: OpenExternal,
  log: ExternalUrlLog = defaultLog,
): { action: 'deny' } {
  openAllowedExternalUrl(url, openExternal, log);
  return { action: 'deny' };
}

/** `WebContents#will-navigate` callback body. Returns `true` when the caller must call
 * `event.preventDefault()` -- every case except navigation to the app's own allowed target. */
export function handleWillNavigate(
  url: string,
  isAllowedTarget: (url: string) => boolean,
  openExternal: OpenExternal,
  log: ExternalUrlLog = defaultLog,
): boolean {
  if (isAllowedTarget(url)) return false;
  openAllowedExternalUrl(url, openExternal, log);
  return true;
}

/**
 * Validates a provider-supplied OAuth authorization URL. Returns `undefined` when there is
 * nothing to launch, the validated `URL` and its bare host when there is; throws when the
 * provider handed back something unsafe, since (unlike window-open/navigation) that response is
 * itself part of the IPC result the renderer is waiting on and must fail the request outright
 * rather than silently doing nothing.
 */
export function resolveOAuthLaunch(
  authorizationUrl: string | undefined,
): { url: URL; host: string } | undefined {
  if (!authorizationUrl) return undefined;
  const url = parseAllowedExternalUrl(authorizationUrl);
  if (!url) throw new Error('provider returned an unsafe OAuth URL');
  return { url, host: url.hostname };
}
