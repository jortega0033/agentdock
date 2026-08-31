import { contextBridge, ipcRenderer } from 'electron';
import {
  agentCommandV2Schema,
  agentEventV2EnvelopeSchema,
  agentSessionV2Schema,
  cancelSessionV2ResponseSchema,
  commandAcknowledgementV2Schema,
  createSessionV2RequestSchema,
  sessionIdParamSchema,
  type AgentCommandV2,
  type AgentEvent,
  type AgentEventV2Envelope,
  type AgentSession,
  type AgentSessionV2,
  type CancelSessionV2Response,
  type CommandAcknowledgementV2,
  type CreateSessionV2Request,
  type ProviderId,
  type ProviderStatus,
} from '@agent-dock/shared';

/**
 * The only surface the renderer has onto Node/Electron. Every function here is a narrow,
 * single-purpose capability, never a generic "invoke this IPC channel with this payload" tunnel
 * and never the daemon's connection info (base URL + bearer token stay in the main process; see
 * electron/main.ts and SECURITY.md). The renderer cannot run a shell command, read/write an
 * arbitrary file, or reach any daemon route this bridge doesn't explicitly expose.
 */
export type DaemonStatus =
  { state: 'connecting' } | { state: 'ready' } | { state: 'unavailable'; error: string };

export type InteractiveSessionStreamNotice =
  | { type: 'replay_reset'; session: AgentSessionV2 }
  | { type: 'error'; message: string; status?: number };

export interface CreateSessionInput {
  provider: ProviderId;
  cwd: string;
  prompt: string;
}

export interface AgentDockBridge {
  getDaemonStatus(): Promise<DaemonStatus>;
  onDaemonStatus(callback: (status: DaemonStatus) => void): () => void;
  listProviders(): Promise<ProviderStatus[]>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  cancelSession(sessionId: string): Promise<void>;
  onSessionEvent(callback: (sessionId: string, event: AgentEvent) => void): () => void;
  createInteractiveSession(input: CreateSessionV2Request): Promise<AgentSessionV2>;
  sendSessionCommand(command: AgentCommandV2): Promise<CommandAcknowledgementV2>;
  cancelInteractiveSession(sessionId: string): Promise<CancelSessionV2Response>;
  onInteractiveSessionEvent(
    callback: (sessionId: string, event: AgentEventV2Envelope) => void,
  ): () => void;
  onInteractiveSessionStreamNotice(
    callback: (sessionId: string, notice: InteractiveSessionStreamNotice) => void,
  ): () => void;
  selectDirectory(): Promise<string | null>;
}

/**
 * Reconstructs a clean `DaemonStatus` from whatever main sent, rather than validating its shape
 * and then passing the original object through unchanged (AD-07). The difference matters: the
 * previous `isDaemonStatus` type guard only checked that `state` was one of the three known
 * values and then returned the raw object as-is, so an extra field on that object (a token, a
 * base URL, anything) would have crossed into the renderer completely untouched. Building a fresh
 * object with only the fields each variant is actually supposed to carry means an accidental
 * extra property on the main-process side can never reach here, structurally, regardless of what
 * main.ts's `daemon:get-status`/`daemon:status` handlers ever get changed to send.
 */
function toDaemonStatus(value: unknown): DaemonStatus {
  const state =
    value && typeof value === 'object' ? (value as { state?: unknown }).state : undefined;
  if (state === 'ready') return { state: 'ready' };
  if (state === 'unavailable') {
    const error = (value as { error?: unknown }).error;
    return { state: 'unavailable', error: typeof error === 'string' ? error : 'unknown error' };
  }
  return { state: 'connecting' };
}

function toInteractiveSessionStreamNotice(
  value: unknown,
  sessionId: string,
): InteractiveSessionStreamNotice | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const notice = value as {
    type?: unknown;
    session?: unknown;
    message?: unknown;
    status?: unknown;
  };
  if (notice.type === 'replay_reset') {
    const parsedSession = agentSessionV2Schema.safeParse(notice.session);
    if (!parsedSession.success || parsedSession.data.id !== sessionId) return undefined;
    return { type: 'replay_reset', session: parsedSession.data };
  }
  if (notice.type !== 'error' || typeof notice.message !== 'string') return undefined;
  const status =
    typeof notice.status === 'number' &&
    Number.isInteger(notice.status) &&
    notice.status >= 100 &&
    notice.status <= 599
      ? notice.status
      : undefined;
  return {
    type: 'error',
    message: notice.message.slice(0, 4 * 1024),
    ...(status === undefined ? {} : { status }),
  };
}

const api: AgentDockBridge = {
  async getDaemonStatus() {
    return toDaemonStatus(await ipcRenderer.invoke('daemon:get-status'));
  },
  onDaemonStatus(callback) {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => {
      callback(toDaemonStatus(status));
    };
    ipcRenderer.on('daemon:status', listener);
    return () => ipcRenderer.removeListener('daemon:status', listener);
  },
  listProviders() {
    return ipcRenderer.invoke('daemon:list-providers');
  },
  createSession(input) {
    return ipcRenderer.invoke('daemon:create-session', input);
  },
  cancelSession(sessionId) {
    return ipcRenderer.invoke('daemon:cancel-session', sessionId);
  },
  onSessionEvent(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const p = payload as { sessionId?: unknown; event?: unknown } | null;
      if (p && typeof p.sessionId === 'string' && p.event && typeof p.event === 'object') {
        callback(p.sessionId, p.event as AgentEvent);
      }
    };
    ipcRenderer.on('daemon:session-event', listener);
    return () => ipcRenderer.removeListener('daemon:session-event', listener);
  },
  async createInteractiveSession(input) {
    const parsedInput = createSessionV2RequestSchema.parse(input);
    return agentSessionV2Schema.parse(
      await ipcRenderer.invoke('daemon:create-interactive-session', parsedInput),
    );
  },
  async sendSessionCommand(command) {
    const parsedCommand = agentCommandV2Schema.parse(command);
    const acknowledgement = commandAcknowledgementV2Schema.parse(
      await ipcRenderer.invoke('daemon:send-session-command', parsedCommand),
    );
    if (
      acknowledgement.commandId !== parsedCommand.commandId ||
      acknowledgement.sessionId !== parsedCommand.sessionId ||
      acknowledgement.turnId !== parsedCommand.turnId
    ) {
      throw new Error('interactive command acknowledgement does not match the submitted command');
    }
    return acknowledgement;
  },
  async cancelInteractiveSession(sessionId) {
    const parsedSessionId = sessionIdParamSchema.parse({ sessionId }).sessionId;
    const acknowledgement = cancelSessionV2ResponseSchema.parse(
      await ipcRenderer.invoke('daemon:cancel-interactive-session', parsedSessionId),
    );
    if (acknowledgement.sessionId !== parsedSessionId) {
      throw new Error('interactive cancellation acknowledgement does not match the session');
    }
    return acknowledgement;
  },
  onInteractiveSessionEvent(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const value = payload as { sessionId?: unknown; event?: unknown } | null;
      if (!value || typeof value.sessionId !== 'string') return;
      const parsedEvent = agentEventV2EnvelopeSchema.safeParse(value.event);
      if (!parsedEvent.success || parsedEvent.data.sessionId !== value.sessionId) return;
      callback(value.sessionId, parsedEvent.data);
    };
    ipcRenderer.on('daemon:interactive-session-event', listener);
    return () => ipcRenderer.removeListener('daemon:interactive-session-event', listener);
  },
  onInteractiveSessionStreamNotice(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const value = payload as { sessionId?: unknown; notice?: unknown } | null;
      if (!value || typeof value.sessionId !== 'string') return;
      const notice = toInteractiveSessionStreamNotice(value.notice, value.sessionId);
      if (notice) callback(value.sessionId, notice);
    };
    ipcRenderer.on('daemon:interactive-session-stream-notice', listener);
    return () => ipcRenderer.removeListener('daemon:interactive-session-stream-notice', listener);
  },
  async selectDirectory() {
    const result: unknown = await ipcRenderer.invoke('dialog:select-directory');
    return typeof result === 'string' ? result : null;
  },
};

contextBridge.exposeInMainWorld('agentDock', api);
