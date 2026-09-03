import { contextBridge, ipcRenderer } from 'electron';
import {
  EFFECTS,
  agentCommandV2Schema,
  agentEventV2EnvelopeSchema,
  agentSessionV2Schema,
  approvalDecisionV2Schema,
  auditReadResponseV2Schema,
  cancelSessionV2ResponseSchema,
  commandAcknowledgementV2Schema,
  createSessionV2RequestSchema,
  providersV2ResponseSchema,
  sessionContinuationInputV2Schema,
  sessionEventHistoryV2PageSchema,
  sessionEventHistoryV2QuerySchema,
  sessionIdParamSchema,
  sessionListV2PageSchema,
  sessionListV2QuerySchema,
  utf8ByteLength,
  workspaceInspectRequestV2Schema,
  workspaceTrustUpdateRequestV2Schema,
  workspaceTrustViewV2Schema,
  mcpCatalogRequestV2Schema,
  mcpCatalogV2Schema,
  mcpConfigureRequestV2Schema,
  mcpListRequestV2Schema,
  mcpOAuthStartRequestV2Schema,
  mcpServerActionRequestV2Schema,
  mcpServerListV2Schema,
  mcpToolInvocationRequestV2Schema,
  mcpToolInvocationResultV2Schema,
  providerComponentInvokeRequestV2Schema,
  providerComponentListRequestV2Schema,
  providerComponentListV2Schema,
  providerComponentManageRequestV2Schema,
  providerComponentOperationResultV2Schema,
  ownedWorktreeListV2Schema,
  ownedWorktreeV2Schema,
  subagentControlRequestV2Schema,
  subagentControlResultV2Schema,
  subagentGraphV2Schema,
  worktreeCleanupRequestV2Schema,
  worktreeCreateRequestV2Schema,
  worktreePreviewRequestV2Schema,
  worktreePreviewV2Schema,
  attachmentListV2Schema,
  structuredWorkflowRequestV2Schema,
  structuredWorkflowResultV2Schema,
  providerIdSchema,
  type AgentCommandV2,
  type AgentEvent,
  type AgentEventV2Envelope,
  type AgentSession,
  type AgentSessionV2,
  type ApprovalDecisionV2,
  type AuditReadResponseV2,
  type CancelSessionV2Response,
  type CommandAcknowledgementV2,
  type CreateSessionV2Request,
  type Effect,
  type ProviderId,
  type ProviderStatus,
  type ProviderStatusV2,
  type SessionContinuationInputV2,
  type SessionEventHistoryV2Page,
  type SessionEventHistoryV2Query,
  type SessionListV2Page,
  type SessionListV2Query,
  type WorkspaceTrustUpdateRequestV2,
  type WorkspaceTrustViewV2,
  type McpCatalogV2,
  type McpConfigureRequestV2,
  type McpServerActionRequestV2,
  type McpServerListV2,
  type McpToolInvocationRequestV2,
  type McpToolInvocationResultV2,
  type ProviderComponentInvokeRequestV2,
  type ProviderComponentListRequestV2,
  type ProviderComponentListV2,
  type ProviderComponentManageRequestV2,
  type ProviderComponentOperationResultV2,
  type OwnedWorktreeV2,
  type SubagentControlRequestV2,
  type SubagentGraphV2,
  type WorktreeCreateRequestV2,
  type WorktreePreviewRequestV2,
  type WorktreePreviewV2,
  type AttachmentMetadataV2,
  type StructuredWorkflowRequestV2,
  type StructuredWorkflowResultV2,
} from '@agent-dock/shared';
import type {
  RendererInteraction,
  RendererInteractionResolution,
  RendererQuestion,
  RendererQuestionAnswer,
  RendererQuestionOption,
  RendererQuestionResponse,
} from './interaction-broker.js';

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
  openProviderInstallDocs(provider: ProviderId): Promise<void>;
  listMcpServers(provider: ProviderId, cwd: string): Promise<McpServerListV2>;
  configureMcpServer(input: McpConfigureRequestV2): Promise<McpServerListV2>;
  actionMcpServer(input: McpServerActionRequestV2): Promise<McpServerListV2>;
  getMcpCatalog(provider: ProviderId, serverId: string, cwd: string): Promise<McpCatalogV2>;
  startMcpOAuth(provider: ProviderId, serverId: string, cwd: string): Promise<RendererMcpOAuthStatus>;
  invokeMcpTool(input: McpToolInvocationRequestV2): Promise<McpToolInvocationResultV2>;
  listProviderComponents(input: ProviderComponentListRequestV2): Promise<ProviderComponentListV2>;
  manageProviderComponent(input: ProviderComponentManageRequestV2): Promise<ProviderComponentOperationResultV2>;
  invokeProviderComponent(input: ProviderComponentInvokeRequestV2): Promise<ProviderComponentOperationResultV2>;
  getSubagentGraph(sessionId: string): Promise<SubagentGraphV2>;
  controlSubagent(input: SubagentControlRequestV2): Promise<{ sessionId: string; agentId: string; status: 'accepted' | 'unsupported' | 'not_found'; safeSummary?: string }>;
  previewWorktree(input: WorktreePreviewRequestV2): Promise<WorktreePreviewV2>;
  createWorktree(input: WorktreeCreateRequestV2): Promise<OwnedWorktreeV2>;
  listWorktrees(): Promise<OwnedWorktreeV2[]>;
  cleanupWorktree(worktreeId: string): Promise<OwnedWorktreeV2>;
  selectAndUploadAttachments(sessionId?: string): Promise<AttachmentMetadataV2[]>;
  validateStructuredOutput(input: StructuredWorkflowRequestV2): Promise<StructuredWorkflowResultV2>;
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

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INTERACTION_EVENT_TYPES = new Set([
  'approval.requested',
  'approval.resolved',
  'question.requested',
  'question.resolved',
  'question.cancelled',
]);
const EFFECT_SET = new Set<string>(EFFECTS);
const QUESTION_CANCEL_REASONS = new Set([
  'timeout',
  'disconnect',
  'overflow',
  'interrupt',
  'cancel',
  'shutdown',
  'trust_revoked',
  'provider_cancelled',
]);

function toRendererInteraction(value: unknown): RendererInteraction | undefined {
  if (!isRecord(value) || !isHandle(value.interactionHandle) || !isTimestamp(value.deadlineAt)) {
    return undefined;
  }
  if (value.kind === 'approval') return toRendererApprovalInteraction(value);
  if (value.kind !== 'question' || !Array.isArray(value.questions)) return undefined;
  if (value.questions.length < 1 || value.questions.length > 3) return undefined;

  const issuedHandles = new Set<string>([value.interactionHandle]);
  const questions: RendererQuestion[] = [];
  for (const rawQuestion of value.questions) {
    if (
      !isRecord(rawQuestion) ||
      !isHandle(rawQuestion.questionHandle) ||
      issuedHandles.has(rawQuestion.questionHandle) ||
      !isCharacterBoundedString(rawQuestion.title, 512) ||
      !isByteBoundedString(rawQuestion.prompt, 4 * 1024) ||
      typeof rawQuestion.allowsFreeText !== 'boolean' ||
      (rawQuestion.preview !== undefined && !isByteBoundedString(rawQuestion.preview, 8 * 1024))
    ) {
      return undefined;
    }
    issuedHandles.add(rawQuestion.questionHandle);

    let options: RendererQuestionOption[] | undefined;
    if (rawQuestion.options !== undefined) {
      if (!Array.isArray(rawQuestion.options) || rawQuestion.options.length > 10) return undefined;
      options = [];
      for (const rawOption of rawQuestion.options) {
        if (
          !isRecord(rawOption) ||
          !isHandle(rawOption.optionHandle) ||
          issuedHandles.has(rawOption.optionHandle) ||
          !isCharacterBoundedString(rawOption.label, 512) ||
          (rawOption.description !== undefined &&
            !isByteBoundedString(rawOption.description, 2 * 1024))
        ) {
          return undefined;
        }
        issuedHandles.add(rawOption.optionHandle);
        options.push({
          optionHandle: rawOption.optionHandle,
          label: rawOption.label,
          ...(rawOption.description === undefined
            ? {}
            : { description: rawOption.description as string }),
        });
      }
    }
    if (!rawQuestion.allowsFreeText && (!options || options.length === 0)) return undefined;
    questions.push({
      questionHandle: rawQuestion.questionHandle,
      title: rawQuestion.title,
      prompt: rawQuestion.prompt,
      ...(options === undefined ? {} : { options }),
      allowsFreeText: rawQuestion.allowsFreeText,
      ...(rawQuestion.preview === undefined ? {} : { preview: rawQuestion.preview as string }),
    });
  }
  const interaction: RendererInteraction = {
    kind: 'question',
    interactionHandle: value.interactionHandle,
    questions,
    deadlineAt: value.deadlineAt,
  };
  return utf8ByteLength(JSON.stringify(interaction)) <= 32 * 1024 ? interaction : undefined;
}

function toRendererApprovalInteraction(
  value: Record<string, unknown>,
): Extract<RendererInteraction, { kind: 'approval' }> | undefined {
  const possibleEffects = toEffects(value.possibleEffects);
  if (
    !isCharacterBoundedString(value.title, 512) ||
    !isByteBoundedString(value.action, 4 * 1024) ||
    !isByteBoundedString(value.target, 4 * 1024) ||
    (value.reason !== undefined && !isByteBoundedString(value.reason, 4 * 1024)) ||
    possibleEffects === undefined ||
    typeof value.effectsComplete !== 'boolean' ||
    !Array.isArray(value.allowedDecisions) ||
    value.allowedDecisions.length < 1 ||
    value.allowedDecisions.length > 3
  ) {
    return undefined;
  }
  const allowedDecisions: ApprovalDecisionV2[] = [];
  for (const rawDecision of value.allowedDecisions) {
    const decision = approvalDecisionV2Schema.safeParse(rawDecision);
    if (!decision.success || allowedDecisions.includes(decision.data)) return undefined;
    allowedDecisions.push(decision.data);
  }
  const interaction: Extract<RendererInteraction, { kind: 'approval' }> = {
    kind: 'approval',
    interactionHandle: value.interactionHandle as string,
    title: value.title,
    action: value.action,
    target: value.target,
    ...(value.reason === undefined ? {} : { reason: value.reason as string }),
    possibleEffects,
    effectsComplete: value.effectsComplete,
    allowedDecisions,
    deadlineAt: value.deadlineAt as string,
  };
  return utf8ByteLength(JSON.stringify(interaction)) <= 32 * 1024 ? interaction : undefined;
}

function toInteractionResolution(value: unknown): RendererInteractionResolution | undefined {
  if (!isRecord(value) || !isHandle(value.interactionHandle)) {
    return undefined;
  }
  switch (value.kind) {
    case 'approval_resolved':
      if (value.reason !== 'allowed' && value.reason !== 'denied') return undefined;
      return {
        interactionHandle: value.interactionHandle,
        kind: 'approval_resolved',
        reason: value.reason,
      };
    case 'question_resolved':
      return { interactionHandle: value.interactionHandle, kind: 'question_resolved' };
    case 'question_cancelled':
      if (typeof value.reason !== 'string' || !QUESTION_CANCEL_REASONS.has(value.reason)) {
        return undefined;
      }
      return {
        interactionHandle: value.interactionHandle,
        kind: 'question_cancelled',
        reason: value.reason as Extract<
          RendererInteractionResolution,
          { kind: 'question_cancelled' }
        >['reason'],
      };
    case 'session_terminal':
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(value.reason as string)) {
        return undefined;
      }
      return {
        interactionHandle: value.interactionHandle,
        kind: 'session_terminal',
        reason: value.reason as Extract<
          RendererInteractionResolution,
          { kind: 'session_terminal' }
        >['reason'],
      };
    case 'session_cleared':
      if (value.reason !== 'stream_disconnected' && value.reason !== 'shutdown') return undefined;
      return {
        interactionHandle: value.interactionHandle,
        kind: 'session_cleared',
        reason: value.reason,
      };
    default:
      return undefined;
  }
}

function parseApprovalResponseInput(
  interactionHandle: unknown,
  decision: unknown,
): { interactionHandle: string; decision: ApprovalDecisionV2 } {
  const parsedDecision = approvalDecisionV2Schema.safeParse(decision);
  if (!isHandle(interactionHandle) || !parsedDecision.success) {
    throw new Error('invalid approval response');
  }
  return { interactionHandle, decision: parsedDecision.data };
}

function parseRendererSessionCommand(value: unknown): RendererSessionCommand {
  if (!isRecord(value) || 'commandId' in value) {
    throw new Error('renderer session commands must not provide a command id');
  }
  const parsed = agentCommandV2Schema.parse({
    ...value,
    commandId: '00000000-0000-4000-8000-000000000000',
  });
  if (parsed.type === 'approval.respond' || parsed.type === 'question.respond') {
    throw new Error('interactive responses require an opaque interaction handle');
  }
  const { commandId: _commandId, ...command } = parsed;
  return command;
}

function parseQuestionResponseInput(
  interactionHandle: unknown,
  rawAnswers: unknown,
): RendererQuestionResponse {
  if (!isHandle(interactionHandle) || !Array.isArray(rawAnswers)) {
    throw new Error('invalid question response');
  }
  if (rawAnswers.length < 1 || rawAnswers.length > 3) {
    throw new Error('invalid question response');
  }
  const seenQuestions = new Set<string>();
  const answers = rawAnswers.map((rawAnswer) => {
    if (
      !isRecordWithExactKeys(rawAnswer, ['questionHandle', 'answer']) ||
      !isHandle(rawAnswer.questionHandle) ||
      seenQuestions.has(rawAnswer.questionHandle)
    ) {
      throw new Error('invalid question response');
    }
    seenQuestions.add(rawAnswer.questionHandle);
    return {
      questionHandle: rawAnswer.questionHandle,
      answer: parseQuestionAnswer(rawAnswer.answer),
    };
  });
  if (utf8ByteLength(JSON.stringify(answers)) > 32 * 1024) {
    throw new Error('invalid question response');
  }
  return { interactionHandle, answers };
}

function parseQuestionAnswer(value: unknown): RendererQuestionAnswer {
  if (!isRecord(value)) throw new Error('invalid question response');
  if (value.kind === 'text' && isRecordWithExactKeys(value, ['kind', 'text'])) {
    if (typeof value.text !== 'string' || utf8ByteLength(value.text) > 16 * 1024) {
      throw new Error('invalid question response');
    }
    return { kind: 'text', text: value.text };
  }
  if (value.kind === 'options' && isRecordWithExactKeys(value, ['kind', 'optionHandles'])) {
    if (
      !Array.isArray(value.optionHandles) ||
      value.optionHandles.length < 1 ||
      value.optionHandles.length > 10 ||
      !value.optionHandles.every(isHandle) ||
      new Set(value.optionHandles).size !== value.optionHandles.length
    ) {
      throw new Error('invalid question response');
    }
    return { kind: 'options', optionHandles: [...value.optionHandles] };
  }
  throw new Error('invalid question response');
}

function toInteractionResponseAcknowledgement(value: unknown): InteractionResponseAcknowledgement {
  if (!isRecord(value) || value.status !== 'accepted') {
    throw new Error('invalid interaction acknowledgement');
  }
  return { status: 'accepted' };
}

async function invokeInteractionResponse(
  channel: 'daemon:respond-approval' | 'daemon:answer-questions',
  input: unknown,
): Promise<InteractionResponseAcknowledgement> {
  try {
    return toInteractionResponseAcknowledgement(await ipcRenderer.invoke(channel, input));
  } catch {
    throw new Error('interaction response failed');
  }
}

function parseAuditReadOptions(value: unknown): AuditReadOptionsV2 {
  if (!isRecordWithAllowedKeys(value, ['cursor', 'limit', 'sessionId'])) {
    throw new Error('invalid audit read options');
  }
  if (
    value.cursor !== undefined &&
    (typeof value.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.cursor))
  ) {
    throw new Error('invalid audit cursor');
  }
  if (
    value.limit !== undefined &&
    (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100)
  ) {
    throw new Error('invalid audit limit');
  }
  const sessionId =
    value.sessionId === undefined
      ? undefined
      : sessionIdParamSchema.parse({ sessionId: value.sessionId }).sessionId;
  return {
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function toEffects(value: unknown): Effect[] | undefined {
  if (!Array.isArray(value) || value.length > EFFECTS.length) return undefined;
  if (!value.every((effect) => typeof effect === 'string' && EFFECT_SET.has(effect))) {
    return undefined;
  }
  if (new Set(value).size !== value.length) return undefined;
  return [...value] as Effect[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isRecordWithExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}

function isRecordWithAllowedKeys(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE_PATTERN.test(value);
}

function isSessionId(value: unknown): value is string {
  return sessionIdParamSchema.safeParse({ sessionId: value }).success;
}

function isByteBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && utf8ByteLength(value) <= maximum;
}

function isCharacterBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
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
  async listProvidersV2() {
    const providers: unknown = await ipcRenderer.invoke('daemon:list-providers-v2');
    return providersV2ResponseSchema.parse({ providers }).providers;
  },
  async openProviderInstallDocs(provider) {
    await ipcRenderer.invoke('shell:open-provider-install-docs', providerIdSchema.parse(provider));
  },
  async listMcpServers(provider, cwd) {
    const input = mcpListRequestV2Schema.parse({ provider, cwd });
    return mcpServerListV2Schema.parse(await ipcRenderer.invoke('daemon:list-mcp-servers', input));
  },
  async configureMcpServer(input) {
    const parsed = mcpConfigureRequestV2Schema.parse(input);
    return mcpServerListV2Schema.parse(await ipcRenderer.invoke('daemon:configure-mcp-server', parsed));
  },
  async actionMcpServer(input) {
    const parsed = mcpServerActionRequestV2Schema.parse(input);
    return mcpServerListV2Schema.parse(await ipcRenderer.invoke('daemon:action-mcp-server', parsed));
  },
  async getMcpCatalog(provider, serverId, cwd) {
    const input = mcpCatalogRequestV2Schema.parse({ provider, serverId, cwd });
    return mcpCatalogV2Schema.parse(await ipcRenderer.invoke('daemon:get-mcp-catalog', input));
  },
  async startMcpOAuth(provider, serverId, cwd) {
    const input = mcpOAuthStartRequestV2Schema.parse({ provider, serverId, cwd });
    const output: unknown = await ipcRenderer.invoke('daemon:start-mcp-oauth', input);
    if (!isRecordWithAllowedKeys(output, ['serverId', 'status', 'authorizationHost', 'safeSummary']) || output.serverId !== serverId || !['pending', 'authenticated', 'failed', 'unsupported'].includes(String(output.status))) {
      throw new Error('invalid MCP OAuth status');
    }
    if (output.authorizationHost !== undefined && (typeof output.authorizationHost !== 'string' || output.authorizationHost.length > 253 || !/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(output.authorizationHost))) {
      throw new Error('invalid MCP OAuth host');
    }
    if (output.safeSummary !== undefined && (typeof output.safeSummary !== 'string' || output.safeSummary.length > 1_024)) throw new Error('invalid MCP OAuth summary');
    return {
      serverId,
      status: output.status as RendererMcpOAuthStatus['status'],
      ...(typeof output.authorizationHost === 'string' ? { authorizationHost: output.authorizationHost } : {}),
      ...(typeof output.safeSummary === 'string' ? { safeSummary: output.safeSummary } : {}),
    };
  },
  async invokeMcpTool(input) {
    const parsed = mcpToolInvocationRequestV2Schema.parse(input);
    return mcpToolInvocationResultV2Schema.parse(await ipcRenderer.invoke('daemon:invoke-mcp-tool', parsed));
  },
  async listProviderComponents(input) {
    const parsed = providerComponentListRequestV2Schema.parse(input);
    return providerComponentListV2Schema.parse(await ipcRenderer.invoke('daemon:list-provider-components', parsed));
  },
  async manageProviderComponent(input) {
    const parsed = providerComponentManageRequestV2Schema.parse(input);
    return providerComponentOperationResultV2Schema.parse(await ipcRenderer.invoke('daemon:manage-provider-component', parsed));
  },
  async invokeProviderComponent(input) {
    const parsed = providerComponentInvokeRequestV2Schema.parse(input);
    return providerComponentOperationResultV2Schema.parse(await ipcRenderer.invoke('daemon:invoke-provider-component', parsed));
  },
  async getSubagentGraph(sessionId) {
    const parsed = sessionIdParamSchema.parse({ sessionId }).sessionId;
    return subagentGraphV2Schema.parse(await ipcRenderer.invoke('daemon:get-subagent-graph', parsed));
  },
  async controlSubagent(input) {
    const parsed = subagentControlRequestV2Schema.parse(input);
    return subagentControlResultV2Schema.parse(await ipcRenderer.invoke('daemon:control-subagent', parsed));
  },
  async previewWorktree(input) {
    const parsed = worktreePreviewRequestV2Schema.parse(input);
    return worktreePreviewV2Schema.parse(await ipcRenderer.invoke('daemon:preview-worktree', parsed));
  },
  async createWorktree(input) {
    const parsed = worktreeCreateRequestV2Schema.parse(input);
    return ownedWorktreeV2Schema.parse(await ipcRenderer.invoke('daemon:create-worktree', parsed));
  },
  async listWorktrees() {
    const worktrees: unknown = await ipcRenderer.invoke('daemon:list-worktrees');
    return ownedWorktreeListV2Schema.parse({ worktrees }).worktrees;
  },
  async cleanupWorktree(worktreeId) {
    const parsed = worktreeCleanupRequestV2Schema.parse({ worktreeId });
    return ownedWorktreeV2Schema.parse(await ipcRenderer.invoke('daemon:cleanup-worktree', parsed.worktreeId));
  },
  async selectAndUploadAttachments(sessionId) {
    const parsedSessionId = sessionId === undefined ? undefined : sessionIdParamSchema.parse({ sessionId }).sessionId;
    const attachments: unknown = await ipcRenderer.invoke('dialog:select-and-upload-attachments', parsedSessionId ? { sessionId: parsedSessionId } : {});
    return attachmentListV2Schema.parse({ attachments }).attachments;
  },
  async validateStructuredOutput(input) {
    const parsed = structuredWorkflowRequestV2Schema.parse(input);
    return structuredWorkflowResultV2Schema.parse(await ipcRenderer.invoke('daemon:validate-structured-output', parsed));
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
  async listInteractiveSessions(options = {}) {
    const input = sessionListV2QuerySchema.parse(options);
    return sessionListV2PageSchema.parse(
      await ipcRenderer.invoke('daemon:list-interactive-sessions', input),
    );
  },
  async readInteractiveSessionHistory(sessionId, options = {}) {
    const parsedSessionId = sessionIdParamSchema.parse({ sessionId }).sessionId;
    const query = sessionEventHistoryV2QuerySchema.parse(options);
    const page = sessionEventHistoryV2PageSchema.parse(
      await ipcRenderer.invoke('daemon:read-interactive-session-history', {
        sessionId: parsedSessionId,
        query,
      }),
    );
    return {
      ...page,
      events: page.events.filter((event) => !INTERACTION_EVENT_TYPES.has(event.type)),
    };
  },
  async reconnectInteractiveSession(sessionId) {
    const parsedSessionId = sessionIdParamSchema.parse({ sessionId }).sessionId;
    return agentSessionV2Schema.parse(
      await ipcRenderer.invoke('daemon:reconnect-interactive-session', parsedSessionId),
    );
  },
  async resumeInteractiveSession(sessionId, input) {
    const parsedSessionId = sessionIdParamSchema.parse({ sessionId }).sessionId;
    const parsedInput = sessionContinuationInputV2Schema.parse(input);
    return agentSessionV2Schema.parse(
      await ipcRenderer.invoke('daemon:resume-interactive-session', {
        sessionId: parsedSessionId,
        input: parsedInput,
      }),
    );
  },
  async forkInteractiveSession(sessionId, input) {
    const parsedSessionId = sessionIdParamSchema.parse({ sessionId }).sessionId;
    const parsedInput = sessionContinuationInputV2Schema.parse(input);
    return agentSessionV2Schema.parse(
      await ipcRenderer.invoke('daemon:fork-interactive-session', {
        sessionId: parsedSessionId,
        input: parsedInput,
      }),
    );
  },
  async deleteInteractiveSession(sessionId) {
    const parsedSessionId = sessionIdParamSchema.parse({ sessionId }).sessionId;
    await ipcRenderer.invoke('daemon:delete-interactive-session', parsedSessionId);
  },
  async sendSessionCommand(command) {
    const parsedCommand = parseRendererSessionCommand(command);
    const acknowledgement = commandAcknowledgementV2Schema.parse(
      await ipcRenderer.invoke('daemon:send-session-command', parsedCommand),
    );
    if (
      acknowledgement.sessionId !== parsedCommand.sessionId ||
      acknowledgement.turnId !== parsedCommand.turnId
    ) {
      throw new Error('interactive command acknowledgement does not match the submitted command');
    }
    return acknowledgement;
  },
  async respondApproval(interactionHandle, decision) {
    const input = parseApprovalResponseInput(interactionHandle, decision);
    return invokeInteractionResponse('daemon:respond-approval', input);
  },
  async answerQuestions(interactionHandle, answers) {
    const input = parseQuestionResponseInput(interactionHandle, answers);
    return invokeInteractionResponse('daemon:answer-questions', input);
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
      if (INTERACTION_EVENT_TYPES.has(parsedEvent.data.type)) return;
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
  onInteractionRequested(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (!isRecord(payload) || !isSessionId(payload.sessionId)) return;
      const interaction = toRendererInteraction(payload.interaction);
      if (interaction) callback(payload.sessionId, interaction);
    };
    ipcRenderer.on('daemon:interaction-requested', listener);
    return () => ipcRenderer.removeListener('daemon:interaction-requested', listener);
  },
  onInteractionResolved(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (!isRecord(payload) || !isSessionId(payload.sessionId)) return;
      const resolution = toInteractionResolution(payload.resolution);
      if (resolution) callback(payload.sessionId, resolution);
    };
    ipcRenderer.on('daemon:interaction-resolved', listener);
    return () => ipcRenderer.removeListener('daemon:interaction-resolved', listener);
  },
  async inspectWorkspace(cwd) {
    const input = workspaceInspectRequestV2Schema.parse({ cwd });
    return workspaceTrustViewV2Schema.parse(
      await ipcRenderer.invoke('daemon:inspect-workspace', input),
    );
  },
  async setWorkspaceTrust(workspaceId, input) {
    if (!/^[a-f0-9]{64}$/.test(workspaceId)) throw new Error('invalid workspace id');
    const update = workspaceTrustUpdateRequestV2Schema.parse(input);
    return workspaceTrustViewV2Schema.parse(
      await ipcRenderer.invoke('daemon:set-workspace-trust', { workspaceId, update }),
    );
  },
  async readAudit(options = {}) {
    const input = parseAuditReadOptions(options);
    return auditReadResponseV2Schema.parse(await ipcRenderer.invoke('daemon:read-audit', input));
  },
  async selectDirectory() {
    const result: unknown = await ipcRenderer.invoke('dialog:select-directory');
    return typeof result === 'string' ? result : null;
  },
};

contextBridge.exposeInMainWorld('agentDock', api);
