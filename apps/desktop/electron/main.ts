import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSessionRequestSchema, sessionIdParamSchema } from '@agent-dock/shared';
import { AgentDockClient } from '@agent-dock/client';
import { resolveDaemonEntry } from './resolve-daemon-entry.js';
import { sendToRenderer } from './send-to-renderer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Two AgentDock windows would each spawn their own daemon sidecar and race over the same
// discovery file (the daemon's own single-instance guard, see SECURITY.md, would make the
// second one fail to start) — rather than let that surface as a confusing "daemon unavailable"
// error, refuse to open a second window at all and focus the existing one instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

/**
 * Renderer status only — never the token or base URL. The renderer talks to the daemon
 * exclusively through the IPC handlers below, which delegate to `@agent-dock/client`; the
 * `AgentDockClient` instance (which carries the bearer token) never crosses into the renderer
 * process. See SECURITY.md.
 */
type DaemonStatus = { state: 'connecting' } | { state: 'ready' } | { state: 'unavailable'; error: string };

let daemonChild: ChildProcess | undefined;
let client: AgentDockClient | undefined;
let mainWindow: BrowserWindow | undefined;
let activeSessionId: string | undefined;
let activeStreamAbort: AbortController | undefined;

// Namespaces the daemon rendezvous per application (AD-02) — see apps/daemon/src/discovery-file.ts
// for the daemon side of this. A fork shipping its own product under a different name should set
// this to its own id (env var, or hardcode a different literal here) so it doesn't collide with
// another AgentDock-based app's daemon on the same machine; the reference app just uses the
// default. The daemon validates/sanitizes this value itself and refuses to start on an invalid
// one, so it isn't duplicated here.
const APP_ID = process.env.AGENT_DOCK_APP_ID?.trim() || 'agent-dock';

function discoveryFilePath(): string {
  return join(tmpdir(), 'agent-dock', `${APP_ID}.json`);
}

function sendStatus(status: DaemonStatus): void {
  sendToRenderer(mainWindow, 'daemon:status', status);
}

function spawnDaemon(): void {
  const { cwd, args } = resolveDaemonEntry({
    mainDir: __dirname,
    isDevServer: !!process.env.VITE_DEV_SERVER_URL,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  const spawnedAt = Date.now();

  daemonChild = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENT_DOCK_APP_ID: APP_ID },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  daemonChild.stdout?.on('data', (chunk: Buffer) => {
    // The daemon's own logger already redacts secrets; forward for local debugging only.
    console.log(`[daemon] ${chunk.toString('utf8').trim()}`);
  });
  daemonChild.stderr?.on('data', (chunk: Buffer) => {
    console.error(`[daemon] ${chunk.toString('utf8').trim()}`);
  });
  daemonChild.on('exit', (code, signal) => {
    if (!client) return; // never became ready; startup error already reported
    client = undefined;
    sendStatus({ state: 'unavailable', error: `daemon process exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'null'})` });
  });

  waitForDaemonReady(spawnedAt).catch((err: Error) => {
    sendStatus({ state: 'unavailable', error: `daemon failed to start: ${err.message}` });
  });
}

async function waitForDaemonReady(spawnedAt: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const file = discoveryFilePath();

  while (Date.now() < deadline) {
    if (existsSync(file) && statSync(file).mtimeMs >= spawnedAt - 1000) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { port: number; token: string };
        const candidate = new AgentDockClient({ baseUrl: `http://127.0.0.1:${parsed.port}`, token: parsed.token });
        // health() also verifies protocol compatibility (see @agent-dock/client) — this doubles
        // as both the readiness check and the version-compatibility check in one call.
        await candidate.health();
        client = candidate;
        sendStatus({ state: 'ready' });
        return;
      } catch {
        // discovery file mid-write, daemon not reachable yet, or (in dev only, across a protocol
        // bump) a stale daemon still shutting down — keep polling rather than fail on one miss
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for daemon to become ready');
}

/** Streams one session's events to the renderer and clears `activeSessionId` at its terminal event. */
function forwardSessionEvents(sessionId: string): void {
  if (!client) return;
  const controller = new AbortController();
  activeStreamAbort = controller;
  const activeClient = client;

  void (async () => {
    try {
      for await (const event of activeClient.sessions.events(sessionId, { signal: controller.signal })) {
        sendToRenderer(mainWindow, 'daemon:session-event', { sessionId, event });
        if (event.type === 'session.completed' || event.type === 'session.failed' || event.type === 'session.cancelled') {
          if (activeSessionId === sessionId) activeSessionId = undefined;
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      sendToRenderer(mainWindow, 'daemon:session-event', {
        sessionId,
        event: { type: 'error', message: `event stream failed: ${(err as Error).message}`, recoverable: false },
      });
    }
  })();
}

async function killDaemon(): Promise<void> {
  activeStreamAbort?.abort();
  if (client) {
    try {
      // Cancels every in-flight session over HTTP, not just `activeSessionId` — on Windows,
      // daemonChild.kill() below maps to TerminateProcess, which never gives the daemon's own
      // SIGTERM handler (and its cancelAll()) a chance to run, so this HTTP call is the only
      // reliable way to stop every session's CLI process on that platform. Tracking a single
      // `activeSessionId` was previously the only thing cancelled here, which orphaned every
      // other session's process for any fork that runs more than one at a time (AD-12).
      await client.sessions.cancelAll();
    } catch {
      // best effort; the daemon's own shutdown handler is the fallback (SIGTERM on POSIX)
    }
  }
  daemonChild?.kill();
}

const packagedEntryUrl = pathToFileURL(join(__dirname, '..', 'dist', 'index.html')).href;

/**
 * Scopes `will-navigate` to exactly the app's own content instead of "any http(s) origin that
 * happens to start with the dev-server URL" or "any file:// path at all" — both of the previous
 * checks were prefix-based (`url.startsWith(...)`), which a URL like
 * `http://localhost:5173.evil.example` passes against an allowed `http://localhost:5173`. Real
 * origin comparison (dev) and exact-path comparison against the one file this app ever loads
 * (packaged) close that gap.
 */
function isAllowedNavigationTarget(url: string): boolean {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    try {
      return new URL(url).origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  return url === packagedEntryUrl;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.js'),
    },
  });

  // Defense in depth for forks of this boilerplate that later render untrusted content (e.g. a
  // link in a tool result): never let the window navigate away from our own app, and never let
  // it spawn an unrestricted child window. Legitimate external links go to the OS browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigationTarget(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  // Deny every permission request by default — nothing in this UI currently asks for camera,
  // microphone, geolocation, notifications, etc, so there's no legitimate request to allow.
  // Electron's own per-permission/per-platform defaults are inconsistent; this makes the policy
  // explicit and uniform instead of relying on them.
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (client) sendStatus({ state: 'ready' });
  });
}

ipcMain.handle('daemon:get-status', (): DaemonStatus => (client ? { state: 'ready' } : { state: 'connecting' }));

ipcMain.handle('daemon:list-providers', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.providers.list();
});

ipcMain.handle('daemon:create-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  // Validated here too, at the IPC boundary from the (untrusted) renderer — @agent-dock/client
  // validates again before it ever builds a request, but that's a different concern (protecting
  // the client's own contract), not a substitute for validating what crossed the privileged
  // boundary from the renderer in the first place.
  const parsed = createSessionRequestSchema.parse(input);
  const session = await client.sessions.create(parsed);
  activeSessionId = session.id;
  forwardSessionEvents(session.id);
  return session;
});

ipcMain.handle('daemon:cancel-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  await client.sessions.cancel(sessionId);
});

ipcMain.handle('dialog:select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    spawnDaemon();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  let shuttingDown = false;
  app.on('before-quit', (event) => {
    if (shuttingDown || !daemonChild) return;
    shuttingDown = true;
    event.preventDefault();
    void killDaemon().finally(() => app.quit());
  });
}
