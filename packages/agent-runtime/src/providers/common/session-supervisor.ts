import { createHash } from 'node:crypto';
import {
  agentEventV2EnvelopeSchema,
  utf8ByteLength,
  type AgentCommandV2,
  type AgentEventV2,
  type ApprovalResponseCommandV2,
  type QuestionResponseCommandV2,
} from '@agent-dock/shared';
import { AsyncChannel } from '../../process/async-channel.js';
import type {
  AcceptedWorkState,
  InteractiveProviderSessionHandle,
  InteractiveProviderTransport,
  ProviderInteractionResolution,
  StartInteractiveSessionOptions,
} from '../../types.js';

const MAX_PROVIDER_FRAME_BYTES = 1024 * 1024;
const MAX_PROVIDER_FRAME_DEPTH = 16;
const MAX_PROVIDER_FRAME_ITEMS = 1_024;
const MAX_NORMALIZED_EVENT_BYTES = 1024 * 1024;
const MAX_PROVIDER_QUEUE_EVENTS = 5_000;
const MAX_PROVIDER_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_CONTENT_BLOCK_BYTES = 256 * 1024;
const MAX_TRACKED_CONTENT_BLOCKS = 10_000;
const MAX_TRACKED_TURN_IDS = 10_000;
const MAX_PENDING_INTERACTIONS = 32;
const MAX_RESOLVED_INTERACTIONS = 1_024;
const MAX_STDERR_BYTES = 200_000;
const MAX_FAILURE_MESSAGE_BYTES = 4 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_INTERACTION_TIMEOUT_MS = 300_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

type InteractionRecord =
  | {
      kind: 'approval';
      requestId: string;
      turnId: string;
      timer?: ReturnType<typeof setTimeout>;
    }
  | {
      kind: 'question';
      requestId: string;
      turnId: string;
      timer?: ReturnType<typeof setTimeout>;
    };

interface QueuedSupervisorEvent {
  event: AgentEventV2;
  bytes: number;
  counted: boolean;
}

interface ActiveContentBlock {
  bytes: number;
  hash: ReturnType<typeof createHash>;
}

interface BoundedProviderEvent {
  event: Record<string, unknown>;
  oversizedDelta?: Buffer;
}

interface ParsedProviderEvent {
  event: AgentEventV2;
  oversizedDelta?: Buffer;
}

export type InteractiveSessionErrorCode =
  | 'command_rejected'
  | 'command_timeout'
  | 'event_too_large'
  | 'provider_correlation_error'
  | 'provider_crash'
  | 'provider_capability_violation'
  | 'provider_disconnected'
  | 'provider_frame_invalid'
  | 'provider_frame_too_large'
  | 'provider_force_close_failed'
  | 'provider_queue_overflow'
  | 'session_aborted'
  | 'session_terminal'
  | 'stale_interaction';

export class InteractiveSessionError extends Error {
  constructor(
    readonly code: InteractiveSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InteractiveSessionError';
  }
}

export interface SessionSupervisorOptions {
  commandTimeoutMs?: number;
  interactionTimeoutMs?: number;
  closeTimeoutMs?: number;
}

function isTerminal(event: AgentEventV2): boolean {
  return (
    event.type === 'session.completed' ||
    event.type === 'session.failed' ||
    event.type === 'session.cancelled' ||
    event.type === 'session.interrupted'
  );
}

function isInteractionResolutionEvent(
  event: AgentEventV2,
): event is Extract<
  AgentEventV2,
  { type: 'approval.resolved' | 'question.resolved' | 'question.cancelled' }
> {
  return (
    event.type === 'approval.resolved' ||
    event.type === 'question.resolved' ||
    event.type === 'question.cancelled'
  );
}

function eventCode(error: unknown): string | undefined {
  return error instanceof InteractiveSessionError ? error.code : undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString('utf8');
}

function timeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: InteractiveSessionErrorCode,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new InteractiveSessionError(code, code.replaceAll('_', ' '))),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function abortError(): InteractiveSessionError {
  return new InteractiveSessionError('session_aborted', 'session startup was aborted');
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      cleanup();
      reject(abortError());
    };
    const cleanup = (): void => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function stopTransportBounded(
  transport: InteractiveProviderTransport,
  closeTimeoutMs: number,
): Promise<void> {
  try {
    await timeout(transport.close(), closeTimeoutMs, 'provider_crash');
    return;
  } catch {
    // A graceful close is advisory. Only the mandatory hard-stop contract may recover it.
  }
  try {
    await timeout(transport.forceClose(), closeTimeoutMs, 'provider_force_close_failed');
  } catch {
    throw new InteractiveSessionError(
      'provider_force_close_failed',
      'provider process tree could not be confirmed reaped',
    );
  }
}

interface FrameMeasureState {
  bytes: number;
  items: number;
  active: WeakSet<object>;
}

function addFrameBytes(state: FrameMeasureState, bytes: number): void {
  state.bytes += bytes;
  if (state.bytes > MAX_PROVIDER_FRAME_BYTES) {
    throw new InteractiveSessionError('provider_frame_too_large', 'provider frame exceeded 1 MiB');
  }
}

function measureJsonString(value: string, state: FrameMeasureState): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_PROVIDER_FRAME_BYTES) {
    throw new InteractiveSessionError('provider_frame_too_large', 'provider frame exceeded 1 MiB');
  }
  addFrameBytes(state, 2);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      addFrameBytes(state, 2);
    } else if (code <= 0x1f) {
      addFrameBytes(state, 6);
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        addFrameBytes(state, 4);
        index += 1;
      } else {
        addFrameBytes(state, 6);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      addFrameBytes(state, 6);
    } else {
      addFrameBytes(state, code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3);
    }
  }
}

function measureJsonValue(value: unknown, state: FrameMeasureState, depth: number): void {
  if (depth > MAX_PROVIDER_FRAME_DEPTH) {
    throw new InteractiveSessionError(
      'provider_frame_invalid',
      'provider frame nesting is too deep',
    );
  }
  if (value === null) {
    addFrameBytes(state, 4);
    return;
  }
  if (typeof value === 'string') {
    measureJsonString(value, state);
    return;
  }
  if (typeof value === 'boolean') {
    addFrameBytes(state, value ? 4 : 5);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InteractiveSessionError(
        'provider_frame_invalid',
        'provider frame number is invalid',
      );
    }
    addFrameBytes(state, String(value).length);
    return;
  }
  if (typeof value !== 'object') {
    throw new InteractiveSessionError('provider_frame_invalid', 'provider frame is not JSON data');
  }
  if (state.active.has(value)) {
    throw new InteractiveSessionError('provider_frame_invalid', 'provider frame is cyclic');
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      state.items += value.length;
      if (state.items > MAX_PROVIDER_FRAME_ITEMS) {
        throw new InteractiveSessionError(
          'provider_frame_invalid',
          'provider frame has too many items',
        );
      }
      addFrameBytes(state, 2 + Math.max(0, value.length - 1));
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new InteractiveSessionError(
            'provider_frame_invalid',
            'provider frame array is sparse',
          );
        }
        measureJsonValue(value[index], state, depth + 1);
      }
      return;
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new InteractiveSessionError(
        'provider_frame_invalid',
        'provider frame object is not plain',
      );
    }
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length) {
      throw new InteractiveSessionError('provider_frame_invalid', 'provider frame has hidden keys');
    }
    state.items += keys.length;
    if (state.items > MAX_PROVIDER_FRAME_ITEMS) {
      throw new InteractiveSessionError(
        'provider_frame_invalid',
        'provider frame has too many items',
      );
    }
    addFrameBytes(state, 2 + Math.max(0, keys.length - 1) + keys.length);
    for (const key of keys) {
      measureJsonString(key, state);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new InteractiveSessionError('provider_frame_invalid', 'provider frame has accessors');
      }
      measureJsonValue(descriptor.value, state, depth + 1);
    }
  } finally {
    state.active.delete(value);
  }
}

function parseJsonFrame(encoded: string): unknown {
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PROVIDER_FRAME_BYTES) {
    throw new InteractiveSessionError('provider_frame_too_large', 'provider frame exceeded 1 MiB');
  }
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new InteractiveSessionError('provider_frame_invalid', 'provider frame is not valid JSON');
  }
}

function frameValue(raw: unknown): unknown {
  if (typeof raw === 'string') return parseJsonFrame(raw);
  if (raw instanceof Uint8Array) {
    if (raw.byteLength > MAX_PROVIDER_FRAME_BYTES) {
      throw new InteractiveSessionError(
        'provider_frame_too_large',
        'provider frame exceeded 1 MiB',
      );
    }
    try {
      return parseJsonFrame(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch (error) {
      if (error instanceof InteractiveSessionError) throw error;
      throw new InteractiveSessionError(
        'provider_frame_invalid',
        'provider frame is not valid UTF-8',
      );
    }
  }
  measureJsonValue(raw, { bytes: 0, items: 0, active: new WeakSet<object>() }, 0);
  return raw;
}

function truncateOversizedContent(event: Record<string, unknown>): BoundedProviderEvent {
  const content = event.type === 'content.completed' ? event.block : event.delta;
  if (event.type !== 'content.completed' && event.type !== 'content.delta') {
    return { event };
  }
  const serialized = typeof content === 'string' ? content : JSON.stringify(content);
  if (serialized === undefined) {
    throw new InteractiveSessionError(
      'provider_frame_invalid',
      'provider content is not JSON data',
    );
  }
  const encoded = Buffer.from(serialized);
  if (encoded.byteLength <= MAX_CONTENT_BLOCK_BYTES) return { event };
  const contentBlockId =
    event.type === 'content.delta' ? event.contentBlockId : (content as Record<string, unknown>).id;
  return {
    event: {
      type: 'content.completed',
      turnId: event.turnId,
      block: {
        type: 'provider_extension',
        id: contentBlockId,
        extensionName: `provider.${event.type}`,
        representation: 'safe_summary',
        safeSummary: 'provider content exceeded the 256 KiB content-block limit',
        reason: 'truncated',
        originalBytes: encoded.byteLength,
        sha256: createHash('sha256').update(encoded).digest('hex'),
      },
    },
    oversizedDelta: event.type === 'content.delta' ? encoded : undefined,
  };
}

function parseProviderEvent(
  raw: unknown,
  options: StartInteractiveSessionOptions,
): ParsedProviderEvent {
  const value = frameValue(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InteractiveSessionError('provider_frame_invalid', 'provider event must be an object');
  }
  const {
    sessionId: _providerSessionId,
    executionId: _providerExecutionId,
    parentExecutionId: _providerParentExecutionId,
    sequence: _providerSequence,
    timestamp: _providerTimestamp,
    ...providerEvent
  } = value as Record<string, unknown>;
  const boundedProviderEvent = truncateOversizedContent(providerEvent);
  const candidate = {
    ...boundedProviderEvent.event,
    sessionId: options.sessionId,
    executionId: options.executionId,
    sequence: 0,
    timestamp: new Date().toISOString(),
  };
  if (utf8ByteLength(JSON.stringify(candidate)) > MAX_NORMALIZED_EVENT_BYTES) {
    throw new InteractiveSessionError(
      'event_too_large',
      'normalized provider event exceeded 1 MiB',
    );
  }
  const parsed = agentEventV2EnvelopeSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new InteractiveSessionError('provider_frame_invalid', 'provider event failed validation');
  }
  const {
    sessionId: _sessionId,
    executionId: _executionId,
    parentExecutionId: _parentExecutionId,
    sequence: _sequence,
    timestamp: _timestamp,
    ...event
  } = parsed.data;
  return { event: event as AgentEventV2, oversizedDelta: boundedProviderEvent.oversizedDelta };
}

class SessionSupervisor implements InteractiveProviderSessionHandle {
  private readonly output = new AsyncChannel<QueuedSupervisorEvent>(MAX_PROVIDER_QUEUE_EVENTS);
  private readonly mandatoryFinalEvents: AgentEventV2[] = [];
  private readonly mandatoryFinalEventKeys = new Set<string>();
  private readonly interactions = new Map<string, InteractionRecord>();
  private readonly resolvingInteractions = new Map<string, InteractionRecord>();
  private readonly resolvedInteractions = new Map<
    string,
    Pick<InteractionRecord, 'kind' | 'requestId' | 'turnId'>
  >();
  private bufferedEvents = 0;
  private bufferedBytes = 0;
  private stderrBuffer = '';
  private stderrBytes = 0;
  private sessionStarted = false;
  private providerStatus: 'starting' | 'active' | 'idle' = 'starting';
  private activeTurnId: string | undefined;
  private lastTurnId: string | undefined;
  private readonly expectedTurnIds = new Set<string>();
  private readonly seenTurnIds = new Set<string>();
  private readonly activeContentBlocks = new Map<string, ActiveContentBlock>();
  private readonly completedContentBlocks = new Map<string, 'provider' | 'truncated'>();
  private readonly idleWaiters = new Set<(idle: boolean) => void>();
  private overflowRecovery: Promise<void> | undefined;
  private terminal = false;
  private closing: Promise<void> | undefined;
  private failing: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private readonly commandTimeoutMs: number;
  private readonly interactionTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly abortListener = (): void => void this.close();
  readonly events = this.readEvents();
  readonly accepted: Promise<AcceptedWorkState>;

  constructor(
    private readonly transport: InteractiveProviderTransport,
    private readonly options: StartInteractiveSessionOptions,
    limits: SessionSupervisorOptions,
  ) {
    this.commandTimeoutMs = limits.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.interactionTimeoutMs = limits.interactionTimeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS;
    this.closeTimeoutMs = limits.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.expectedTurnIds.add(options.turnId);
    this.accepted = this.watchAcceptedWork();
    void this.consume();
    void this.consumeStderr().catch((error: unknown) =>
      this.fail(
        'provider_crash',
        error instanceof Error ? error.message : 'provider stderr stream failed',
      ),
    );
    if (options.signal?.aborted) this.abortListener();
    else options.signal?.addEventListener('abort', this.abortListener, { once: true });
  }

  private async watchAcceptedWork(): Promise<AcceptedWorkState> {
    try {
      return await withAbort(
        timeout(this.transport.accepted, this.commandTimeoutMs, 'command_timeout'),
        this.options.signal,
      );
    } catch (error) {
      if (error instanceof InteractiveSessionError && error.code === 'session_aborted') {
        await this.close();
        return 'unknown';
      }
      await this.fail(
        eventCode(error) ?? 'provider_crash',
        error instanceof Error ? error.message : 'provider acceptance failed',
      );
      return 'unknown';
    }
  }

  private async *readEvents(): AsyncGenerator<AgentEventV2, void, void> {
    for await (const queued of this.output) {
      if (queued.counted) {
        this.bufferedEvents -= 1;
        this.bufferedBytes -= queued.bytes;
      }
      yield queued.event;
    }
  }

  async send(command: AgentCommandV2): Promise<void> {
    this.assertOpen();
    this.assertInteractionAvailable(command);
    this.assertCommandState(command);
    if (command.type === 'input.follow_up') this.expectedTurnIds.add(command.turnId);
    const interaction = this.takeInteraction(command);
    try {
      await timeout(this.transport.send(command), this.commandTimeoutMs, 'command_timeout');
      if (
        interaction &&
        (command.type === 'approval.respond' || command.type === 'question.respond')
      ) {
        if (this.resolvingInteractions.get(interaction.requestId) === interaction) {
          this.resolvingInteractions.delete(interaction.requestId);
          this.rememberResolved(interaction);
          this.publishInteractionResolution(interaction, command);
        } else if (this.terminal || this.closing || this.failing) {
          throw new InteractiveSessionError('session_terminal', 'session became terminal');
        }
      }
    } catch (error) {
      if (interaction && this.resolvingInteractions.get(interaction.requestId) === interaction) {
        this.resolvingInteractions.delete(interaction.requestId);
        this.rememberResolved(interaction);
        this.publishSafeResolution(interaction, 'disconnect');
      }
      await this.fail(
        eventCode(error) ?? 'provider_crash',
        error instanceof Error ? error.message : 'provider command failed',
      );
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    this.assertOpen();
    if (this.providerStatus !== 'active' || this.activeTurnId === undefined) {
      throw new InteractiveSessionError('command_rejected', 'interrupt requires an active turn');
    }
    if (this.overflowRecovery) {
      throw new InteractiveSessionError('command_rejected', 'turn interruption is already pending');
    }
    const interactions = this.takeAllInteractions();
    try {
      await this.resolveInteractions(interactions, 'interrupt', true);
      this.assertOpen();
      await this.interruptAndConfirmIdle();
    } catch (error) {
      await this.fail(
        eventCode(error) ?? 'provider_crash',
        error instanceof Error ? error.message : 'provider interrupt failed',
      );
      throw error;
    }
  }

  async resolveInteraction(
    requestId: string,
    reason:
      'cancel' | 'disconnect' | 'interrupt' | 'overflow' | 'shutdown' | 'timeout' | 'trust_revoked',
  ): Promise<void> {
    this.assertOpen();
    const record = this.interactions.get(requestId);
    if (!record) {
      throw new InteractiveSessionError(
        'stale_interaction',
        'interaction is stale or belongs to another turn',
      );
    }
    this.interactions.delete(requestId);
    const records =
      record.kind === 'question'
        ? [record, ...this.takePendingTurnInteractions(record.turnId)]
        : [record];
    try {
      // This public boundary is used for daemon/responder loss, not provider transport loss. The
      // provider is still live and must receive the fail-closed denial/cancellation.
      await this.resolveInteractions(records, reason, true);
      if (
        record.kind === 'question' &&
        reason !== 'interrupt' &&
        !this.terminal &&
        !this.closing &&
        !this.failing
      ) {
        await this.interruptAndConfirmIdle();
      }
    } catch (error) {
      await this.fail(
        eventCode(error) ?? 'provider_crash',
        'provider interaction resolution failed',
      );
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.failing) return this.failing;
    if (this.closing) return this.closing;
    if (this.terminal) return;
    this.closing = Promise.resolve().then(() => this.closeSession());
    return this.closing;
  }

  private async closeSession(): Promise<void> {
    const interactions = this.takeAllInteractions();
    await this.resolveInteractions(interactions, 'cancel', true, this.closeTimeoutMs).catch(
      () => undefined,
    );
    try {
      await this.stopTransport();
      if (!this.terminal) {
        this.terminal = true;
        this.closeOutput([{ type: 'session.cancelled', reason: 'session closed' }]);
      }
    } catch (error) {
      this.finishFailure(
        eventCode(error) ?? 'provider_force_close_failed',
        error instanceof Error ? error.message : 'provider process tree was not reaped',
      );
    }
  }

  private async consume(): Promise<void> {
    try {
      for await (const raw of this.transport.events) {
        if (this.terminal || this.closing || this.failing) break;
        const parsedProviderEvent = parseProviderEvent(raw, this.options);
        let event = parsedProviderEvent.event;
        this.validateProviderState(event);
        const contentEvent = this.trackContentEvent(event, parsedProviderEvent.oversizedDelta);
        if (!contentEvent) continue;
        event = contentEvent;
        if (event.type === 'approval.requested' || event.type === 'question.requested') {
          if (!(await this.trackInteraction(event))) continue;
        } else if (
          event.type === 'approval.resolved' ||
          event.type === 'question.resolved' ||
          event.type === 'question.cancelled'
        ) {
          if (!this.acceptProviderResolution(event)) continue;
        }
        if (isTerminal(event)) {
          this.closing = Promise.resolve().then(() => this.finishProviderTerminal(event));
          await this.closing;
          return;
        }
        if (!this.publish(event, isInteractionResolutionEvent(event))) break;
      }
      if (!this.terminal && !this.closing && !this.failing) {
        await this.fail('provider_disconnected', 'provider disconnected before a terminal event');
      }
    } catch (error) {
      await this.fail(
        eventCode(error) ?? 'provider_crash',
        error instanceof Error ? error.message : 'provider session crashed',
      );
    }
  }

  private async finishProviderTerminal(event: AgentEventV2): Promise<void> {
    const reason = event.type === 'session.cancelled' ? 'cancel' : 'disconnect';
    await this.resolveInteractions(this.takeAllInteractions(), reason, false);
    try {
      await this.stopTransport();
      if (!this.terminal) {
        this.terminal = true;
        this.closeOutput([event]);
      }
    } catch (error) {
      this.finishFailure(
        eventCode(error) ?? 'provider_force_close_failed',
        error instanceof Error ? error.message : 'provider process tree was not reaped',
      );
    }
  }

  private publish(event: AgentEventV2, mandatory = false): boolean {
    if (this.terminal) return false;
    if (isTerminal(event)) {
      this.terminal = true;
      this.closeOutput([event]);
      return true;
    }
    const bytes = utf8ByteLength(JSON.stringify(event));
    if (
      this.bufferedEvents >= MAX_PROVIDER_QUEUE_EVENTS ||
      this.bufferedBytes + bytes > MAX_PROVIDER_QUEUE_BYTES
    ) {
      if (mandatory) this.retainMandatoryFinalEvent(event);
      void this.fail('provider_queue_overflow', 'provider event queue overflowed');
      return false;
    }
    const queued = { event, bytes, counted: true };
    this.bufferedEvents += 1;
    this.bufferedBytes += bytes;
    if (this.output.push(queued)) return true;
    this.bufferedEvents -= 1;
    this.bufferedBytes -= bytes;
    if (mandatory) this.retainMandatoryFinalEvent(event);
    void this.fail('provider_queue_overflow', 'provider event queue overflowed');
    return false;
  }

  private retainMandatoryFinalEvent(event: AgentEventV2): void {
    if (!isInteractionResolutionEvent(event)) return;
    const key = `${event.type}:${event.requestId}`;
    if (this.mandatoryFinalEventKeys.has(key)) return;
    if (this.mandatoryFinalEvents.length >= MAX_PENDING_INTERACTIONS + 1) return;
    this.mandatoryFinalEventKeys.add(key);
    this.mandatoryFinalEvents.push(event);
  }

  private fail(code: string, message: string): Promise<void> {
    if (this.terminal) return Promise.resolve();
    if (this.failing) return this.failing;
    if (this.closing) return this.closing;
    this.failing = Promise.resolve().then(async () => {
      await this.resolveInteractions(this.takeAllInteractions(), 'disconnect', false);
      try {
        await this.stopTransport();
      } catch (error) {
        code = eventCode(error) ?? 'provider_force_close_failed';
        message = error instanceof Error ? error.message : 'provider process tree was not reaped';
      }
      this.finishFailure(code, message);
    });
    return this.failing;
  }

  private finishFailure(code: string, message: string): void {
    if (this.terminal) return;
    this.terminal = true;
    const diagnostic = this.stderrBuffer.trim().slice(0, 500);
    const boundedMessage = truncateUtf8(
      diagnostic ? `${message}: ${diagnostic}` : message,
      MAX_FAILURE_MESSAGE_BYTES,
    );
    this.closeOutput([
      { type: 'error', code, message: boundedMessage, recoverable: false },
      { type: 'session.failed', code, message: boundedMessage },
    ]);
  }

  private closeOutput(events: AgentEventV2[]): void {
    const finalEvents = [...this.mandatoryFinalEvents.splice(0), ...events];
    this.mandatoryFinalEventKeys.clear();
    this.output.closeWith(
      finalEvents.map((event) => ({
        event,
        bytes: utf8ByteLength(JSON.stringify(event)),
        counted: false,
      })),
    );
    this.options.signal?.removeEventListener('abort', this.abortListener);
    this.settleIdleWaiters(false);
    this.stderrBuffer = '';
  }

  private async stopTransport(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = stopTransportBounded(this.transport, this.closeTimeoutMs);
    return this.stopping;
  }

  private validateProviderState(event: AgentEventV2): void {
    const correlationFailure = (message: string): never => {
      throw new InteractiveSessionError('provider_correlation_error', message);
    };
    if (event.type === 'session.started') {
      if (this.sessionStarted)
        correlationFailure('provider emitted session.started more than once');
      if (event.transport !== this.options.transport.id) {
        correlationFailure('provider session transport did not match the frozen selection');
      }
      this.sessionStarted = true;
      return;
    }
    if (!this.sessionStarted)
      correlationFailure('provider emitted an event before session.started');
    if (event.type === 'session.status') {
      if (event.status === 'starting' && this.providerStatus !== 'starting') {
        correlationFailure('provider session returned to starting state');
      }
      if (event.status === 'idle' && (this.activeTurnId || this.expectedTurnIds.size > 0)) {
        correlationFailure('provider became idle before its expected turn ended');
      }
      this.providerStatus = event.status;
      if (event.status === 'idle') this.settleIdleWaiters(true);
      return;
    }
    if (event.type === 'turn.started') {
      if (this.activeTurnId) correlationFailure('provider started a second active turn');
      if (!this.expectedTurnIds.delete(event.turnId)) {
        correlationFailure('provider started an unexpected turn');
      }
      if (this.seenTurnIds.has(event.turnId)) correlationFailure('provider reused a turn id');
      if (this.seenTurnIds.size >= MAX_TRACKED_TURN_IDS) {
        correlationFailure('provider exceeded the session turn limit');
      }
      this.seenTurnIds.add(event.turnId);
      this.activeTurnId = event.turnId;
      this.providerStatus = 'active';
      return;
    }
    if (
      event.type === 'turn.completed' ||
      event.type === 'turn.failed' ||
      event.type === 'turn.interrupted'
    ) {
      if (this.activeTurnId !== event.turnId) {
        correlationFailure('provider ended a turn that was not active');
      }
      this.activeTurnId = undefined;
      this.lastTurnId = event.turnId;
      return;
    }
    if (
      event.type === 'session.completed' &&
      (this.activeTurnId || this.expectedTurnIds.size > 0)
    ) {
      correlationFailure('provider completed the session before its expected turn ended');
    }
    if (isTerminal(event)) return;
    if (!('turnId' in event) || event.turnId === undefined) return;
    if (
      (event.type === 'usage.tokens' ||
        event.type === 'usage.cost' ||
        event.type === 'error' ||
        event.type === 'extension.summary') &&
      event.turnId === this.lastTurnId
    ) {
      return;
    }
    if (event.turnId !== this.activeTurnId) {
      correlationFailure('provider event referenced a turn that was not active');
    }
  }

  private async trackInteraction(
    event: Extract<AgentEventV2, { type: 'approval.requested' | 'question.requested' }>,
  ): Promise<boolean> {
    const kind = event.type === 'approval.requested' ? 'approval' : 'question';
    if (
      this.interactions.has(event.requestId) ||
      this.resolvingInteractions.has(event.requestId) ||
      this.resolvedInteractions.has(event.requestId)
    ) {
      await this.fail('provider_correlation_error', 'provider reused an interaction id');
      return false;
    }
    const constraints = this.interactionConstraints(kind);
    if (!constraints) return this.denyUnselectedInteraction(event, kind);
    if (utf8ByteLength(JSON.stringify(event)) > constraints.maxPayloadBytes) {
      const oversized: InteractionRecord = {
        kind,
        requestId: event.requestId,
        turnId: event.turnId,
      };
      const records =
        kind === 'question'
          ? [...this.takePendingTurnInteractions(event.turnId), oversized]
          : [oversized];
      await this.resolveInteractions(records, 'overflow', true);
      if (kind === 'question') this.startOverflowRecovery();
      return false;
    }
    if (this.interactions.size + this.resolvingInteractions.size >= MAX_PENDING_INTERACTIONS) {
      const overflowed: InteractionRecord = {
        kind: event.type === 'approval.requested' ? 'approval' : 'question',
        requestId: event.requestId,
        turnId: event.turnId,
      };
      const records =
        overflowed.kind === 'question'
          ? [...this.takePendingTurnInteractions(event.turnId), overflowed]
          : [overflowed];
      await this.resolveInteractions(records, 'overflow', true);
      if (overflowed.kind === 'question') this.startOverflowRecovery();
      return false;
    }
    const providerDeadlineMs = Math.max(0, Date.parse(event.deadlineAt) - Date.now());
    const delay = Math.min(this.interactionTimeoutMs, constraints.timeoutMs, providerDeadlineMs);
    const record: InteractionRecord = {
      kind: event.type === 'approval.requested' ? 'approval' : 'question',
      requestId: event.requestId,
      turnId: event.turnId,
      ...(this.options.interactionOwner === 'daemon'
        ? {}
        : { timer: setTimeout(() => void this.timeoutInteraction(event.requestId), delay) }),
    };
    record.timer?.unref?.();
    this.interactions.set(event.requestId, record);
    return true;
  }

  private async denyUnselectedInteraction(
    event: Extract<AgentEventV2, { type: 'approval.requested' | 'question.requested' }>,
    kind: 'approval' | 'question',
  ): Promise<boolean> {
    const record: InteractionRecord = {
      kind,
      requestId: event.requestId,
      turnId: event.turnId,
    };
    this.rememberResolved(record);
    const resolution: ProviderInteractionResolution =
      kind === 'approval'
        ? {
            kind,
            requestId: event.requestId,
            turnId: event.turnId,
            decision: 'deny',
            reason: 'overflow',
          }
        : {
            kind,
            requestId: event.requestId,
            turnId: event.turnId,
            reason: 'overflow',
          };
    try {
      await timeout(
        this.transport.resolveInteraction(resolution),
        this.commandTimeoutMs,
        'command_timeout',
      );
    } catch (error) {
      await this.fail(
        'provider_capability_violation',
        `provider emitted an unselected ${kind} interaction and safe rejection failed: ${
          error instanceof Error ? error.message : 'unknown provider failure'
        }`,
      );
      return false;
    }
    this.publish({
      type: 'extension.summary',
      turnId: event.turnId,
      extensionName: `provider.interaction.${kind}`,
      summary: `provider emitted an unselected ${kind} interaction; rejected before exposure`,
      reason: 'capability_drift',
    });
    return false;
  }

  private interactionConstraints(
    kind: 'approval' | 'question',
  ): { kind: 'interaction'; timeoutMs: number; maxPayloadBytes: number } | undefined {
    const capabilityId = kind === 'approval' ? 'interaction.approval' : 'interaction.question';
    const constraints = this.options.selection.enabled.find(
      (entry) => entry.id === capabilityId,
    )?.constraints;
    return constraints?.kind === 'interaction' ? constraints : undefined;
  }

  private async timeoutInteraction(requestId: string): Promise<void> {
    const record = this.interactions.get(requestId);
    if (!record) return;
    this.interactions.delete(requestId);
    const sameTurn =
      record.kind === 'question'
        ? [...this.interactions.values()].filter((candidate) => candidate.turnId === record.turnId)
        : [];
    for (const candidate of sameTurn) this.interactions.delete(candidate.requestId);
    try {
      await this.resolveInteractions([record, ...sameTurn], 'timeout', true);
      if (record.kind === 'question' && !this.terminal && !this.closing && !this.failing) {
        await this.interruptAndConfirmIdle();
      }
    } catch (error) {
      await this.fail(
        eventCode(error) ?? 'provider_crash',
        error instanceof Error ? error.message : 'provider interaction timeout failed',
      );
    }
  }

  private takeInteraction(command: AgentCommandV2): InteractionRecord | undefined {
    if (command.type !== 'approval.respond' && command.type !== 'question.respond')
      return undefined;
    const record = this.interactions.get(command.requestId);
    if (
      !record ||
      record.turnId !== command.turnId ||
      (record.kind === 'approval') !== (command.type === 'approval.respond')
    ) {
      throw new InteractiveSessionError(
        'stale_interaction',
        'interaction is stale or belongs to another turn',
      );
    }
    this.interactions.delete(record.requestId);
    if (record.timer) clearTimeout(record.timer);
    this.resolvingInteractions.set(record.requestId, record);
    return record;
  }

  private assertInteractionAvailable(command: AgentCommandV2): void {
    if (command.type !== 'approval.respond' && command.type !== 'question.respond') return;
    const record = this.interactions.get(command.requestId);
    if (
      !record ||
      record.turnId !== command.turnId ||
      (record.kind === 'approval') !== (command.type === 'approval.respond')
    ) {
      throw new InteractiveSessionError(
        'stale_interaction',
        'interaction is stale or belongs to another turn',
      );
    }
  }

  private acceptProviderResolution(
    event: Extract<
      AgentEventV2,
      { type: 'approval.resolved' | 'question.resolved' | 'question.cancelled' }
    >,
  ): boolean {
    const kind = event.type === 'approval.resolved' ? 'approval' : 'question';
    const resolved = this.resolvedInteractions.get(event.requestId);
    if (resolved) {
      if (resolved.kind !== kind || resolved.turnId !== event.turnId) {
        void this.fail('provider_correlation_error', 'provider resolution correlation changed');
      }
      return false;
    }
    const record =
      this.interactions.get(event.requestId) ?? this.resolvingInteractions.get(event.requestId);
    if (!record || record.kind !== kind || record.turnId !== event.turnId) {
      void this.fail('provider_correlation_error', 'provider resolved an unknown interaction');
      return false;
    }
    if (this.options.interactionOwner === 'daemon') {
      if (this.resolvingInteractions.get(event.requestId) !== record) {
        void this.fail(
          'provider_correlation_error',
          'provider resolved a daemon-owned interaction without a dispatched response',
        );
      }
      // The provider controls this event's decision/answers. Even while a daemon command is in
      // flight, only the already-validated daemon command may define the published resolution.
      // Keep the record resolving so send() synthesizes that authoritative event on success.
      return false;
    }
    this.interactions.delete(record.requestId);
    this.resolvingInteractions.delete(record.requestId);
    if (record.timer) clearTimeout(record.timer);
    this.rememberResolved(record);
    return true;
  }

  private publishInteractionResolution(
    record: InteractionRecord,
    command: ApprovalResponseCommandV2 | QuestionResponseCommandV2,
  ): void {
    if (record.kind === 'approval' && command.type === 'approval.respond') {
      this.publish(
        {
          type: 'approval.resolved',
          turnId: record.turnId,
          requestId: record.requestId,
          decision: command.decision === 'allow_once' ? 'allowed' : 'denied',
          actor: 'user',
        },
        true,
      );
      return;
    }
    if (record.kind === 'question' && command.type === 'question.respond') {
      this.publish(
        {
          type: 'question.resolved',
          turnId: record.turnId,
          requestId: record.requestId,
          answers: command.answers,
        },
        true,
      );
    }
  }

  private publishSafeResolution(
    record: InteractionRecord,
    reason:
      'cancel' | 'disconnect' | 'interrupt' | 'overflow' | 'shutdown' | 'timeout' | 'trust_revoked',
  ): void {
    if (record.timer) clearTimeout(record.timer);
    if (record.kind === 'approval') {
      this.publish(
        {
          type: 'approval.resolved',
          turnId: record.turnId,
          requestId: record.requestId,
          decision: 'denied',
          actor:
            reason === 'timeout'
              ? 'timeout'
              : reason === 'disconnect'
                ? 'disconnect'
                : reason === 'shutdown'
                  ? 'shutdown'
                  : 'policy',
        },
        true,
      );
    } else {
      this.publish(
        {
          type: 'question.cancelled',
          turnId: record.turnId,
          requestId: record.requestId,
          reason,
        },
        true,
      );
    }
  }

  private takeAllInteractions(): InteractionRecord[] {
    const records = [...this.interactions.values(), ...this.resolvingInteractions.values()];
    this.interactions.clear();
    this.resolvingInteractions.clear();
    return records;
  }

  private takePendingTurnInteractions(turnId: string): InteractionRecord[] {
    const records: InteractionRecord[] = [];
    for (const record of this.interactions.values()) {
      if (record.turnId !== turnId) continue;
      this.interactions.delete(record.requestId);
      records.push(record);
    }
    return records;
  }

  private startOverflowRecovery(): void {
    if (this.overflowRecovery || this.terminal || this.closing || this.failing) return;
    const recovery = this.interruptAndConfirmIdle()
      .catch(async () => {
        if (!this.terminal && !this.closing && !this.failing) await this.close();
      })
      .finally(() => {
        if (this.overflowRecovery === recovery) this.overflowRecovery = undefined;
      });
    this.overflowRecovery = recovery;
  }

  private async interruptAndConfirmIdle(): Promise<void> {
    if (this.isProviderIdle()) return;
    await timeout(this.transport.interrupt(), this.commandTimeoutMs, 'command_timeout');
    if (await this.waitForIdle()) return;
    if (!this.terminal && !this.closing && !this.failing) await this.close();
    throw new InteractiveSessionError(
      'command_timeout',
      'provider did not confirm idle after interruption',
    );
  }

  private waitForIdle(): Promise<boolean> {
    if (this.isProviderIdle()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const finish = (idle: boolean): void => {
        clearTimeout(timer);
        this.idleWaiters.delete(finish);
        resolve(idle);
      };
      const timer = setTimeout(() => finish(false), this.commandTimeoutMs);
      timer.unref?.();
      this.idleWaiters.add(finish);
    });
  }

  private settleIdleWaiters(idle: boolean): void {
    for (const settle of [...this.idleWaiters]) settle(idle);
  }

  private isProviderIdle(): boolean {
    return (
      this.providerStatus === 'idle' &&
      this.activeTurnId === undefined &&
      this.expectedTurnIds.size === 0
    );
  }

  private async resolveInteractions(
    records: InteractionRecord[],
    reason:
      'cancel' | 'disconnect' | 'interrupt' | 'overflow' | 'shutdown' | 'timeout' | 'trust_revoked',
    notifyProvider: boolean,
    responseTimeoutMs = this.commandTimeoutMs,
  ): Promise<void> {
    for (const record of records) {
      this.rememberResolved(record);
      this.publishSafeResolution(record, reason);
    }
    if (!notifyProvider) return;
    await timeout(
      (async () => {
        for (const record of records) {
          const resolution: ProviderInteractionResolution =
            record.kind === 'approval'
              ? {
                  kind: 'approval',
                  requestId: record.requestId,
                  turnId: record.turnId,
                  decision: 'deny',
                  reason,
                }
              : {
                  kind: 'question',
                  requestId: record.requestId,
                  turnId: record.turnId,
                  reason,
                };
          await this.transport.resolveInteraction(resolution);
        }
      })(),
      responseTimeoutMs,
      'command_timeout',
    );
  }

  private rememberResolved(record: Pick<InteractionRecord, 'kind' | 'requestId' | 'turnId'>): void {
    this.resolvedInteractions.set(record.requestId, {
      kind: record.kind,
      requestId: record.requestId,
      turnId: record.turnId,
    });
    while (this.resolvedInteractions.size > MAX_RESOLVED_INTERACTIONS) {
      const oldest = this.resolvedInteractions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.resolvedInteractions.delete(oldest);
    }
  }

  private async consumeStderr(): Promise<void> {
    for await (const raw of this.transport.stderr) {
      if (this.terminal || this.stderrBytes >= MAX_STDERR_BYTES) continue;
      if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) continue;
      const chunk = Buffer.from(raw);
      const retained = chunk.subarray(0, MAX_STDERR_BYTES - this.stderrBytes);
      this.stderrBuffer += retained.toString('utf8');
      this.stderrBytes += retained.byteLength;
    }
  }

  private assertOpen(): void {
    if (this.terminal || this.closing || this.failing || this.stopping) {
      throw new InteractiveSessionError('session_terminal', 'session is terminal');
    }
  }

  private assertCommandState(command: AgentCommandV2): void {
    const reject = (message: string): never => {
      throw new InteractiveSessionError('command_rejected', message);
    };
    if (!this.sessionStarted) reject('provider session has not started');
    if (this.overflowRecovery) reject('turn interruption is pending');
    if (command.type === 'input.follow_up') {
      if (
        this.providerStatus !== 'idle' ||
        this.activeTurnId !== undefined ||
        this.expectedTurnIds.size > 0
      ) {
        reject('follow-up input requires an idle session');
      }
      if (this.seenTurnIds.has(command.turnId)) reject('turn id was already used');
      return;
    }
    if (command.type === 'input.steer') {
      if (this.providerStatus !== 'active' || this.activeTurnId !== command.turnId) {
        reject('steering requires the active turn');
      }
      return;
    }
    if (
      (command.type === 'approval.respond' || command.type === 'question.respond') &&
      (this.providerStatus !== 'active' || this.activeTurnId !== command.turnId)
    ) {
      reject('interaction response requires the active turn');
    }
  }

  private trackContentEvent(
    event: AgentEventV2,
    oversizedDelta?: Buffer,
  ): AgentEventV2 | undefined {
    if (event.type !== 'content.delta' && event.type !== 'content.completed') return event;
    const contentBlockId = event.type === 'content.delta' ? event.contentBlockId : event.block.id;
    const key = `${event.turnId}:${contentBlockId}`;
    const completed = this.completedContentBlocks.get(key);
    if (completed) {
      if (completed === 'truncated') return undefined;
      throw new InteractiveSessionError(
        'provider_correlation_error',
        'provider emitted content after the block completed',
      );
    }

    if (oversizedDelta) {
      if (
        event.type !== 'content.completed' ||
        event.block.type !== 'provider_extension' ||
        event.block.representation !== 'safe_summary' ||
        event.block.reason !== 'truncated'
      ) {
        throw new InteractiveSessionError(
          'provider_frame_invalid',
          'oversized provider delta was not normalized to a completion marker',
        );
      }
      this.ensureContentBlockCapacity(key);
      const active = this.activeContentBlocks.get(key) ?? {
        bytes: 0,
        hash: createHash('sha256'),
      };
      active.bytes += oversizedDelta.byteLength;
      active.hash.update(oversizedDelta);
      this.activeContentBlocks.delete(key);
      this.completedContentBlocks.set(key, 'truncated');
      return {
        ...event,
        block: {
          ...event.block,
          originalBytes: active.bytes,
          sha256: active.hash.digest('hex'),
        },
      };
    }

    if (event.type === 'content.completed') {
      this.ensureContentBlockCapacity(key);
      this.activeContentBlocks.delete(key);
      const truncated =
        event.block.type === 'provider_extension' &&
        event.block.representation === 'safe_summary' &&
        event.block.reason === 'truncated';
      this.completedContentBlocks.set(key, truncated ? 'truncated' : 'provider');
      return event;
    }

    let active = this.activeContentBlocks.get(key);
    if (!active) {
      this.ensureContentBlockCapacity(key);
      active = { bytes: 0, hash: createHash('sha256') };
      this.activeContentBlocks.set(key, active);
    }
    const encoded = Buffer.from(event.delta);
    active.bytes += encoded.byteLength;
    active.hash.update(encoded);
    if (active.bytes <= MAX_CONTENT_BLOCK_BYTES) return event;

    this.activeContentBlocks.delete(key);
    this.completedContentBlocks.set(key, 'truncated');
    return {
      type: 'content.completed',
      turnId: event.turnId,
      block: {
        type: 'provider_extension',
        id: event.contentBlockId,
        extensionName: 'provider.content.delta',
        representation: 'safe_summary',
        safeSummary: 'provider content exceeded the 256 KiB content-block limit',
        reason: 'truncated',
        originalBytes: active.bytes,
        sha256: active.hash.digest('hex'),
      },
    };
  }

  private ensureContentBlockCapacity(key: string): void {
    if (this.activeContentBlocks.has(key) || this.completedContentBlocks.has(key)) return;
    if (
      this.activeContentBlocks.size + this.completedContentBlocks.size >=
      MAX_TRACKED_CONTENT_BLOCKS
    ) {
      throw new InteractiveSessionError(
        'provider_correlation_error',
        'provider exceeded the session content-block limit',
      );
    }
  }
}

/** Wraps a provider host after its inert startup handshake and enforces all shared live bounds. */
export async function superviseInteractiveSession(
  transport: InteractiveProviderTransport,
  options: StartInteractiveSessionOptions,
  limits: SessionSupervisorOptions = {},
): Promise<InteractiveProviderSessionHandle> {
  // Acceptance may reject as the host crashes while its startup handshake is still pending. Observe
  // it immediately so Node never treats that legitimate race as an unhandled rejection.
  void transport.accepted.catch(() => undefined);
  try {
    await withAbort(
      timeout(
        transport.started,
        limits.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        'command_timeout',
      ),
      options.signal,
    );
  } catch (error) {
    await stopTransportBounded(transport, limits.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
    throw error;
  }
  return new SessionSupervisor(transport, options, limits);
}
