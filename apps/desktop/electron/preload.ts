import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent, AgentSession, ProviderId, ProviderStatus } from '@agent-dock/shared';

/**
 * The only surface the renderer has onto Node/Electron. Every function here is a narrow,
 * single-purpose capability, never a generic "invoke this IPC channel with this payload" tunnel
 * and never the daemon's connection info (base URL + bearer token stay in the main process; see
 * electron/main.ts and SECURITY.md). The renderer cannot run a shell command, read/write an
 * arbitrary file, or reach any daemon route this bridge doesn't explicitly expose.
 */
export type DaemonStatus = { state: 'connecting' } | { state: 'ready' } | { state: 'unavailable'; error: string };

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
  const state = value && typeof value === 'object' ? (value as { state?: unknown }).state : undefined;
  if (state === 'ready') return { state: 'ready' };
  if (state === 'unavailable') {
    const error = (value as { error?: unknown }).error;
    return { state: 'unavailable', error: typeof error === 'string' ? error : 'unknown error' };
  }
  return { state: 'connecting' };
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
  async selectDirectory() {
    const result: unknown = await ipcRenderer.invoke('dialog:select-directory');
    return typeof result === 'string' ? result : null;
  },
};

contextBridge.exposeInMainWorld('agentDock', api);
