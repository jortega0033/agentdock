import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  agentCommandV2Schema,
  createSessionRequestSchema,
  createSessionV2RequestSchema,
  sessionContinuationInputV2Schema,
  sessionEventHistoryV2QuerySchema,
  sessionIdParamSchema,
  sessionListV2QuerySchema,
  workspaceInspectRequestV2Schema,
  workspaceTrustUpdateRequestV2Schema,
  mcpCatalogRequestV2Schema,
  mcpConfigureRequestV2Schema,
  mcpListRequestV2Schema,
  mcpOAuthStartRequestV2Schema,
  mcpServerActionRequestV2Schema,
  mcpToolInvocationRequestV2Schema,
  providerComponentInvokeRequestV2Schema,
  providerComponentListRequestV2Schema,
  providerComponentManageRequestV2Schema,
  subagentControlRequestV2Schema,
  worktreeCleanupRequestV2Schema,
  worktreeCreateRequestV2Schema,
  worktreePreviewRequestV2Schema,
  structuredWorkflowRequestV2Schema,
  type AgentCommandV2,
  type AgentEventV2Envelope,
  type AgentSessionV2,
  type WorkspaceTrustUpdateRequestV2,
} from '@agent-dock/shared';
import { AgentDockClient, DaemonError } from '@agent-dock/client';
import { resolveDaemonEntry } from './resolve-daemon-entry.js';
import { resolveWindowIcon } from './resolve-window-icon.js';
import { sendToRenderer } from './send-to-renderer.js';
import {
  PendingInteractiveCreates,
  relayInteractiveSessionEvents,
} from './interactive-session-lifecycle.js';
import { InteractionBroker, type RendererInteractionResolution } from './interaction-broker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Two AgentDock windows would each spawn their own daemon sidecar and race over the same
// discovery file (the daemon's own single-instance guard, see SECURITY.md, would make the
// second one fail to start). Rather than let that surface as a confusing "daemon unavailable"
// error, refuse to open a second window at all and focus the existing one instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

/**
 * Renderer status only, never the token or base URL. The renderer talks to the daemon
 * exclusively through the IPC handlers below, which delegate to `@agent-dock/client`; the
 * `AgentDockClient` instance (which carries the bearer token) never crosses into the renderer
 * process. See SECURITY.md.
 */
type DaemonStatus =
  { state: 'connecting' } | { state: 'ready' } | { state: 'unavailable'; error: string };

let daemonChild: ChildProcess | undefined;
let client: AgentDockClient | undefined;
let mainWindow: BrowserWindow | undefined;
const activeSessionIds = new Set<string>();
const streamAborts = new Map<string, AbortController>();
const activeInteractiveSessionIds = new Set<string>();
const interactiveStreamAborts = new Map<string, AbortController>();
const pendingInteractiveCreates = new PendingInteractiveCreates();
const interactionBroker = new InteractionBroker();
// Startup may use the 30-second handshake bound plus graceful and hard-stop reap windows.
const INTERACTIVE_CREATE_SHUTDOWN_TIMEOUT_MS = 41_000;
const DAEMON_CANCELLATION_TIMEOUT_MS = 20_000;

// Namespaces the daemon rendezvous per application (AD-02); see apps/daemon/src/discovery-file.ts
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
    for (const controller of streamAborts.values()) controller.abort();
    streamAborts.clear();
    activeSessionIds.clear();
    for (const sessionId of activeInteractiveSessionIds) {
      clearInteractionSession(sessionId, 'stream_disconnected');
    }
    for (const controller of interactiveStreamAborts.values()) controller.abort();
    interactiveStreamAborts.clear();
    activeInteractiveSessionIds.clear();
    sendStatus({
      state: 'unavailable',
      error: `daemon process exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
    });
  });

  waitForDaemonReady(spawnedAt).catch((err: Error) => {
    sendStatus({ state: 'unavailable', error: `daemon failed to start: ${err.message}` });
  });
}

function sendInteractionResolutions(
  sessionId: string,
  resolutions: readonly RendererInteractionResolution[],
): void {
  for (const resolution of resolutions) {
    sendToRenderer(mainWindow, 'daemon:interaction-resolved', { sessionId, resolution });
  }
}

function clearInteractionSession(
  sessionId: string,
  reason: 'stream_disconnected' | 'shutdown',
): void {
  sendInteractionResolutions(sessionId, interactionBroker.clearSession(sessionId, reason));
}

function forwardInteractiveEvent(event: AgentEventV2Envelope): void {
  switch (event.type) {
    case 'approval.requested':
    case 'question.requested':
      sendToRenderer(mainWindow, 'daemon:interaction-requested', {
        sessionId: event.sessionId,
        interaction: interactionBroker.publish(event),
      });
      return;
    case 'approval.resolved':
    case 'question.resolved':
    case 'question.cancelled':
      sendInteractionResolutions(event.sessionId, interactionBroker.consumeResolution(event));
      return;
    case 'session.completed':
    case 'session.failed':
    case 'session.cancelled':
    case 'session.interrupted':
      sendInteractionResolutions(event.sessionId, interactionBroker.consumeResolution(event));
      activeInteractiveSessionIds.delete(event.sessionId);
      sendToRenderer(mainWindow, 'daemon:interactive-session-event', {
        sessionId: event.sessionId,
        event,
      });
      return;
    default:
      sendToRenderer(mainWindow, 'daemon:interactive-session-event', {
        sessionId: event.sessionId,
        event,
      });
  }
}

async function waitForDaemonReady(spawnedAt: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const file = discoveryFilePath();

  while (Date.now() < deadline) {
    if (existsSync(file) && statSync(file).mtimeMs >= spawnedAt - 1000) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { port: number; token: string };
        const candidate = new AgentDockClient({
          baseUrl: `http://127.0.0.1:${parsed.port}`,
          token: parsed.token,
        });
        // health() also verifies protocol compatibility (see @agent-dock/client); this doubles
        // as both the readiness check and the version-compatibility check in one call.
        await candidate.health();
        client = candidate;
        sendStatus({ state: 'ready' });
        return;
      } catch {
        // discovery file mid-write, daemon not reachable yet, or (in dev only, across a protocol
        // bump) a stale daemon still shutting down: keep polling rather than fail on one miss
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for daemon to become ready');
}

/** Streams one legacy session independently; protocol-v2 uses the reconnecting relay below. */
function forwardSessionEvents(sessionId: string): void {
  if (!client) return;
  streamAborts.get(sessionId)?.abort();
  const controller = new AbortController();
  streamAborts.set(sessionId, controller);
  const activeClient = client;

  void (async () => {
    try {
      for await (const event of activeClient.sessions.events(sessionId, {
        signal: controller.signal,
      })) {
        sendToRenderer(mainWindow, 'daemon:session-event', { sessionId, event });
        if (
          event.type === 'session.completed' ||
          event.type === 'session.failed' ||
          event.type === 'session.cancelled'
        ) {
          activeSessionIds.delete(sessionId);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      sendToRenderer(mainWindow, 'daemon:session-event', {
        sessionId,
        event: {
          type: 'error',
          message: `event stream failed: ${(err as Error).message}`,
          recoverable: false,
        },
      });
    } finally {
      if (streamAborts.get(sessionId) === controller) streamAborts.delete(sessionId);
    }
  })();
}

/** Streams validated protocol-v2 envelopes without changing the existing v1 renderer flow. */
function forwardInteractiveSessionEvents(sessionId: string): void {
  if (!client) return;
  const previousController = interactiveStreamAborts.get(sessionId);
  if (previousController) {
    previousController.abort();
    clearInteractionSession(sessionId, 'stream_disconnected');
  }
  const controller = new AbortController();
  interactiveStreamAborts.set(sessionId, controller);
  const activeClient = client;

  void relayInteractiveSessionEvents({
    sessionId,
    signal: controller.signal,
    events: (id, options) => activeClient.v2.sessions.events(id, { ...options, responder: true }),
    snapshot: (id) => activeClient.v2.sessions.get(id),
    isActive: () => activeInteractiveSessionIds.has(sessionId),
    onEvent: forwardInteractiveEvent,
    onRetry: (error, lastEventId) => {
      console.warn(
        `interactive event stream ${sessionId} reconnecting${lastEventId === undefined ? '' : ` after ${lastEventId}`}: ${(error as Error).message}`,
      );
    },
    onReplayGap: (session) => {
      clearInteractionSession(sessionId, 'stream_disconnected');
      sendToRenderer(mainWindow, 'daemon:interactive-session-stream-notice', {
        sessionId,
        notice: { type: 'replay_reset', session },
      });
    },
    onFatal: (error) => {
      sendToRenderer(mainWindow, 'daemon:interactive-session-stream-notice', {
        sessionId,
        notice: {
          type: 'error',
          message: boundedErrorMessage(error),
          ...(error instanceof DaemonError ? { status: error.status } : {}),
        },
      });
    },
  }).finally(() => {
    if (interactiveStreamAborts.get(sessionId) === controller) {
      interactiveStreamAborts.delete(sessionId);
      clearInteractionSession(sessionId, 'stream_disconnected');
    }
  });
}

function activateInteractiveSession(session: AgentSessionV2): void {
  if (isTerminalInteractiveStatus(session.status)) return;
  activeInteractiveSessionIds.add(session.id);
  if (!interactiveStreamAborts.has(session.id)) forwardInteractiveSessionEvents(session.id);
}

function createTrackedInteractiveSession(
  start: (signal: AbortSignal) => Promise<AgentSessionV2>,
): Promise<AgentSessionV2> {
  if (!client) return Promise.reject(new Error('daemon is not ready yet'));
  const activeClient = client;
  return pendingInteractiveCreates.run(start, activateInteractiveSession, async (session) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('late interactive session cancellation timed out')),
      DAEMON_CANCELLATION_TIMEOUT_MS,
    );
    try {
      await waitWithin(
        activeClient.v2.sessions.cancel(session.id, { signal: controller.signal }),
        DAEMON_CANCELLATION_TIMEOUT_MS,
      );
    } finally {
      clearTimeout(timer);
    }
  });
}

function isTerminalInteractiveStatus(status: AgentSessionV2['status']): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'interactive event stream failed';
  return message.slice(0, 4 * 1024);
}

async function waitWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = Promise.resolve(work).then(
    () => true,
    () => true,
  );
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([settled, timedOut]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function sendInteractionCommand(
  activeClient: AgentDockClient,
  command: AgentCommandV2,
): Promise<{ status: 'accepted' }> {
  try {
    const acknowledgement = await activeClient.v2.sessions.send(command);
    if (
      acknowledgement.commandId !== command.commandId ||
      acknowledgement.sessionId !== command.sessionId ||
      acknowledgement.turnId !== command.turnId
    ) {
      throw new Error('mismatched acknowledgement');
    }
    return { status: 'accepted' };
  } catch {
    throw new Error('interaction response failed');
  }
}

function parseWorkspaceTrustInput(input: unknown): {
  workspaceId: string;
  update: WorkspaceTrustUpdateRequestV2;
} {
  if (!isRecordWithExactKeys(input, ['workspaceId', 'update'])) {
    throw new Error('invalid workspace trust input');
  }
  if (typeof input.workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(input.workspaceId)) {
    throw new Error('invalid workspace id');
  }
  return {
    workspaceId: input.workspaceId,
    update: workspaceTrustUpdateRequestV2Schema.parse(input.update),
  };
}

function parseRendererSessionCommand(input: unknown): AgentCommandV2 {
  if (!input || typeof input !== 'object' || Array.isArray(input) || 'commandId' in input) {
    throw new Error('renderer session commands must not provide a command id');
  }
  const command = agentCommandV2Schema.parse({ ...input, commandId: randomUUID() });
  if (command.type === 'approval.respond' || command.type === 'question.respond') {
    throw new Error('interactive responses require an opaque interaction handle');
  }
  return command;
}

interface AuditReadInput {
  cursor?: string;
  limit?: number;
  sessionId?: string;
}

function parseAuditReadInput(input: unknown): AuditReadInput {
  if (!isRecordWithAllowedKeys(input, ['cursor', 'limit', 'sessionId'])) {
    throw new Error('invalid audit read input');
  }
  const cursor = input.cursor;
  const limit = input.limit;
  const sessionId = input.sessionId;
  if (
    cursor !== undefined &&
    (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(cursor))
  ) {
    throw new Error('invalid audit cursor');
  }
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100)
  ) {
    throw new Error('invalid audit limit');
  }
  const parsedSessionId =
    sessionId === undefined ? undefined : sessionIdParamSchema.parse({ sessionId }).sessionId;
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit: limit as number }),
    ...(parsedSessionId === undefined ? {} : { sessionId: parsedSessionId }),
  };
}

function isRecordWithExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}

function isRecordWithAllowedKeys(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

async function killDaemon(): Promise<void> {
  pendingInteractiveCreates.beginShutdown();
  for (const controller of streamAborts.values()) controller.abort();
  for (const sessionId of activeInteractiveSessionIds) {
    clearInteractionSession(sessionId, 'shutdown');
  }
  for (const controller of interactiveStreamAborts.values()) controller.abort();
  await pendingInteractiveCreates.waitForPending(INTERACTIVE_CREATE_SHUTDOWN_TIMEOUT_MS);
  const activeClient = client;
  if (activeClient) {
    const cancellationController = new AbortController();
    const cancellationTimer = setTimeout(
      () => cancellationController.abort(new Error('daemon cancellation deadline exceeded')),
      DAEMON_CANCELLATION_TIMEOUT_MS,
    );
    const cancellations = Promise.allSettled([
      // Cancels every in-flight session over HTTP. On Windows,
      // daemonChild.kill() below maps to TerminateProcess, so bounded HTTP cancellation is the
      // reliable opportunity for the daemon to reap each provider tree before the hard stop.
      activeClient.sessions.cancelAll({ signal: cancellationController.signal }),
      ...[...activeInteractiveSessionIds].map((sessionId) =>
        activeClient.v2.sessions.cancel(sessionId, {
          signal: cancellationController.signal,
        }),
      ),
    ]);
    await waitWithin(cancellations, DAEMON_CANCELLATION_TIMEOUT_MS);
    clearTimeout(cancellationTimer);
    cancellationController.abort(new Error('desktop shutdown completed'));
  }
  activeSessionIds.clear();
  streamAborts.clear();
  activeInteractiveSessionIds.clear();
  interactiveStreamAborts.clear();
  daemonChild?.kill();
}

const packagedEntryUrl = pathToFileURL(join(__dirname, '..', 'dist', 'index.html')).href;

/**
 * Scopes `will-navigate` to exactly the app's own content instead of "any http(s) origin that
 * happens to start with the dev-server URL" or "any file:// path at all". Both of the previous
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
    icon: resolveWindowIcon({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
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

  // Deny every permission request by default: nothing in this UI currently asks for camera,
  // microphone, geolocation, notifications, etc, so there's no legitimate request to allow.
  // Electron's own per-permission/per-platform defaults are inconsistent; this makes the policy
  // explicit and uniform instead of relying on them.
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (client) sendStatus({ state: 'ready' });
  });
}

ipcMain.handle('daemon:get-status', (): DaemonStatus =>
  client ? { state: 'ready' } : { state: 'connecting' },
);

ipcMain.handle('daemon:list-providers', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.providers.list();
});

ipcMain.handle('daemon:list-providers-v2', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.providers.list();
});

ipcMain.handle('daemon:list-mcp-servers', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const parsed = mcpListRequestV2Schema.parse(input);
  return client.v2.integrations.mcp.list(parsed.provider, parsed.cwd);
});

ipcMain.handle('daemon:configure-mcp-server', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.integrations.mcp.configure(mcpConfigureRequestV2Schema.parse(input));
});

ipcMain.handle('daemon:action-mcp-server', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.integrations.mcp.action(mcpServerActionRequestV2Schema.parse(input));
});

ipcMain.handle('daemon:get-mcp-catalog', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const parsed = mcpCatalogRequestV2Schema.parse(input);
  return client.v2.integrations.mcp.catalog(parsed.provider, parsed.serverId, parsed.cwd);
});

ipcMain.handle('daemon:start-mcp-oauth', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const parsed = mcpOAuthStartRequestV2Schema.parse(input);
  const result = await client.v2.integrations.mcp.oauth(parsed.provider, parsed.serverId, parsed.cwd);
  let authorizationHost: string | undefined;
  if (result.authorizationUrl) {
    const url = new URL(result.authorizationUrl);
    if (url.protocol !== 'https:') throw new Error('provider returned an unsafe OAuth URL');
    authorizationHost = url.host;
    await shell.openExternal(url.toString());
  }
  return {
    serverId: result.serverId,
    status: result.status,
    ...(authorizationHost ? { authorizationHost } : {}),
    ...(result.safeSummary ? { safeSummary: result.safeSummary } : {}),
  };
});

ipcMain.handle('daemon:invoke-mcp-tool', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.integrations.mcp.invoke(mcpToolInvocationRequestV2Schema.parse(input));
});

ipcMain.handle('daemon:list-provider-components', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.integrations.components.list(providerComponentListRequestV2Schema.parse(input));
});

ipcMain.handle('daemon:manage-provider-component', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.integrations.components.manage(providerComponentManageRequestV2Schema.parse(input));
});

ipcMain.handle('daemon:invoke-provider-component', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.integrations.components.invoke(providerComponentInvokeRequestV2Schema.parse(input));
});

ipcMain.handle('daemon:get-subagent-graph', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  return client.v2.agents.graph(sessionId);
});
ipcMain.handle('daemon:control-subagent', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.agents.control(subagentControlRequestV2Schema.parse(input));
});
ipcMain.handle('daemon:preview-worktree', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.worktrees.preview(worktreePreviewRequestV2Schema.parse(input));
});
ipcMain.handle('daemon:create-worktree', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.worktrees.create(worktreeCreateRequestV2Schema.parse(input));
});
ipcMain.handle('daemon:list-worktrees', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.worktrees.list();
});
ipcMain.handle('daemon:cleanup-worktree', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const parsed = worktreeCleanupRequestV2Schema.parse({ worktreeId: input });
  return client.v2.worktrees.cleanup(parsed.worktreeId);
});

ipcMain.handle('dialog:select-and-upload-attachments', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  if (!isRecordWithAllowedKeys(input, ['sessionId'])) throw new Error('invalid attachment picker input');
  const sessionId = input.sessionId === undefined ? undefined : sessionIdParamSchema.parse({ sessionId: input.sessionId }).sessionId;
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
  if (result.canceled) return [];
  if (result.filePaths.length > 20) throw new Error('select at most 20 files');
  const uploaded = [];
  for (const path of result.filePaths) {
    const metadata = statSync(path);
    if (!metadata.isFile()) throw new Error('attachment selection must contain files only');
    uploaded.push(await client.v2.attachments.upload({ fileName: basename(path), size: metadata.size, stream: createReadStream(path), ...(sessionId ? { sessionId } : {}) }));
  }
  return uploaded;
});

ipcMain.handle('daemon:validate-structured-output', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.structured.validate(structuredWorkflowRequestV2Schema.parse(input));
});

ipcMain.handle('daemon:create-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  // Validated here too, at the IPC boundary from the (untrusted) renderer. @agent-dock/client
  // validates again before it ever builds a request, but that's a different concern (protecting
  // the client's own contract), not a substitute for validating what crossed the privileged
  // boundary from the renderer in the first place.
  const parsed = createSessionRequestSchema.parse(input);
  const session = await client.sessions.create(parsed);
  activeSessionIds.add(session.id);
  forwardSessionEvents(session.id);
  return session;
});

ipcMain.handle('daemon:cancel-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  await client.sessions.cancel(sessionId);
});

ipcMain.handle('daemon:create-interactive-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const parsed = createSessionV2RequestSchema.parse(input);
  const activeClient = client;
  return createTrackedInteractiveSession((signal) =>
    activeClient.v2.sessions.create(parsed, { signal }),
  );
});

ipcMain.handle('daemon:list-interactive-sessions', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.sessions.list(sessionListV2QuerySchema.parse(input));
});

ipcMain.handle('daemon:read-interactive-session-history', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  if (!isRecordWithExactKeys(input, ['sessionId', 'query'])) {
    throw new Error('invalid interactive session history input');
  }
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input.sessionId });
  const query = sessionEventHistoryV2QuerySchema.parse(input.query);
  return client.v2.sessions.history(sessionId, query);
});

ipcMain.handle('daemon:reconnect-interactive-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  const session = await client.v2.sessions.get(sessionId);
  activateInteractiveSession(session);
  return session;
});

for (const kind of ['resume', 'fork'] as const) {
  ipcMain.handle(`daemon:${kind}-interactive-session`, async (_event, input: unknown) => {
    if (!client) throw new Error('daemon is not ready yet');
    if (!isRecordWithExactKeys(input, ['sessionId', 'input'])) {
      throw new Error(`invalid interactive session ${kind} input`);
    }
    const { sessionId } = sessionIdParamSchema.parse({ sessionId: input.sessionId });
    const continuation = sessionContinuationInputV2Schema.parse(input.input);
    const activeClient = client;
    return createTrackedInteractiveSession((signal) =>
      activeClient.v2.sessions[kind](sessionId, continuation, { signal }),
    );
  });
}

ipcMain.handle('daemon:delete-interactive-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  await client.v2.sessions.delete(sessionId);
  activeInteractiveSessionIds.delete(sessionId);
  interactiveStreamAborts.get(sessionId)?.abort();
  interactiveStreamAborts.delete(sessionId);
  clearInteractionSession(sessionId, 'stream_disconnected');
});

ipcMain.handle('daemon:send-session-command', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.sessions.send(parseRendererSessionCommand(input));
});

ipcMain.handle('daemon:respond-approval', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return sendInteractionCommand(client, interactionBroker.resolveApproval(input));
});

ipcMain.handle('daemon:answer-questions', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return sendInteractionCommand(client, interactionBroker.resolveQuestions(input));
});

ipcMain.handle('daemon:cancel-interactive-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  return client.v2.sessions.cancel(sessionId);
});

ipcMain.handle('daemon:inspect-workspace', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { cwd } = workspaceInspectRequestV2Schema.parse(input);
  return client.v2.workspaces.inspect(cwd);
});

ipcMain.handle('daemon:set-workspace-trust', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { workspaceId, update } = parseWorkspaceTrustInput(input);
  return client.v2.workspaces.setTrust(workspaceId, update);
});

ipcMain.handle('daemon:read-audit', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.v2.audit.list(parseAuditReadInput(input));
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

  app.on('before-quit', (event) => {
    if (pendingInteractiveCreates.isClosing || !daemonChild) return;
    pendingInteractiveCreates.beginShutdown();
    event.preventDefault();
    void killDaemon().finally(() => app.quit());
  });
}
