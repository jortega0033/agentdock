import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent, AgentSession, ProviderId, ProviderStatus } from '@agent-dock/shared';

/**
 * The only surface the renderer has onto Node/Electron. Every function here is a narrow,
 * single-purpose capability — never a generic "invoke this IPC channel with this payload" tunnel
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

function isDaemonStatus(value: unknown): value is DaemonStatus {
  if (!value || typeof value !== 'object') return false;
  const state = (value as { state?: unknown }).state;
  return state === 'connecting' || state === 'ready' || state === 'unavailable';
}

const api: AgentDockBridge = {
  async getDaemonStatus() {
    const status: unknown = await ipcRenderer.invoke('daemon:get-status');
    return isDaemonStatus(status) ? status : { state: 'connecting' };
  },
  onDaemonStatus(callback) {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => {
      if (isDaemonStatus(status)) callback(status);
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
