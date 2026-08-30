import { randomUUID } from 'node:crypto';
import {
  agentEventV2EnvelopeSchema,
  agentSessionV2Schema,
  utf8ByteLength,
  type AgentEventEnvelope,
  type AgentEventV2Envelope,
  type AgentSession,
  type AgentSessionV2,
  type CapabilitySelection,
  type CreateSessionV2Request,
} from '@agent-dock/shared';
import type { SessionManager } from './session-manager.js';

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

  create(input: CreateSessionV2Request, selection: CapabilitySelection): AgentSessionV2 {
    this.prune();
    const session = this.sessions.create(input.provider, input.cwd, input.prompt, undefined, 2);
    const metadata: V2SessionMetadata = {
      selection,
      executionId: randomUUID(),
      turnId: randomUUID(),
      events: new Map(),
      listeners: new Set(),
      replayBytes: 0,
      nextSequence: 0,
      nativeTools: new Map(),
    };
    this.metadata.set(session.id, metadata);
    this.attachSource(session.id, metadata);
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
    const session = this.sessions.get(id, 2);
    return session?.status === 'starting' || session?.status === 'running';
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

  private project(session: AgentSession): AgentSessionV2 {
    const metadata = this.metadata.get(session.id);
    if (!metadata) throw new Error(`missing v2 metadata for session: ${session.id}`);
    return agentSessionV2Schema.parse({
      id: session.id,
      provider: session.provider,
      transport: metadata.selection.transport,
      cwd: session.cwd,
      status: v2Status(session.status),
      selection: metadata.selection,
      executionId: metadata.executionId,
      currentTurnId: metadata.turnId,
      // The legacy runner cannot distinguish pre-spawn failure from accepted work. Unknown is the
      // only truthful, fail-closed value until #7 adds an explicit accepted-work boundary.
      acceptedWork: 'unknown',
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
          this.record(metadata, event);
          for (const listener of [...metadata.listeners]) listener(event.sequence, event);
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
