import type {
  AgentCommandV2,
  AgentEvent,
  AgentEventV2Envelope,
  AgentSession,
  AgentSessionV2,
  CancelSessionV2Response,
  CommandAcknowledgementV2,
  CreateSessionV2Request,
  ProviderId,
  ProviderStatus,
} from '@agent-dock/shared';

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

declare global {
  interface Window {
    agentDock: AgentDockBridge;
  }
}

export {};
