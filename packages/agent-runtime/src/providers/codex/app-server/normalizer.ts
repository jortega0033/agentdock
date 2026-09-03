import { createHash, randomUUID } from 'node:crypto';
import type { AgentEventV2, BoundedJson, Effect } from '@agent-dock/shared';
import { validateStructuredOutput } from '../../../structured-output.js';
import { CodexAppServerProtocolError, boundedUtf8, safeDisplay } from './errors.js';

type JsonObject = Record<string, unknown>;

interface ItemIdentity {
  contentBlockId: string;
  toolCallId: string;
  started: boolean;
  completed: boolean;
}

interface DeltaDigest {
  bytes: number;
  hash: ReturnType<typeof createHash>;
}

const KNOWN_NOTIFICATION_METHODS = new Set([
  'remoteControl/status/changed',
  'warning',
  'mcpServer/startupStatus/updated',
  'account/rateLimits/updated',
  'thread/started',
  'thread/status/changed',
  'turn/started',
  'turn/completed',
  'turn/plan/updated',
  'turn/diff/updated',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'thread/tokenUsage/updated',
  'error',
]);
const MAX_TRACKED_TURNS = 10_000;
const MAX_TRACKED_ITEMS = 10_000;
const MAX_TRACKED_SUBAGENTS = 10_000;
const SUBAGENT_ACTIVITY_KINDS = new Set(['started', 'interacted', 'interrupted']);
const MAX_CONTENT_BLOCK_BYTES = 256 * 1024;
const MAX_NATIVE_CORRELATION_ID_BYTES = 1_024;

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodexAppServerProtocolError('frame_invalid', `Invalid ${label}`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 64 * 1024) {
    throw new CodexAppServerProtocolError('frame_invalid', `Invalid ${label}`);
  }
  return value;
}

function nativeCorrelationId(value: unknown, label: string): string {
  const id = requiredString(value, label);
  if (Buffer.byteLength(id) > MAX_NATIVE_CORRELATION_ID_BYTES) {
    throw new CodexAppServerProtocolError('frame_invalid', `Invalid ${label}`);
  }
  return id;
}

function contentBlockText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CodexAppServerProtocolError('frame_invalid', `Invalid ${label}`);
  }
  return value;
}

function jsonBytes(value: unknown): Buffer {
  try {
    return Buffer.from(JSON.stringify(value), 'utf8');
  } catch {
    throw new CodexAppServerProtocolError('frame_invalid', 'Invalid Codex content block');
  }
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function toolDescriptor(item: JsonObject):
  | {
      name: string;
      effects: Effect[];
      effectsComplete: boolean;
    }
  | undefined {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'command', effects: ['command'], effectsComplete: false };
    case 'fileChange':
      return { name: 'file_change', effects: ['filesystem_write'], effectsComplete: false };
    case 'mcpToolCall': {
      const server = safeDisplay(item.server, 96, 'mcp');
      const tool = safeDisplay(item.tool, 96, 'tool');
      return item.readOnlyHint === true
        ? {
            name: boundedUtf8(`mcp:${server}/${tool}`, 256),
            effects: ['read'],
            effectsComplete: true,
          }
        : {
            name: boundedUtf8(`mcp:${server}/${tool}`, 256),
            effects: ['external_side_effect'],
            effectsComplete: false,
          };
    }
    case 'dynamicToolCall':
      return {
        name: boundedUtf8(`tool:${safeDisplay(item.tool, 220, 'dynamic')}`, 256),
        effects: ['external_side_effect'],
        effectsComplete: false,
      };
    case 'collabAgentToolCall':
      return {
        name: boundedUtf8(`collab:${safeDisplay(item.tool, 216, 'agent')}`, 256),
        effects: ['external_side_effect'],
        effectsComplete: false,
      };
    default:
      return undefined;
  }
}

function completedToolStatus(item: JsonObject): 'completed' | 'failed' {
  const status = item.status;
  return status === 'failed' || status === 'declined' || item.success === false
    ? 'failed'
    : 'completed';
}

function completedToolSummary(item: JsonObject): string {
  if (item.type === 'commandExecution') {
    const exitCode = typeof item.exitCode === 'number' ? ` with exit code ${item.exitCode}` : '';
    return `Command ${completedToolStatus(item)}${exitCode}`;
  }
  if (item.type === 'fileChange') {
    const count = Array.isArray(item.changes) ? item.changes.length : 0;
    return `File change ${completedToolStatus(item)} (${count} file${count === 1 ? '' : 's'})`;
  }
  if (item.type === 'mcpToolCall') return `MCP tool call ${completedToolStatus(item)}`;
  return `Tool call ${completedToolStatus(item)}`;
}

/** Stateful native-id to AgentDock-id normalizer. Native payloads are never used as identifiers. */
export class CodexAppServerNormalizer {
  private providerThreadIdValue: string | undefined;
  private announcedThreadIdValue: string | undefined;
  private sessionStarted = false;
  private pendingAgentTurnId: string | undefined;
  private readonly turnIds = new Map<string, string>();
  private activeNativeTurnId: string | undefined;
  private readonly startedNativeTurns = new Set<string>();
  private readonly completedNativeTurns = new Set<string>();
  private readonly items = new Map<string, ItemIdentity>();
  private readonly messageDeltas = new Map<string, DeltaDigest>();
  private readonly summarizedReasoning = new Set<string>();
  private readonly summarizedMessageDeltas = new Set<string>();
  // Set once at session start (issue #59); applied to every turn's final agentMessage for the
  // life of the session, since the schema is negotiated at session-creation time, not per turn.
  private outputSchemaValue: unknown;
  // agentThreadId -> stable AgentDock subagent id, the same reuse-once-generated idiom as
  // itemIdentity()/bindTurn() above -- never the native Codex thread id itself on the wire.
  private readonly subagentIds = new Map<string, string>();
  private readonly subagentNames = new Map<string, string>();
  private readonly openSubagents = new Set<string>();

  constructor(private readonly emit: (event: AgentEventV2) => void) {}

  get providerThreadId(): string | undefined {
    return this.providerThreadIdValue;
  }

  get activeTurn(): { nativeId: string; agentId: string } | undefined {
    const nativeId = this.activeNativeTurnId;
    if (!nativeId) return undefined;
    const agentId = this.turnIds.get(nativeId);
    return agentId ? { nativeId, agentId } : undefined;
  }

  startSession(
    providerThreadId: string,
    transportId: string,
    selection: Extract<AgentEventV2, { type: 'session.started' }>['selection'],
    outputSchema?: unknown,
  ): void {
    if (this.sessionStarted) {
      throw new CodexAppServerProtocolError('state_invalid', 'Codex session started twice');
    }
    const normalizedThreadId = nativeCorrelationId(providerThreadId, 'provider thread id');
    if (
      this.announcedThreadIdValue !== undefined &&
      this.announcedThreadIdValue !== normalizedThreadId
    ) {
      throw new CodexAppServerProtocolError('state_invalid', 'Thread response changed its id');
    }
    this.providerThreadIdValue = normalizedThreadId;
    this.sessionStarted = true;
    this.outputSchemaValue = outputSchema;
    this.emit({ type: 'session.started', provider: 'codex', transport: transportId, selection });
  }

  expectTurn(agentTurnId: string): void {
    if (!this.sessionStarted || this.pendingAgentTurnId || this.activeNativeTurnId) {
      throw new CodexAppServerProtocolError('state_invalid', 'Cannot start another Codex turn');
    }
    this.pendingAgentTurnId = agentTurnId;
  }

  bindTurnResponse(nativeTurnId: string): void {
    this.bindTurn(nativeCorrelationId(nativeTurnId, 'native turn id'));
  }

  notification(method: string, rawParams: unknown): void {
    if (!KNOWN_NOTIFICATION_METHODS.has(method)) {
      if (this.sessionStarted) {
        this.emit({
          type: 'extension.summary',
          ...(this.activeTurn?.agentId ? { turnId: this.activeTurn.agentId } : {}),
          extensionName: boundedUtf8(`codex.${safeDisplay(method, 220, 'notification')}`, 256),
          summary: 'Unsupported Codex app-server notification omitted',
          reason: 'unsupported',
        });
      }
      return;
    }
    const params = object(rawParams, `${method} params`);
    switch (method) {
      case 'remoteControl/status/changed':
        this.remoteControlStatus(params);
        return;
      case 'warning':
        this.warning(params);
        return;
      case 'mcpServer/startupStatus/updated':
        this.mcpServerStartupStatus(params);
        return;
      case 'account/rateLimits/updated':
        object(params.rateLimits, 'rate-limit snapshot');
        return;
      case 'thread/started':
        this.threadStarted(params);
        return;
      case 'thread/status/changed':
        this.assertThread(params.threadId);
        return;
      case 'turn/diff/updated':
        this.correlatedTurn(params);
        return;
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
      case 'item/fileChange/patchUpdated':
      case 'item/mcpToolCall/progress':
      case 'item/reasoning/summaryPartAdded':
        this.correlatedTrackedItem(params);
        return;
      case 'turn/started':
        this.turnStarted(params);
        return;
      case 'turn/completed':
        this.turnCompleted(params);
        return;
      case 'turn/plan/updated':
        this.planUpdated(params);
        return;
      case 'item/started':
        this.itemStarted(params);
        return;
      case 'item/completed':
        this.itemCompleted(params);
        return;
      case 'item/agentMessage/delta':
        this.contentDelta(params, 'message');
        return;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.contentDelta(params, 'reasoning');
        return;
      case 'thread/tokenUsage/updated':
        this.usage(params);
        return;
      case 'error':
        this.nativeError(params);
    }
  }

  private bindTurn(nativeTurnId: string): string {
    const existing = this.turnIds.get(nativeTurnId);
    if (existing) return existing;
    if (!this.pendingAgentTurnId) {
      throw new CodexAppServerProtocolError('state_invalid', 'Unexpected native Codex turn');
    }
    if (this.turnIds.size >= MAX_TRACKED_TURNS) {
      throw new CodexAppServerProtocolError('state_invalid', 'Codex exceeded the turn limit');
    }
    const agentTurnId = this.pendingAgentTurnId;
    this.pendingAgentTurnId = undefined;
    this.turnIds.set(nativeTurnId, agentTurnId);
    return agentTurnId;
  }

  private remoteControlStatus(params: JsonObject): void {
    if (!['disabled', 'connecting', 'connected', 'errored'].includes(String(params.status))) {
      throw new CodexAppServerProtocolError('frame_invalid', 'Invalid remote-control status');
    }
    nativeCorrelationId(params.installationId, 'remote-control installation id');
    nativeCorrelationId(params.serverName, 'remote-control server name');
    if (params.environmentId !== undefined && params.environmentId !== null) {
      nativeCorrelationId(params.environmentId, 'remote-control environment id');
    }
  }

  private warning(params: JsonObject): void {
    requiredString(params.message, 'warning message');
    if (params.threadId !== undefined && params.threadId !== null) {
      this.assertThread(params.threadId);
    }
  }

  private mcpServerStartupStatus(params: JsonObject): void {
    nativeCorrelationId(params.name, 'MCP server name');
    if (!['starting', 'ready', 'failed', 'cancelled'].includes(String(params.status))) {
      throw new CodexAppServerProtocolError('frame_invalid', 'Invalid MCP startup status');
    }
    if (params.threadId !== undefined && params.threadId !== null) {
      this.assertThread(params.threadId);
    }
    if (params.error !== undefined && params.error !== null && typeof params.error !== 'string') {
      throw new CodexAppServerProtocolError('frame_invalid', 'Invalid MCP startup error');
    }
    if (
      params.failureReason !== undefined &&
      params.failureReason !== null &&
      params.failureReason !== 'reauthenticationRequired'
    ) {
      throw new CodexAppServerProtocolError('frame_invalid', 'Invalid MCP startup failure reason');
    }
  }

  private threadStarted(params: JsonObject): void {
    const thread = object(params.thread, 'thread/started thread');
    const threadId = nativeCorrelationId(thread.id, 'thread id');
    if (this.providerThreadIdValue === undefined) {
      if (this.announcedThreadIdValue !== undefined && this.announcedThreadIdValue !== threadId) {
        throw new CodexAppServerProtocolError('state_invalid', 'Event belongs to another thread');
      }
      this.announcedThreadIdValue = threadId;
      return;
    }
    this.assertThread(threadId);
  }

  private turnStarted(params: JsonObject): void {
    this.assertThread(params.threadId);
    const turn = object(params.turn, 'turn/started turn');
    const nativeTurnId = nativeCorrelationId(turn.id, 'native turn id');
    if (this.startedNativeTurns.has(nativeTurnId) || this.activeNativeTurnId) {
      throw new CodexAppServerProtocolError('state_invalid', 'Duplicate or overlapping Codex turn');
    }
    const agentTurnId = this.bindTurn(nativeTurnId);
    this.startedNativeTurns.add(nativeTurnId);
    this.activeNativeTurnId = nativeTurnId;
    this.emit({ type: 'session.status', status: 'active' });
    this.emit({ type: 'turn.started', turnId: agentTurnId });
  }

  private turnCompleted(params: JsonObject): void {
    this.assertThread(params.threadId);
    const turn = object(params.turn, 'turn/completed turn');
    const nativeTurnId = nativeCorrelationId(turn.id, 'native turn id');
    if (
      this.activeNativeTurnId !== nativeTurnId ||
      !this.startedNativeTurns.has(nativeTurnId) ||
      this.completedNativeTurns.has(nativeTurnId)
    ) {
      throw new CodexAppServerProtocolError('state_invalid', 'Unexpected Codex turn completion');
    }
    const turnId = this.turnIds.get(nativeTurnId)!;
    this.completedNativeTurns.add(nativeTurnId);
    this.activeNativeTurnId = undefined;
    if (turn.status === 'failed') {
      this.emit({
        type: 'turn.failed',
        turnId,
        code: 'codex_turn_failed',
        message: 'Codex turn failed',
      });
    } else if (turn.status === 'interrupted') {
      this.emit({ type: 'turn.interrupted', turnId, reason: 'Codex turn interrupted' });
    } else if (turn.status === 'completed') {
      this.emit({ type: 'turn.completed', turnId });
    } else {
      throw new CodexAppServerProtocolError('state_invalid', 'Invalid Codex turn status');
    }
    this.closeOpenSubagents(turnId, turn.status);
    this.emit({ type: 'session.status', status: 'idle' });
  }

  /**
   * Codex's own subAgentActivity schema has no explicit "completed"/"finished" kind -- only
   * started, interacted, and interrupted (see the vendored app-server schema for issue #58's
   * pinned version). There is therefore no provider-confirmed signal for a sub-agent finishing
   * normally; closing out whatever is still open when its parent turn concludes, with no further
   * activity for it, is an inferred terminal signal, not a provider-confirmed one. An explicit
   * `interrupted` kind (handled in subAgentActivity() below) is real evidence and removes the
   * entry from openSubagents immediately, so it is never re-closed here. The inferred status
   * mirrors the parent turn's own outcome -- a child left open when its turn failed or was
   * interrupted is marked accordingly, not silently reported as having succeeded.
   */
  private closeOpenSubagents(turnId: string, parentTurnStatus: string): void {
    const status =
      parentTurnStatus === 'failed' ? 'failed' : parentTurnStatus === 'interrupted' ? 'cancelled' : 'completed';
    for (const nativeChildId of [...this.openSubagents]) {
      const agentId = this.subagentIds.get(nativeChildId);
      const name = this.subagentNames.get(nativeChildId);
      this.openSubagents.delete(nativeChildId);
      if (!agentId || !name) continue;
      this.emit({
        type: 'subagent.status',
        turnId,
        agentId,
        nativeChildId,
        name,
        status,
        controls: { steer: false, interrupt: false, cancel: false },
      });
    }
  }

  private subAgentActivity(item: JsonObject, turnId: string): void {
    const nativeChildId = nativeCorrelationId(item.agentThreadId, 'sub-agent thread id');
    const agentPath = requiredString(item.agentPath, 'sub-agent path');
    if (typeof item.kind !== 'string' || !SUBAGENT_ACTIVITY_KINDS.has(item.kind)) {
      throw new CodexAppServerProtocolError('frame_invalid', 'Invalid sub-agent activity kind');
    }
    let agentId = this.subagentIds.get(nativeChildId);
    if (!agentId) {
      if (this.subagentIds.size >= MAX_TRACKED_SUBAGENTS) {
        throw new CodexAppServerProtocolError('state_invalid', 'Codex exceeded the sub-agent limit');
      }
      agentId = randomUUID();
      this.subagentIds.set(nativeChildId, agentId);
    }
    const name = boundedUtf8(agentPath, 256);
    this.subagentNames.set(nativeChildId, name);
    const status = item.kind === 'interrupted' ? 'cancelled' : item.kind === 'started' ? 'spawning' : 'running';
    if (status === 'cancelled') this.openSubagents.delete(nativeChildId);
    else this.openSubagents.add(nativeChildId);
    this.emit({
      type: 'subagent.status',
      turnId,
      agentId,
      nativeChildId,
      name,
      status,
      controls: { steer: false, interrupt: false, cancel: false },
    });
  }

  private planUpdated(params: JsonObject): void {
    const turnId = this.correlatedTurn(params);
    if (!Array.isArray(params.plan) || params.plan.length > 100) {
      throw new CodexAppServerProtocolError('frame_invalid', 'Invalid Codex plan');
    }
    const steps = params.plan.map((rawStep) => {
      const step = object(rawStep, 'plan step');
      const status =
        step.status === 'inProgress'
          ? 'in_progress'
          : step.status === 'completed'
            ? 'completed'
            : 'pending';
      return {
        id: randomUUID(),
        text: contentBlockText(step.step, 'Plan step'),
        status,
      } as const;
    });
    const block = {
      type: 'plan' as const,
      id: randomUUID(),
      ...(typeof params.explanation === 'string'
        ? { title: contentBlockText(params.explanation, 'Plan explanation') }
        : {}),
      steps,
    };
    const encoded = jsonBytes(block);
    if (encoded.byteLength > MAX_CONTENT_BLOCK_BYTES) {
      this.emit({
        type: 'content.completed',
        turnId,
        block: {
          type: 'provider_extension',
          id: block.id,
          extensionName: 'codex.plan',
          representation: 'safe_summary',
          safeSummary: 'Codex plan exceeded the 256 KiB content-block limit',
          reason: 'truncated',
          originalBytes: encoded.byteLength,
          sha256: createHash('sha256').update(encoded).digest('hex'),
        },
      });
      return;
    }
    this.emit({ type: 'content.completed', turnId, block });
  }

  private itemStarted(params: JsonObject): void {
    const turnId = this.correlatedTurn(params);
    const item = object(params.item, 'started item');
    this.itemIdentity(nativeCorrelationId(item.id, 'native item id'));
    // subAgentActivity is reported once per pulse via its own item/started + item/completed pair,
    // both carrying the same `kind` -- unlike a tool call, there is nothing distinct to say at
    // "started" that "completed" (handled below in itemCompleted) does not already say, so this
    // emits nothing here to avoid a duplicate event per pulse.
    if (item.type === 'subAgentActivity') return;
    const descriptor = toolDescriptor(item);
    if (!descriptor) return;
    this.startTool(item, turnId, descriptor);
  }

  private itemCompleted(params: JsonObject): void {
    const turnId = this.correlatedTurn(params);
    const item = object(params.item, 'completed item');
    const nativeItemId = nativeCorrelationId(item.id, 'native item id');
    if (item.type === 'subAgentActivity') {
      this.subAgentActivity(item, turnId);
      return;
    }
    if (item.type === 'agentMessage') {
      const identity = this.itemIdentity(nativeItemId);
      if (identity.completed)
        throw new CodexAppServerProtocolError('state_invalid', 'Item completed twice');
      if (typeof item.text !== 'string') {
        throw new CodexAppServerProtocolError('frame_invalid', 'Invalid completed agent message');
      }
      const text = item.text;
      const finalBytes = Buffer.from(text);
      const finalHash = createHash('sha256').update(finalBytes).digest('hex');
      const deltaDigest = this.messageDeltas.get(nativeItemId);
      if (deltaDigest) {
        this.messageDeltas.delete(nativeItemId);
        this.summarizedMessageDeltas.delete(nativeItemId);
        if (
          deltaDigest.bytes !== finalBytes.byteLength ||
          deltaDigest.hash.digest('hex') !== finalHash
        ) {
          throw new CodexAppServerProtocolError(
            'state_invalid',
            'Codex message delta and completed item disagreed',
          );
        }
      }
      identity.completed = true;
      const block = {
        type: 'text' as const,
        id: identity.contentBlockId,
        text,
      };
      const encodedBlock = jsonBytes(block);
      if (encodedBlock.byteLength > MAX_CONTENT_BLOCK_BYTES) {
        this.emit({
          type: 'content.completed',
          turnId,
          block: {
            type: 'provider_extension',
            id: identity.contentBlockId,
            extensionName: 'codex.agent_message',
            representation: 'safe_summary',
            safeSummary: 'Codex message exceeded the 256 KiB content-block limit',
            reason: 'truncated',
            originalBytes: encodedBlock.byteLength,
            sha256: createHash('sha256').update(encodedBlock).digest('hex'),
          },
        });
        return;
      }
      this.emit({
        type: 'content.completed',
        turnId,
        block,
      });
      this.emitStructuredOutputIfValid(turnId, text);
      return;
    }
    if (item.type === 'reasoning') {
      const identity = this.itemIdentity(nativeItemId);
      if (identity.completed)
        throw new CodexAppServerProtocolError('state_invalid', 'Item completed twice');
      identity.completed = true;
      this.summarizedReasoning.delete(nativeItemId);
      this.emit({
        type: 'content.completed',
        turnId,
        block: {
          type: 'provider_extension',
          id: identity.contentBlockId,
          extensionName: 'codex.reasoning',
          representation: 'safe_summary',
          safeSummary: 'Codex reasoning completed',
          reason: 'redacted',
        },
      });
      return;
    }
    if (item.type === 'plan') {
      const identity = this.itemIdentity(nativeItemId);
      if (identity.completed)
        throw new CodexAppServerProtocolError('state_invalid', 'Item completed twice');
      identity.completed = true;
      const block = {
        type: 'plan' as const,
        id: identity.contentBlockId,
        title: 'Codex plan',
        steps: [
          {
            id: randomUUID(),
            text: contentBlockText(item.text, 'Plan updated'),
            status: 'pending' as const,
          },
        ],
      };
      const encoded = jsonBytes(block);
      if (encoded.byteLength > MAX_CONTENT_BLOCK_BYTES) {
        this.emit({
          type: 'content.completed',
          turnId,
          block: {
            type: 'provider_extension',
            id: identity.contentBlockId,
            extensionName: 'codex.plan',
            representation: 'safe_summary',
            safeSummary: 'Codex plan exceeded the 256 KiB content-block limit',
            reason: 'truncated',
            originalBytes: encoded.byteLength,
            sha256: createHash('sha256').update(encoded).digest('hex'),
          },
        });
        return;
      }
      this.emit({ type: 'content.completed', turnId, block });
      return;
    }
    const descriptor = toolDescriptor(item);
    if (!descriptor) {
      const identity = this.itemIdentity(nativeItemId);
      if (identity.completed)
        throw new CodexAppServerProtocolError('state_invalid', 'Item completed twice');
      identity.completed = true;
      this.emit({
        type: 'content.completed',
        turnId,
        block: {
          type: 'provider_extension',
          id: identity.contentBlockId,
          extensionName: `codex.item.${safeDisplay(item.type, 128, 'unknown')}`,
          representation: 'safe_summary',
          safeSummary: 'Unsupported Codex item payload omitted',
          reason: 'unsupported',
        },
      });
      return;
    }
    const identity = this.startTool(item, turnId, descriptor);
    if (identity.completed)
      throw new CodexAppServerProtocolError('state_invalid', 'Tool completed twice');
    identity.completed = true;
    this.emit({
      type: 'tool.completed',
      turnId,
      toolCallId: identity.toolCallId,
      contentBlockId: identity.contentBlockId,
      toolName: descriptor.name,
      status: completedToolStatus(item),
      summary: boundedUtf8(completedToolSummary(item), 4_096),
    });
  }

  private contentDelta(params: JsonObject, kind: 'message' | 'reasoning'): void {
    const turnId = this.correlatedTurn(params);
    const nativeItemId = nativeCorrelationId(params.itemId, 'native item id');
    if (typeof params.delta !== 'string') {
      throw new CodexAppServerProtocolError('frame_invalid', 'Invalid content delta');
    }
    const identity = this.itemIdentity(nativeItemId);
    if (identity.completed) {
      throw new CodexAppServerProtocolError('state_invalid', 'Content arrived after completion');
    }
    if (kind === 'reasoning') {
      if (!this.summarizedReasoning.has(nativeItemId)) {
        this.summarizedReasoning.add(nativeItemId);
        this.emit({
          type: 'extension.summary',
          turnId,
          extensionName: 'codex.reasoning',
          summary: 'Codex reasoning update redacted from persistent events',
          reason: 'redacted',
        });
      }
      return;
    }
    let digest = this.messageDeltas.get(nativeItemId);
    if (!digest) {
      digest = { bytes: 0, hash: createHash('sha256') };
      this.messageDeltas.set(nativeItemId, digest);
    }
    const encoded = Buffer.from(params.delta);
    digest.bytes += encoded.byteLength;
    digest.hash.update(encoded);
    const event = {
      type: 'content.delta' as const,
      turnId,
      contentBlockId: identity.contentBlockId,
      delta: params.delta,
    };
    if (jsonBytes(event).byteLength > MAX_CONTENT_BLOCK_BYTES) {
      if (!this.summarizedMessageDeltas.has(nativeItemId)) {
        this.summarizedMessageDeltas.add(nativeItemId);
        this.emit({
          type: 'extension.summary',
          turnId,
          extensionName: 'codex.agent_message',
          summary: 'Codex message delta exceeded the 256 KiB content-block limit',
          reason: 'truncated',
        });
      }
      return;
    }
    this.emit(event);
  }

  private usage(params: JsonObject): void {
    this.assertThread(params.threadId);
    const tokenUsage = object(params.tokenUsage, 'token usage');
    const last = object(tokenUsage.last, 'last token usage');
    const nativeTurnId = nativeCorrelationId(params.turnId, 'native turn id');
    const turnId = this.turnIds.get(nativeTurnId);
    if (!turnId) throw new CodexAppServerProtocolError('state_invalid', 'Unknown usage turn');
    const inputTokens = safeCount(last.inputTokens);
    const outputTokens = safeCount(last.outputTokens);
    const cachedInputTokens = safeCount(last.cachedInputTokens);
    this.emit({
      type: 'usage.tokens',
      turnId,
      scope: 'turn',
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    });
  }

  private nativeError(params: JsonObject): void {
    const turnId = this.correlatedTurn(params);
    this.emit({
      type: 'error',
      turnId,
      code: 'codex_turn_error',
      message: 'Codex app-server reported a turn error',
      recoverable: params.willRetry === true,
    });
  }

  /**
   * Codex has no dedicated "structured output" item type (issue #59) -- the final assistant
   * message always arrives as plain `agentMessage` text, already emitted above as a normal text
   * content block regardless of what happens here. When a caller negotiated `output.structured`,
   * this additionally tries to parse that same text as JSON and AJV-validate it against the
   * session's schema; on success it emits one more content block carrying the parsed, validated
   * data. On failure (not JSON, or JSON that fails the schema) nothing more is emitted -- the
   * plain text block already emitted is the only representation, satisfying "invalid output
   * remains inspectable but cannot be consumed as valid": no `structured_data` block ever exists
   * for output that didn't actually validate.
   */
  private emitStructuredOutputIfValid(turnId: string, text: string): void {
    if (this.outputSchemaValue === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const result = validateStructuredOutput(this.outputSchemaValue, parsed);
    if (!result.valid) return;
    // Safe: JSON.parse() always returns a JSON-shaped value, and AJV just confirmed it matches
    // the caller's own schema. The wire schema's own bounds (depth/size/node count) are still
    // enforced downstream when this event is validated for the SSE/storage layer.
    const block = { type: 'structured_data' as const, id: randomUUID(), data: parsed as BoundedJson };
    const encoded = jsonBytes(block);
    if (encoded.byteLength > MAX_CONTENT_BLOCK_BYTES) {
      this.emit({
        type: 'content.completed',
        turnId,
        block: {
          type: 'provider_extension',
          id: block.id,
          extensionName: 'codex.structured_output',
          representation: 'safe_summary',
          safeSummary: 'Codex structured output exceeded the 256 KiB content-block limit',
          reason: 'truncated',
          originalBytes: encoded.byteLength,
          sha256: createHash('sha256').update(encoded).digest('hex'),
        },
      });
      return;
    }
    this.emit({ type: 'content.completed', turnId, block });
  }

  private startTool(
    item: JsonObject,
    turnId: string,
    descriptor: { name: string; effects: Effect[]; effectsComplete: boolean },
  ): ItemIdentity {
    const nativeItemId = nativeCorrelationId(item.id, 'native item id');
    const identity = this.itemIdentity(nativeItemId);
    if (!identity.started) {
      identity.started = true;
      this.emit({
        type: 'tool.started',
        turnId,
        toolCallId: identity.toolCallId,
        contentBlockId: identity.contentBlockId,
        toolName: descriptor.name,
        possibleEffects: descriptor.effects,
        effectsComplete: descriptor.effectsComplete,
      });
    }
    return identity;
  }

  private itemIdentity(nativeItemId: string): ItemIdentity {
    let identity = this.items.get(nativeItemId);
    if (!identity) {
      if (this.items.size >= MAX_TRACKED_ITEMS) {
        throw new CodexAppServerProtocolError('state_invalid', 'Codex exceeded the item limit');
      }
      identity = {
        contentBlockId: randomUUID(),
        toolCallId: randomUUID(),
        started: false,
        completed: false,
      };
      this.items.set(nativeItemId, identity);
    }
    return identity;
  }

  private correlatedTrackedItem(params: JsonObject): void {
    this.correlatedTurn(params);
    const nativeItemId = nativeCorrelationId(params.itemId, 'native item id');
    const identity = this.items.get(nativeItemId);
    if (!identity) {
      throw new CodexAppServerProtocolError('state_invalid', 'Event belongs to an unknown item');
    }
    if (identity.completed) {
      throw new CodexAppServerProtocolError(
        'state_invalid',
        'Item update arrived after completion',
      );
    }
  }

  private correlatedTurn(params: JsonObject): string {
    this.assertThread(params.threadId);
    const nativeTurnId = nativeCorrelationId(params.turnId, 'native turn id');
    const turnId = this.turnIds.get(nativeTurnId);
    if (!turnId || this.activeNativeTurnId !== nativeTurnId) {
      throw new CodexAppServerProtocolError('state_invalid', 'Event belongs to an inactive turn');
    }
    return turnId;
  }

  private assertThread(value: unknown): void {
    if (nativeCorrelationId(value, 'thread id') !== this.providerThreadIdValue) {
      throw new CodexAppServerProtocolError('state_invalid', 'Event belongs to another thread');
    }
  }
}
