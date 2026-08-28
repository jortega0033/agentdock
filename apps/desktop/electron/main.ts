import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionRequestSchema, sessionIdParamSchema, type AgentEvent } from '@agent-dock/shared';
import {
  cancelSession,
  createSession,
  listProviders,
  streamSessionEvents,
  type DaemonConnection,
} from './daemon-client.js';
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
 * exclusively through the IPC handlers below; `DaemonConnection` (which carries the bearer
 * token) never crosses into the renderer process. See docs/security.md.
 */
type DaemonStatus = { state: 'connecting' } | { state: 'ready' } | { state: 'unavailable'; error: string };

let daemonChild: ChildProcess | undefined;
let daemonConn: DaemonConnection | undefined;
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
    // directly (see daemon-client.ts), so the daemon needs no browser origin allowlisted at all,
    // in dev or in production — closing off the CORS-preflight surface entirely rather than
    // trying to enumerate which origins should be trusted.
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
    if (!daemonConn) return; // never became ready; startup error already reported
    daemonConn = undefined;
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
        const baseUrl = `http://127.0.0.1:${parsed.port}`;
        const health = await fetch(`${baseUrl}/health`).catch(() => undefined);
        if (health?.ok) {
          daemonConn = { baseUrl, token: parsed.token };
          sendStatus({ state: 'ready' });
          return;
        }
      } catch {
        // discovery file mid-write or daemon not reachable yet; keep polling
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for daemon to become ready');
}

/** Streams one session's events to the renderer and clears `activeSessionId` at its terminal event. */
function forwardSessionEvents(sessionId: string): void {
  if (!daemonConn) return;
  const controller = new AbortController();
  activeStreamAbort = controller;

  const onEvent = (event: AgentEvent) => {
    sendToRenderer(mainWindow, 'daemon:session-event', { sessionId, event });
    if (event.type === 'session.completed' || event.type === 'session.failed' || event.type === 'session.cancelled') {
      if (activeSessionId === sessionId) activeSessionId = undefined;
    }
  };

  streamSessionEvents(daemonConn, sessionId, onEvent, controller.signal).catch((err: Error) => {
    if (controller.signal.aborted) return;
    sendToRenderer(mainWindow, 'daemon:session-event', {
      sessionId,
      event: { type: 'error', message: `event stream failed: ${err.message}`, recoverable: false },
    });
  });
}

async function killDaemon(): Promise<void> {
  activeStreamAbort?.abort();
  if (activeSessionId && daemonConn) {
    try {
      await cancelSession(daemonConn, activeSessionId);
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
    if (daemonConn) sendStatus({ state: 'ready' });
  });
}

ipcMain.handle('daemon:get-status', (): DaemonStatus => (daemonConn ? { state: 'ready' } : { state: 'connecting' }));

ipcMain.handle('daemon:list-providers', async () => {
  if (!daemonConn) throw new Error('daemon is not ready yet');
  return listProviders(daemonConn);
});

ipcMain.handle('daemon:create-session', async (_event, input: unknown) => {
  if (!daemonConn) throw new Error('daemon is not ready yet');
  const parsed = createSessionRequestSchema.parse(input);
  const session = await createSession(daemonConn, parsed);
  activeSessionId = session.id;
  forwardSessionEvents(session.id);
  return session;
});

ipcMain.handle('daemon:cancel-session', async (_event, input: unknown) => {
  if (!daemonConn) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  await cancelSession(daemonConn, sessionId);
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
