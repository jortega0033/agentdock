import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  agentEventV2EnvelopeSchema,
  agentSessionV2Schema,
  utf8ByteLength,
  type AgentCommandV2,
  type AgentEventEnvelope,
  type AgentEventV2Envelope,
  type AgentSession,
  type AgentSessionV2,
  type CapabilitySelection,
  type CreateSessionV2Request,
  type ProviderTransportV2,
} from '@agent-dock/shared';
import type { DispatchResult, SessionManager } from './session-manager.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

interface ToolCorrelation {
  toolCallId: string;
  contentBlockId: string;
  toolName: string;
}

interface StoredV2Event {
  event: AgentEventV2Envelope;
  bytes: number;
}

interface V2SessionMetadata {
  selection: CapabilitySelection;
  executionId: string;
  turnId: string;
  events: Map<number, StoredV2Event>;
  listeners: Set<(sequence: number, event: AgentEventV2Envelope) => void>;
  replayBytes: number;
  nextSequence: number;
  sourceUnsubscribe?: () => void;
  nativeTools: Map<string, ToolCorrelation>;
  interactive: boolean;
  status: AgentSessionV2['status'];
  pendingInteractions: Map<string, { kind: 'approval' | 'question'; turnId: string }>;
  responderLease?: string;
}

const ALL_EFFECTS = [
  'read',
  'filesystem_write',
  'command',
  'network',
  'external_side_effect',
  'destructive',
] as const;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_WIRE_STRING_BYTES = 256;
const MAX_REPLAY_EVENTS = 5_000;
const MAX_REPLAY_BYTES = 16 * 1024 * 1024;
const RESPONDER_LEASE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isTerminal(event: AgentEventV2Envelope): boolean {
  return (
    event.type === 'session.completed' ||
    event.type === 'session.failed' ||
    event.type === 'session.cancelled' ||
    event.type === 'session.interrupted'
  );
}

function v2Status(status: AgentSession['status']): AgentSessionV2['status'] {
  return status === 'running' ? 'active' : status;
}

function boundedSummary(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 511)}…`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (utf8ByteLength(value.slice(0, midpoint)) <= maxBytes) low = midpoint;
    else high = midpoint - 1;
  }
  const truncated = value.slice(0, low);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}

function validTokenCount(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

export class V2SessionFacade {
  private readonly metadata = new Map<string, V2SessionMetadata>();

  constructor(private readonly sessions: SessionManager) {}

  async create(
    input: CreateSessionV2Request,
    selection: CapabilitySelection,
    transport: ProviderTransportV2,
    interactive: boolean,
    signal?: AbortSignal,
    workspace?: WorkspaceIdentity,
  ): Promise<AgentSessionV2> {
    this.prune();
    const executionId = randomUUID();
    const turnId = randomUUID();
    const session = interactive
      ? await this.sessions.createInteractive(
          input.provider,
          input.cwd,
          input.prompt,
          selection,
          transport,
          executionId,
          turnId,
          signal,
          workspace,
        )
      : this.sessions.create(input.provider, input.cwd, input.prompt, undefined, 2, workspace);
    const metadata: V2SessionMetadata = {
      selection,
      executionId,
      turnId,
      events: new Map(),
      listeners: new Set(),
      replayBytes: 0,
      nextSequence: 0,
      nativeTools: new Map(),
      interactive,
      status: v2Status(session.status),
      pendingInteractions: new Map(),
    };
    this.metadata.set(session.id, metadata);
    if (interactive) this.attachInteractiveSource(session.id, metadata);
    else this.attachSource(session.id, metadata);
    return this.project(session) as AgentSessionV2;
  }

  get(id: string): AgentSessionV2 | undefined {
    this.prune();
    const session = this.sessions.get(id, 2);
    return session && this.metadata.has(id) ? this.project(session) : undefined;
  }

  hasCapability(id: string, capabilityId: string): boolean {
    const metadata = this.metadata.get(id);
    return metadata?.selection.enabled.some((entry) => entry.id === capabilityId) ?? false;
  }

  isActive(id: string): boolean {
    const status = this.metadata.get(id)?.status;
    return status === 'starting' || status === 'active' || status === 'idle';
  }

  dispatch(command: AgentCommandV2): Promise<DispatchResult> {
    const metadata = this.metadata.get(command.sessionId);
    if (!metadata) {
      return Promise.resolve({
        ok: false,
        code: 'session_not_found',
        message: 'session not found',
      });
    }
    const capability = this.commandCapability(command);
    if (!this.hasCapability(command.sessionId, capability)) {
      return this.sessions.dispatch(command.sessionId, command, 'session_not_capable');
    }
    if (!this.commandMatchesSelection(metadata, capability, command)) {
      return this.sessions.dispatch(command.sessionId, command, 'command_out_of_bounds');
    }
    if (!this.commandMatchesState(metadata, command)) {
      return this.sessions.dispatch(
        command.sessionId,
        command,
        command.type === 'approval.respond' || command.type === 'question.respond'
          ? 'stale_interaction'
          : 'session_terminal',
      );
    }
    return this.sessions.dispatch(command.sessionId, command);
  }

  replayWindow(id: string): { earliestSequence: number; nextSequence: number } | undefined {
    const metadata = this.metadata.get(id);
    if (!metadata) return undefined;
    return {
      earliestSequence: metadata.events.keys().next().value ?? metadata.nextSequence,
      nextSequence: metadata.nextSequence,
    };
  }

  async cancel(id: string): Promise<boolean> {
    if (!this.metadata.has(id)) return false;
    return this.sessions.cancel(id, 2);
  }

  async remove(id: string): Promise<boolean> {
    if (!this.metadata.has(id)) return false;
    const removed = await this.sessions.remove(id, 2);
    if (removed) {
      const metadata = this.metadata.get(id);
      metadata?.sourceUnsubscribe?.();
      this.metadata.delete(id);
    }
    return removed;
  }

  /** Replays the bounded normalized v2 window, then delivers live normalized events. */
  subscribe(
    id: string,
    sinceSequence: number,
    listener: (sequence: number, event: AgentEventV2Envelope) => void,
  ): (() => void) | undefined {
    const metadata = this.metadata.get(id);
    if (!metadata) return undefined;
    for (const [sequence, stored] of metadata.events) {
      if (sequence >= sinceSequence) listener(sequence, stored.event);
    }
    metadata.listeners.add(listener);
    return () => metadata.listeners.delete(listener);
  }

  claimResponder(id: string): string | undefined {
    const metadata = this.metadata.get(id);
    if (!metadata || metadata.responderLease) return undefined;
    const lease = randomBytes(32).toString('base64url');
    metadata.responderLease = lease;
    return lease;
  }

  hasResponderLease(id: string, candidate: string | undefined): boolean {
    const metadata = this.metadata.get(id);
    const lease = metadata?.responderLease;
    if (!lease || !candidate || !RESPONDER_LEASE_PATTERN.test(candidate)) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(lease));
  }

  releaseResponder(id: string, lease: string): void {
    const metadata = this.metadata.get(id);
    if (!metadata || !this.hasResponderLease(id, lease)) return;
    delete metadata.responderLease;
    void this.sessions.responderDisconnected(id);
  }

  markInteractionPublished(id: string, requestId: string): boolean {
    return this.sessions.markInteractionPublished(id, requestId);
  }

  private project(session: AgentSession): AgentSessionV2 {
    const metadata = this.metadata.get(session.id);
    if (!metadata) throw new Error(`missing v2 metadata for session: ${session.id}`);
    return agentSessionV2Schema.parse({
      id: session.id,
      provider: session.provider,
      transport: metadata.selection.transport,
      cwd: session.cwd,
      status: metadata.status,
      selection: metadata.selection,
      executionId: metadata.executionId,
      currentTurnId: metadata.turnId,
      acceptedWork: metadata.interactive ? this.sessions.acceptedWork(session.id) : 'unknown',
      startedAt: session.startedAt,
      ...(session.completedAt === undefined ? {} : { completedAt: session.completedAt }),
      ...(session.error === undefined ? {} : { error: session.error }),
      earliestSequence: this.replayWindow(session.id)?.earliestSequence ?? 0,
    }) as AgentSessionV2;
  }

  private attachSource(id: string, metadata: V2SessionMetadata): void {
    let ended = false;
    let unsubscribe: (() => void) | undefined;
    // eslint-disable-next-line prefer-const
    unsubscribe = this.sessions.subscribe(
      id,
      0,
      (_sourceSequence, sourceEvent) => {
        for (const event of this.convert(id, metadata, sourceEvent)) {
          this.publish(metadata, event);
          if (isTerminal(event)) {
            ended = true;
            metadata.sourceUnsubscribe?.();
            metadata.sourceUnsubscribe = undefined;
          }
        }
      },
      2,
    );
    if (!unsubscribe) throw new Error(`missing v2 runtime for session: ${id}`);
    metadata.sourceUnsubscribe = unsubscribe;
    if (ended) {
      unsubscribe();
      metadata.sourceUnsubscribe = undefined;
    }
  }

  private attachInteractiveSource(id: string, metadata: V2SessionMetadata): void {
    let ended = false;
    let unsubscribe: (() => void) | undefined;
    // eslint-disable-next-line prefer-const
    unsubscribe = this.sessions.subscribeInteractive(id, 0, (sourceIndex, sourceEvent) => {
      const session = this.sessions.get(id, 2);
      if (!session) return;
      const event = agentEventV2EnvelopeSchema.parse({
        ...(sourceEvent.type === 'session.started'
          ? {
              ...sourceEvent,
              provider: session.provider,
              transport: metadata.selection.transport,
              selection: metadata.selection,
            }
          : sourceEvent),
        sessionId: id,
        executionId: metadata.executionId,
        // SessionManager indices remain absolute across its own sliding retention window. If a
        // provider burst raced creation, preserve that gap instead of renumbering retained events.
        sequence: sourceIndex,
        timestamp: new Date().toISOString(),
      });
      this.publish(metadata, event);
      if (isTerminal(event)) {
        ended = true;
        metadata.sourceUnsubscribe?.();
        metadata.sourceUnsubscribe = undefined;
      }
    });
    if (!unsubscribe) throw new Error(`missing interactive v2 runtime for session: ${id}`);
    metadata.sourceUnsubscribe = unsubscribe;
    if (ended) {
      unsubscribe();
      metadata.sourceUnsubscribe = undefined;
    }
  }

  private publish(metadata: V2SessionMetadata, event: AgentEventV2Envelope): void {
    this.record(metadata, event);
    for (const listener of [...metadata.listeners]) {
      try {
        listener(event.sequence, event);
      } catch {
        // A subscriber owns only its connection. It cannot fail provider consumption or peers.
      }
    }
  }

  private record(metadata: V2SessionMetadata, event: AgentEventV2Envelope): void {
    const bytes = utf8ByteLength(JSON.stringify(event));
    while (
      metadata.events.size > 0 &&
      (metadata.events.size >= MAX_REPLAY_EVENTS || metadata.replayBytes + bytes > MAX_REPLAY_BYTES)
    ) {
      const oldestSequence = metadata.events.keys().next().value as number;
      const oldest = metadata.events.get(oldestSequence);
      metadata.events.delete(oldestSequence);
      metadata.replayBytes -= oldest?.bytes ?? 0;
    }
    metadata.events.set(event.sequence, { event, bytes });
    metadata.replayBytes += bytes;
    metadata.nextSequence = event.sequence + 1;
    this.applyEventState(metadata, event);
  }

  private applyEventState(metadata: V2SessionMetadata, event: AgentEventV2Envelope): void {
    switch (event.type) {
      case 'session.status':
        metadata.status = event.status;
        break;
      case 'session.completed':
        metadata.status = 'completed';
        break;
      case 'session.failed':
        metadata.status = 'failed';
        break;
      case 'session.cancelled':
        metadata.status = 'cancelled';
        break;
      case 'session.interrupted':
        metadata.status = 'interrupted';
        break;
      case 'turn.started':
        metadata.turnId = event.turnId;
        metadata.status = 'active';
        break;
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.interrupted':
        metadata.status = 'idle';
        break;
      case 'approval.requested':
        metadata.pendingInteractions.set(event.requestId, {
          kind: 'approval',
          turnId: event.turnId,
        });
        break;
      case 'question.requested':
        metadata.pendingInteractions.set(event.requestId, {
          kind: 'question',
          turnId: event.turnId,
        });
        break;
      case 'approval.resolved':
      case 'question.resolved':
      case 'question.cancelled':
        metadata.pendingInteractions.delete(event.requestId);
        break;
      default:
        break;
    }
  }

  private commandCapability(command: AgentCommandV2): string {
    switch (command.type) {
      case 'input.follow_up':
        return 'session.input.follow_up';
      case 'input.steer':
        return 'session.input.steer';
      case 'session.interrupt':
        return 'session.interrupt';
      case 'approval.respond':
        return 'interaction.approval';
      case 'question.respond':
        return 'interaction.question';
    }
  }

  private commandMatchesSelection(
    metadata: V2SessionMetadata,
    capabilityId: string,
    command: AgentCommandV2,
  ): boolean {
    const constraints = metadata.selection.enabled.find(
      (entry) => entry.id === capabilityId,
    )?.constraints;
    if (!constraints) return false;
    if (command.type === 'input.follow_up' || command.type === 'input.steer') {
      if (constraints.kind !== 'text_input') return false;
      let characters = 0;
      for (const block of command.content) {
        if (block.type === 'text') characters += block.text.length;
        else if (block.type === 'image' || block.type === 'file') {
          if (!constraints.attachmentKinds.includes(block.type)) return false;
        } else characters += JSON.stringify(block.data).length;
      }
      return characters <= constraints.maxCharacters;
    }
    if (command.type === 'approval.respond' || command.type === 'question.respond') {
      return (
        constraints.kind === 'interaction' &&
        utf8ByteLength(JSON.stringify(command)) <= constraints.maxPayloadBytes
      );
    }
    return constraints.kind === 'acknowledgement';
  }

  private commandMatchesState(metadata: V2SessionMetadata, command: AgentCommandV2): boolean {
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(metadata.status)) return false;
    switch (command.type) {
      case 'input.follow_up':
        return metadata.status === 'idle';
      case 'input.steer':
      case 'session.interrupt':
        return metadata.status === 'active' && metadata.turnId === command.turnId;
      case 'approval.respond':
      case 'question.respond':
        // The supervisor owns the atomic interaction tuple. Let an identical post-resolution
        // retry reach SessionManager's command ledger; a new stale id reaches the supervisor and
        // deterministically returns stale_interaction without provider redispatch.
        return true;
    }
  }

  private convert(
    id: string,
    metadata: V2SessionMetadata,
    event: AgentEventEnvelope,
  ): AgentEventV2Envelope[] {
    const common = {
      sessionId: id,
      executionId: metadata.executionId,
      sequence: metadata.nextSequence,
      timestamp: event.timestamp,
    };
    const turn = { turnId: metadata.turnId };
    const selected = (capabilityId: string) =>
      metadata.selection.enabled.some((entry) => entry.id === capabilityId);
    let converted: unknown;

    switch (event.type) {
      case 'session.started':
        converted = {
          ...common,
          type: 'session.started',
          provider: event.provider,
          transport: metadata.selection.transport,
          selection: metadata.selection,
        };
        break;
      case 'status':
        converted = { ...common, type: 'session.status', status: 'active' };
        break;
      case 'assistant.message':
        converted =
          utf8ByteLength(event.text) <= MAX_CONTENT_BYTES
            ? {
                ...common,
                ...turn,
                type: 'content.completed',
                block: { type: 'text', id: randomUUID(), text: event.text },
              }
            : this.extensionSummary(
                common,
                turn,
                'legacy.assistant.message',
                'assistant message exceeded the v2 content-block limit',
                'truncated',
              );
        break;
      case 'thinking.delta':
        // V1 has no stable content-block boundary for thinking deltas, so a core content.delta
        // would invent correlation that cannot ever be completed reliably.
        converted = this.extensionSummary(
          common,
          turn,
          'legacy.thinking',
          'legacy thinking observation has no stable v2 content-block correlation',
          selected('content.thinking') ? 'unsupported' : 'capability_drift',
        );
        break;
      case 'tool.started':
        converted =
          this.canEmitLegacyTool(metadata) &&
          event.toolCallId &&
          event.toolName.length > 0 &&
          utf8ByteLength(event.toolName) <= MAX_WIRE_STRING_BYTES
            ? this.toolStarted(common, turn, metadata, event)
            : this.extensionSummary(
                common,
                turn,
                'legacy.tool.started',
                event.toolCallId
                  ? `tool effects exceed the selected legacy observation subset: ${event.toolName}`
                  : `tool start had no stable correlation id: ${event.toolName}`,
                event.toolCallId ? 'capability_drift' : 'unsupported',
              );
        break;
      case 'tool.completed':
        converted =
          this.canEmitLegacyTool(metadata) && event.toolCallId
            ? this.toolCompleted(common, turn, metadata, event)
            : this.extensionSummary(
                common,
                turn,
                'legacy.tool.completed',
                event.toolCallId
                  ? `tool effects exceed the selected legacy observation subset: ${event.toolName ?? 'unknown tool'}`
                  : `tool completion had no stable correlation id: ${event.toolName ?? 'unknown tool'}`,
                event.toolCallId ? 'capability_drift' : 'unsupported',
              );
        break;
      case 'usage':
        converted =
          !validTokenCount(event.inputTokens) ||
          !validTokenCount(event.outputTokens) ||
          !validTokenCount(event.cachedInputTokens)
            ? this.extensionSummary(
                common,
                turn,
                'legacy.usage',
                'usage frame contained invalid token counts',
                'unsupported',
              )
            : selected('content.usage.tokens') &&
                (event.inputTokens !== undefined ||
                  event.outputTokens !== undefined ||
                  event.cachedInputTokens !== undefined)
              ? {
                  ...common,
                  ...turn,
                  type: 'usage.tokens',
                  scope: 'turn',
                  ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
                  ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
                  ...(event.cachedInputTokens === undefined
                    ? {}
                    : { cachedInputTokens: event.cachedInputTokens }),
                }
              : this.extensionSummary(
                  common,
                  turn,
                  event.cost === undefined ? 'legacy.usage' : 'legacy.usage.cost',
                  event.cost === undefined
                    ? 'unselected usage observation'
                    : 'usage frame contained cost data without selected token data',
                  'capability_drift',
                );
        break;
      case 'error':
        converted = {
          ...common,
          ...turn,
          type: 'error',
          ...(event.code === undefined
            ? {}
            : { code: truncateUtf8(event.code, MAX_WIRE_STRING_BYTES) || 'legacy_error' }),
          message: truncateUtf8(event.message, MAX_CONTENT_BYTES),
          recoverable: event.recoverable,
        };
        break;
      case 'session.completed':
        converted = { ...common, type: 'session.completed' };
        break;
      case 'session.failed':
        converted = {
          ...common,
          type: 'session.failed',
          message: truncateUtf8(event.message, MAX_CONTENT_BYTES),
        };
        break;
      case 'session.cancelled':
        converted = { ...common, type: 'session.cancelled' };
        break;
    }

    const primary = agentEventV2EnvelopeSchema.parse(converted);
    if (event.type === 'usage' && event.cost !== undefined && primary.type === 'usage.tokens') {
      const costSummary = agentEventV2EnvelopeSchema.parse(
        this.extensionSummary(
          { ...common, sequence: primary.sequence + 1 },
          turn,
          'legacy.usage.cost',
          'legacy usage included cost without a trustworthy currency',
          'capability_drift',
        ),
      );
      return [primary, costSummary];
    }
    return [primary];
  }

  private toolStarted(
    common: Record<string, unknown>,
    turn: { turnId: string },
    metadata: V2SessionMetadata,
    event: Extract<AgentEventEnvelope, { type: 'tool.started' }>,
  ): unknown {
    const correlation: ToolCorrelation = {
      toolCallId: randomUUID(),
      contentBlockId: randomUUID(),
      toolName: event.toolName,
    };
    metadata.nativeTools.set(event.toolCallId as string, correlation);
    return {
      ...common,
      ...turn,
      type: 'tool.started',
      ...correlation,
      possibleEffects: [
        'read',
        'filesystem_write',
        'command',
        'network',
        'external_side_effect',
        'destructive',
      ],
      effectsComplete: false,
    };
  }

  private toolCompleted(
    common: Record<string, unknown>,
    turn: { turnId: string },
    metadata: V2SessionMetadata,
    event: Extract<AgentEventEnvelope, { type: 'tool.completed' }>,
  ): unknown {
    const correlation = event.toolCallId ? metadata.nativeTools.get(event.toolCallId) : undefined;
    if (!correlation) {
      return this.extensionSummary(
        common,
        turn,
        'legacy.tool.completed',
        `tool completion had no stable correlation: ${event.toolName ?? 'unknown tool'}`,
        'unsupported',
      );
    }
    metadata.nativeTools.delete(event.toolCallId as string);
    return {
      ...common,
      ...turn,
      type: 'tool.completed',
      ...correlation,
      status: event.isError ? 'failed' : 'completed',
      summary: event.isError ? 'Tool reported an error' : 'Tool completed',
    };
  }

  private canEmitLegacyTool(metadata: V2SessionMetadata): boolean {
    const selected = metadata.selection.enabled.find((entry) => entry.id === 'content.tools');
    const constraints = selected?.constraints;
    return (
      constraints?.kind === 'effects' &&
      ALL_EFFECTS.every((effect) => constraints.allowedEffects.includes(effect))
    );
  }

  private extensionSummary(
    common: Record<string, unknown>,
    turn: { turnId: string },
    extensionName: string,
    summary: string,
    reason: 'unsupported' | 'capability_drift' | 'truncated',
  ): unknown {
    return {
      ...common,
      ...turn,
      type: 'extension.summary',
      extensionName,
      summary: boundedSummary(summary),
      reason,
    };
  }

  private prune(): void {
    const retained = new Set(this.sessions.list(2).map((session) => session.id));
    for (const [id, metadata] of this.metadata) {
      if (!retained.has(id)) {
        metadata.sourceUnsubscribe?.();
        this.metadata.delete(id);
      }
    }
  }
}
