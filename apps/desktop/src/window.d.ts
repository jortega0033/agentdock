import type {
  AgentCommandV2,
  AgentEvent,
  AgentEventV2Envelope,
  AgentSession,
  AgentSessionV2,
  ApprovalDecisionV2,
  AuditReadResponseV2,
  CancelSessionV2Response,
  CommandAcknowledgementV2,
  CreateSessionV2Request,
  ProviderId,
  ProviderStatus,
  ProviderStatusV2,
  SessionContinuationInputV2,
  SessionEventHistoryV2Page,
  SessionEventHistoryV2Query,
  SessionListV2Page,
  SessionListV2Query,
  WorkspaceTrustUpdateRequestV2,
  WorkspaceTrustViewV2,
  McpCatalogV2,
  McpConfigureRequestV2,
  McpServerActionRequestV2,
  McpServerListV2,
  McpToolInvocationRequestV2,
  McpToolInvocationResultV2,
} from '@agent-dock/shared';
import type {
  RendererInteraction,
  RendererInteractionResolution,
  RendererQuestionResponse,
} from '../electron/interaction-broker.js';

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

export interface InteractionResponseAcknowledgement {
  status: 'accepted';
}

export interface AuditReadOptionsV2 {
  cursor?: string;
  limit?: number;
  sessionId?: string;
}

export interface RendererMcpOAuthStatus {
  serverId: string;
  status: 'pending' | 'authenticated' | 'failed' | 'unsupported';
  authorizationHost?: string;
  safeSummary?: string;
}

type WithoutCommandId<T> = T extends unknown ? Omit<T, 'commandId'> : never;
export type RendererSessionCommand = WithoutCommandId<
  Exclude<AgentCommandV2, { type: 'approval.respond' | 'question.respond' }>
>;

export interface AgentDockBridge {
  getDaemonStatus(): Promise<DaemonStatus>;
  onDaemonStatus(callback: (status: DaemonStatus) => void): () => void;
  listProviders(): Promise<ProviderStatus[]>;
  listProvidersV2(): Promise<ProviderStatusV2[]>;
  listMcpServers(provider: ProviderId, cwd: string): Promise<McpServerListV2>;
  configureMcpServer(input: McpConfigureRequestV2): Promise<McpServerListV2>;
  actionMcpServer(input: McpServerActionRequestV2): Promise<McpServerListV2>;
  getMcpCatalog(provider: ProviderId, serverId: string, cwd: string): Promise<McpCatalogV2>;
  startMcpOAuth(provider: ProviderId, serverId: string, cwd: string): Promise<RendererMcpOAuthStatus>;
  invokeMcpTool(input: McpToolInvocationRequestV2): Promise<McpToolInvocationResultV2>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  cancelSession(sessionId: string): Promise<void>;
  onSessionEvent(callback: (sessionId: string, event: AgentEvent) => void): () => void;
  createInteractiveSession(input: CreateSessionV2Request): Promise<AgentSessionV2>;
  listInteractiveSessions(options?: SessionListV2Query): Promise<SessionListV2Page>;
  readInteractiveSessionHistory(
    sessionId: string,
    options?: SessionEventHistoryV2Query,
  ): Promise<SessionEventHistoryV2Page>;
  reconnectInteractiveSession(sessionId: string): Promise<AgentSessionV2>;
  resumeInteractiveSession(
    sessionId: string,
    input: SessionContinuationInputV2,
  ): Promise<AgentSessionV2>;
  forkInteractiveSession(
    sessionId: string,
    input: SessionContinuationInputV2,
  ): Promise<AgentSessionV2>;
  deleteInteractiveSession(sessionId: string): Promise<void>;
  sendSessionCommand(command: RendererSessionCommand): Promise<CommandAcknowledgementV2>;
  respondApproval(
    interactionHandle: string,
    decision: ApprovalDecisionV2,
  ): Promise<InteractionResponseAcknowledgement>;
  answerQuestions(
    interactionHandle: string,
    answers: RendererQuestionResponse['answers'],
  ): Promise<InteractionResponseAcknowledgement>;
  cancelInteractiveSession(sessionId: string): Promise<CancelSessionV2Response>;
  onInteractiveSessionEvent(
    callback: (sessionId: string, event: AgentEventV2Envelope) => void,
  ): () => void;
  onInteractiveSessionStreamNotice(
    callback: (sessionId: string, notice: InteractiveSessionStreamNotice) => void,
  ): () => void;
  onInteractionRequested(
    callback: (sessionId: string, interaction: RendererInteraction) => void,
  ): () => void;
  onInteractionResolved(
    callback: (sessionId: string, resolution: RendererInteractionResolution) => void,
  ): () => void;
  inspectWorkspace(cwd: string): Promise<WorkspaceTrustViewV2>;
  setWorkspaceTrust(
    workspaceId: string,
    input: WorkspaceTrustUpdateRequestV2,
  ): Promise<WorkspaceTrustViewV2>;
  readAudit(options?: AuditReadOptionsV2): Promise<AuditReadResponseV2>;
  selectDirectory(): Promise<string | null>;
}

declare global {
  interface Window {
    agentDock: AgentDockBridge;
  }
}

export {};
