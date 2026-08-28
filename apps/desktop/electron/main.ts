import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionRequestSchema, sessionIdParamSchema } from '@agent-dock/shared';
import { AgentDockClient } from '@agent-dock/client';
import { resolveDaemonEntry } from './resolve-daemon-entry.js';
import { sendToRenderer } from './send-to-renderer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Two AgentDock windows would each spawn their own daemon sidecar and race over the same
// discovery file (the daemon's own single-instance guard, see docs/security.md, would make the
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
 * process. See docs/security.md.
 */
type DaemonStatus = { state: 'connecting' } | { state: 'ready' } | { state: 'unavailable'; error: string };

let daemonChild: ChildProcess | undefined;
let client: AgentDockClient | undefined;
let mainWindow: BrowserWindow | undefined;
let activeSessionId: string | undefined;
let activeStreamAbort: AbortController | undefined;

function discoveryFilePath(): string {
  return join(tmpdir(), 'agent-dock', 'daemon.json');
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
    // No AGENT_DOCK_ALLOWED_ORIGINS is set here on purpose: the renderer never calls the daemon
    // directly (it goes through this process's AgentDockClient instance instead), so the daemon
    // needs no browser origin allowlisted at all, in dev or in production — closing off the
    // CORS-preflight surface entirely rather than trying to enumerate which origins to trust.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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
  if (activeSessionId && client) {
    try {
      await client.sessions.cancel(activeSessionId);
    } catch {
      // best effort; the daemon's own shutdown handler is the fallback (SIGTERM on POSIX)
    }
  }
  daemonChild?.kill();
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
    const allowed = process.env.VITE_DEV_SERVER_URL;
    if (allowed && url.startsWith(allowed)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    void shell.openExternal(url);
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
