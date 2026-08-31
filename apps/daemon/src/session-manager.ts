import { randomUUID } from 'node:crypto';
import {
  utf8ByteLength,
  type AgentCommandV2,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentEventV2,
  type AgentSession,
  type CapabilitySelection,
  type CommandAcknowledgementV2,
  type ProviderId,
  type ProviderTransportV2,
} from '@agent-dock/shared';
import {
  InteractiveSessionError,
  type AcceptedWorkState,
  type InteractiveProviderSessionHandle,
  type Logger,
  type ProviderRegistry,
  type ProviderSessionHandle,
} from '@agent-dock/agent-runtime';
import { MemorySessionStore, type SessionStore } from './session-store.js';

interface RuntimeStateBase {
  protocolVersion: 1 | 2;
  /** Resolves only after the provider stream terminates and its supervisor has reaped the host. */
  done: Promise<void>;
}

interface LegacyRuntimeState extends RuntimeStateBase {
  kind: 'legacy';
  handle: ProviderSessionHandle;
  events: AgentEventEnvelope[];
  listeners: Set<(index: number, event: AgentEventEnvelope) => void>;
  nextSequence: number;
}

interface CommandRecord {
  canonicalPayload: string;
  result: Promise<DispatchResult>;
  settled: boolean;
}

interface StoredInteractiveEvent {
  event: AgentEventV2;
  bytes: number;
}

interface InteractiveRuntimeState extends RuntimeStateBase {
  kind: 'interactive';
  protocolVersion: 2;
  handle: InteractiveProviderSessionHandle;
  events: Map<number, StoredInteractiveEvent>;
  replayBytes: number;
  nextEventIndex: number;
  listeners: Set<(index: number, event: AgentEventV2) => void>;
  acceptedWork: AcceptedWorkState;
  dispatchTail: Promise<void>;
  pendingCommands: number;
  pendingCommandBytes: number;
  commandLedger: Map<string, CommandRecord>;
}

interface PendingInteractiveStart {
  protocolVersion: 2;
  controller: AbortController;
  done: Promise<void>;
}

type RuntimeState = LegacyRuntimeState | InteractiveRuntimeState;

export type DispatchFailureCode =
  | 'command_id_conflict'
  | 'command_out_of_bounds'
  | 'command_rejected'
  | 'session_backpressure'
  | 'session_not_capable'
  | 'session_not_found'
  | 'session_terminal'
  | 'stale_interaction';

export type DispatchResult =
  | { ok: true; acknowledgement: CommandAcknowledgementV2 }
  | { ok: false; code: DispatchFailureCode; message: string };

const MAX_STORED_EVENTS_PER_SESSION = 5_000;
const MAX_STORED_EVENT_BYTES_PER_SESSION = 16 * 1024 * 1024;
const MAX_RETAINED_COMPLETED_SESSIONS = 50;
const MAX_PENDING_COMMANDS = 64;
const MAX_PENDING_COMMAND_BYTES = 1024 * 1024;
const MAX_COMMAND_LEDGER_ENTRIES = 1_024;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 5_000;
// Interactive shutdown can spend one close interval resolving outstanding interactions, one on
// graceful transport close, and one on the mandatory force-close/reap fallback. Keep the daemon's
// outer bound above all three so it never exits while a conforming supervisor is still reaping.
const SESSION_SHUTDOWN_TIMEOUT_MS = INTERACTIVE_CLOSE_TIMEOUT_MS * 3 + 1_000;

function isSessionActive(session: AgentSession): boolean {
  return session.status === 'starting' || session.status === 'running';
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
  );
}

function canonicalCommand(command: AgentCommandV2): string {
  return JSON.stringify(canonicalValue(command));
}

/** Owns provider lifecycles and the command serialization boundary for every daemon session. */
export class SessionManager {
  private readonly runtime = new Map<string, RuntimeState>();
  private readonly pendingInteractiveStarts = new Map<string, PendingInteractiveStart>();
  private readonly completedOrder: string[] = [];
  private readonly shutdownController = new AbortController();
  private shuttingDown = false;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly logger: Logger,
    private readonly store: SessionStore = new MemorySessionStore(),
  ) {}

  /** Existing one-shot path. Its process and event contract deliberately remains unchanged. */
  create(
    provider: ProviderId,
    cwd: string,
    prompt: string,
    resumeProviderSessionId?: string,
    protocolVersion: 1 | 2 = 1,
  ): AgentSession {
    if (this.shuttingDown) throw new Error('session manager is shutting down');
    const providerImpl = this.registry.get(provider);
    if (!providerImpl) throw new Error(`no provider registered for id: ${provider}`);

    const id = randomUUID();
    const session = this.newSession(id, provider, cwd, prompt);
    this.store.create(session);
    const handle = providerImpl.startSession({
      sessionId: id,
      cwd,
      prompt,
      resumeProviderSessionId,
    });
    const runtime: LegacyRuntimeState = {
      kind: 'legacy',
      handle,
      protocolVersion,
      events: [],
      listeners: new Set(),
      nextSequence: 0,
      done: Promise.resolve(),
    };
    this.runtime.set(id, runtime);
    runtime.done = this.consumeLegacy(id, runtime);
    this.logCreated(session, !!resumeProviderSessionId, 'legacy');
    return session;
  }

  /** Rich v2 path: one supervised provider host per AgentDock session. */
  async createInteractive(
    provider: ProviderId,
    cwd: string,
    prompt: string,
    selection: CapabilitySelection,
    transport: ProviderTransportV2,
    executionId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<AgentSession> {
    if (this.shuttingDown) {
      throw new InteractiveSessionError('session_terminal', 'session manager is shutting down');
    }
    const providerImpl = this.registry.get(provider);
    if (!providerImpl?.startInteractiveSession) {
      throw new Error(`provider has no interactive transport: ${provider}`);
    }
    const id = randomUUID();
    const session = this.newSession(id, provider, cwd, prompt);
    this.store.create(session);
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) relayAbort();
    else signal?.addEventListener('abort', relayAbort, { once: true });
    let finishPending!: () => void;
    const pending: PendingInteractiveStart = {
      protocolVersion: 2,
      controller,
      done: new Promise<void>((resolve) => {
        finishPending = resolve;
      }),
    };
    this.pendingInteractiveStarts.set(id, pending);

    try {
      const handle = await providerImpl.startInteractiveSession({
        sessionId: id,
        cwd,
        prompt,
        selection,
        transport,
        executionId,
        turnId,
        signal: controller.signal,
      });
      if (controller.signal.aborted || this.shuttingDown) {
        await handle.close();
        throw new InteractiveSessionError('session_terminal', 'session start was cancelled');
      }
      const runtime: InteractiveRuntimeState = {
        kind: 'interactive',
        protocolVersion: 2,
        handle,
        events: new Map(),
        replayBytes: 0,
        nextEventIndex: 0,
        listeners: new Set(),
        acceptedWork: 'not_accepted',
        dispatchTail: Promise.resolve(),
        pendingCommands: 0,
        pendingCommandBytes: 0,
        commandLedger: new Map(),
        done: Promise.resolve(),
      };
      this.runtime.set(id, runtime);
      void handle.accepted.then(
        (acceptedWork) => {
          if (this.runtime.get(id) === runtime && runtime.acceptedWork !== 'accepted') {
            runtime.acceptedWork = acceptedWork;
          }
        },
        () => {
          if (this.runtime.get(id) === runtime && runtime.acceptedWork !== 'accepted') {
            runtime.acceptedWork = 'unknown';
          }
        },
      );
      runtime.done = this.consumeInteractive(id, runtime);
      this.logCreated(session, false, 'interactive');
      return session;
    } catch (error) {
      this.store.delete(id);
      throw error;
    } finally {
      signal?.removeEventListener('abort', relayAbort);
      this.pendingInteractiveStarts.delete(id);
      finishPending();
    }
  }

  private newSession(id: string, provider: ProviderId, cwd: string, prompt: string): AgentSession {
    return {
      id,
      provider,
      cwd,
      prompt,
      status: 'starting',
      startedAt: new Date().toISOString(),
    };
  }

  private logCreated(session: AgentSession, resumed: boolean, transport: string): void {
    this.logger.info('session created', {
      sessionId: session.id,
      provider: session.provider,
      resumed,
      transport,
    });
  }

  private async consumeLegacy(id: string, runtime: LegacyRuntimeState): Promise<void> {
    this.mutateSession(id, (session) => {
      session.status = 'running';
    });
    for await (const event of runtime.handle.events) {
      this.mutateSession(id, (session) => this.applyLegacyStatus(session, event));
      const sequence = runtime.nextSequence++;
      const envelope: AgentEventEnvelope = {
        ...event,
        sequence,
        timestamp: new Date().toISOString(),
      };
      if (runtime.events.length < MAX_STORED_EVENTS_PER_SESSION) {
        runtime.events.push(envelope);
      } else {
        this.logger.warn('session event history full; further events will not be replayable', {
          sessionId: id,
        });
      }
      this.notifyLegacyListeners(id, runtime, sequence, envelope);
    }
    this.markCompleted(id);
  }

  private async consumeInteractive(id: string, runtime: InteractiveRuntimeState): Promise<void> {
    this.mutateSession(id, (session) => {
      session.status = 'running';
    });
    for await (const event of runtime.handle.events) {
      this.mutateSession(id, (session) => this.applyInteractiveStatus(session, event));
      const index = runtime.nextEventIndex;
      runtime.nextEventIndex += 1;
      this.recordInteractiveEvent(runtime, index, event);
      for (const listener of [...runtime.listeners]) {
        try {
          listener(index, event);
        } catch (error) {
          this.logger.warn('interactive session listener failed', {
            sessionId: id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    this.markCompleted(id);
  }

  private recordInteractiveEvent(
    runtime: InteractiveRuntimeState,
    index: number,
    event: AgentEventV2,
  ): void {
    const bytes = utf8ByteLength(JSON.stringify(event));
    while (
      runtime.events.size > 0 &&
      (runtime.events.size >= MAX_STORED_EVENTS_PER_SESSION ||
        runtime.replayBytes + bytes > MAX_STORED_EVENT_BYTES_PER_SESSION)
    ) {
      const oldestIndex = runtime.events.keys().next().value as number;
      const oldest = runtime.events.get(oldestIndex);
      runtime.events.delete(oldestIndex);
      runtime.replayBytes -= oldest?.bytes ?? 0;
    }
    if (bytes > MAX_STORED_EVENT_BYTES_PER_SESSION) return;
    runtime.events.set(index, { event, bytes });
    runtime.replayBytes += bytes;
  }

  private notifyLegacyListeners(
    id: string,
    runtime: LegacyRuntimeState,
    sequence: number,
    event: AgentEventEnvelope,
  ): void {
    for (const listener of [...runtime.listeners]) {
      try {
        listener(sequence, event);
      } catch (error) {
        this.logger.warn('session listener failed', {
          sessionId: id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private markCompleted(id: string): void {
    this.completedOrder.push(id);
    this.evictOldestCompletedIfOverCap();
  }

  private evictOldestCompletedIfOverCap(): void {
    while (this.completedOrder.length > MAX_RETAINED_COMPLETED_SESSIONS) {
      const staleId = this.completedOrder.shift();
      if (staleId === undefined) break;
      if (!this.runtime.has(staleId)) continue;
      this.runtime.delete(staleId);
      this.store.delete(staleId);
    }
  }

  private mutateSession(id: string, fn: (session: AgentSession) => void): void {
    const session = this.store.get(id);
    if (!session) return;
    fn(session);
    this.store.update(id, session);
  }

  private applyLegacyStatus(session: AgentSession, event: AgentEvent): void {
    switch (event.type) {
      case 'session.completed':
        session.status = 'completed';
        session.completedAt = new Date().toISOString();
        session.providerSessionId = event.providerSessionId ?? session.providerSessionId;
        break;
      case 'session.failed':
        session.status = 'failed';
        session.completedAt = new Date().toISOString();
        session.error = event.message;
        break;
      case 'session.cancelled':
        session.status = 'cancelled';
        session.completedAt = new Date().toISOString();
        break;
      default:
        break;
    }
  }

  private applyInteractiveStatus(session: AgentSession, event: AgentEventV2): void {
    switch (event.type) {
      case 'session.completed':
        session.status = 'completed';
        session.completedAt = new Date().toISOString();
        break;
      case 'session.failed':
        session.status = 'failed';
        session.completedAt = new Date().toISOString();
        session.error = event.message;
        break;
      case 'session.cancelled':
        session.status = 'cancelled';
        session.completedAt = new Date().toISOString();
        break;
      case 'session.interrupted':
        session.status = 'failed';
        session.completedAt = new Date().toISOString();
        session.error = event.reason ?? 'session interrupted';
        break;
      default:
        break;
    }
  }

  get(id: string, protocolVersion?: 1 | 2): AgentSession | undefined {
    if (!this.ownedBy(id, protocolVersion)) return undefined;
    return this.store.get(id);
  }

  list(protocolVersion?: 1 | 2): AgentSession[] {
    return this.store.list().filter((session) => this.ownedBy(session.id, protocolVersion));
  }

  subscribe(
    id: string,
    sinceIndex: number,
    listener: (index: number, event: AgentEventEnvelope) => void,
    protocolVersion?: 1 | 2,
  ): (() => void) | undefined {
    if (!this.ownedBy(id, protocolVersion)) return undefined;
    const runtime = this.runtime.get(id);
    if (!runtime || runtime.kind !== 'legacy') return undefined;
    for (let index = sinceIndex; index < runtime.events.length; index += 1) {
      listener(index, runtime.events[index] as AgentEventEnvelope);
    }
    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  }

  subscribeInteractive(
    id: string,
    sinceIndex: number,
    listener: (index: number, event: AgentEventV2) => void,
  ): (() => void) | undefined {
    const runtime = this.runtime.get(id);
    if (!runtime || runtime.kind !== 'interactive') return undefined;
    for (const [index, stored] of runtime.events) {
      if (index >= sinceIndex) listener(index, stored.event);
    }
    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  }

  isInteractive(id: string): boolean {
    return this.runtime.get(id)?.kind === 'interactive';
  }

  acceptedWork(id: string): AcceptedWorkState {
    const runtime = this.runtime.get(id);
    return runtime?.kind === 'interactive' ? runtime.acceptedWork : 'unknown';
  }

  dispatch(
    id: string,
    command: AgentCommandV2,
    newCommandFailure?: DispatchFailureCode,
  ): Promise<DispatchResult> {
    const runtime = this.runtime.get(id);
    if (!runtime) return Promise.resolve(this.dispatchFailure('session_not_found'));
    if (runtime.kind !== 'interactive') {
      return Promise.resolve(this.dispatchFailure('session_not_capable'));
    }

    const canonicalPayload = canonicalCommand(command);
    const existing = runtime.commandLedger.get(command.commandId);
    if (existing) {
      return existing.canonicalPayload === canonicalPayload
        ? existing.result
        : Promise.resolve(this.dispatchFailure('command_id_conflict'));
    }
    // State and capability gates apply only to new commands. A byte-equivalent retry must
    // return its recorded result even if the first dispatch already changed session state.
    if (newCommandFailure) {
      return Promise.resolve(this.dispatchFailure(newCommandFailure));
    }
    const bytes = utf8ByteLength(canonicalPayload);
    if (
      runtime.pendingCommands >= MAX_PENDING_COMMANDS ||
      runtime.pendingCommandBytes + bytes > MAX_PENDING_COMMAND_BYTES
    ) {
      return Promise.resolve(this.dispatchFailure('session_backpressure'));
    }

    runtime.pendingCommands += 1;
    runtime.pendingCommandBytes += bytes;
    const result = runtime.dispatchTail
      .then(() => this.dispatchNow(id, runtime, command))
      .finally(() => {
        runtime.pendingCommands -= 1;
        runtime.pendingCommandBytes -= bytes;
      });
    const record: CommandRecord = { canonicalPayload, result, settled: false };
    runtime.commandLedger.set(command.commandId, record);
    runtime.dispatchTail = result.then(
      () => undefined,
      () => undefined,
    );
    void result.then(() => {
      record.settled = true;
      this.pruneCommandLedger(runtime);
    });
    return result;
  }

  private async dispatchNow(
    id: string,
    runtime: InteractiveRuntimeState,
    command: AgentCommandV2,
  ): Promise<DispatchResult> {
    const session = this.store.get(id);
    if (!session || !isSessionActive(session) || this.runtime.get(id) !== runtime) {
      return this.dispatchFailure('session_terminal');
    }
    try {
      if (command.type === 'session.interrupt') await runtime.handle.interrupt();
      else await runtime.handle.send(command);
      runtime.acceptedWork = 'accepted';
      return {
        ok: true,
        acknowledgement: {
          status: 'accepted',
          commandId: command.commandId,
          sessionId: command.sessionId,
          turnId: command.turnId,
        },
      };
    } catch (error) {
      if (error instanceof InteractiveSessionError && error.code === 'stale_interaction') {
        return this.dispatchFailure('stale_interaction');
      }
      if (error instanceof InteractiveSessionError && error.code === 'session_terminal') {
        return this.dispatchFailure('session_terminal');
      }
      return this.dispatchFailure('command_rejected');
    }
  }

  private dispatchFailure(code: DispatchFailureCode): DispatchResult {
    const messages: Record<DispatchFailureCode, string> = {
      command_id_conflict: 'command id was reused with a different payload',
      command_out_of_bounds: 'command exceeds the frozen capability constraints',
      command_rejected: 'provider rejected the command',
      session_backpressure: 'session command queue is full',
      session_not_capable: 'session transport does not accept commands',
      session_not_found: 'session not found',
      session_terminal: 'commands cannot reach a terminal session',
      stale_interaction: 'interaction is stale or belongs to another session or turn',
    };
    return { ok: false, code, message: messages[code] };
  }

  private pruneCommandLedger(runtime: InteractiveRuntimeState): void {
    while (runtime.commandLedger.size > MAX_COMMAND_LEDGER_ENTRIES) {
      const entry = [...runtime.commandLedger.entries()].find(([, record]) => record.settled);
      if (!entry) return;
      runtime.commandLedger.delete(entry[0]);
    }
  }

  async cancel(id: string, protocolVersion?: 1 | 2): Promise<boolean> {
    if (!this.ownedBy(id, protocolVersion)) return false;
    const session = this.store.get(id);
    const pending = this.pendingInteractiveStarts.get(id);
    if (session && pending && isSessionActive(session)) {
      pending.controller.abort();
      await this.waitForPending(pending, INTERACTIVE_CLOSE_TIMEOUT_MS);
      return true;
    }
    const runtime = this.runtime.get(id);
    if (!session || !runtime || !isSessionActive(session)) return false;
    await this.closeRuntime(runtime);
    return true;
  }

  async remove(id: string, protocolVersion?: 1 | 2): Promise<boolean> {
    if (!this.ownedBy(id, protocolVersion)) return false;
    const session = this.store.get(id);
    if (!session) return false;
    const pending = this.pendingInteractiveStarts.get(id);
    if (pending && isSessionActive(session)) {
      pending.controller.abort();
      await this.waitForPending(pending, INTERACTIVE_CLOSE_TIMEOUT_MS);
    }
    const runtime = this.runtime.get(id);
    if (runtime && isSessionActive(session)) {
      await this.closeRuntime(runtime);
      if (runtime.kind === 'interactive') {
        await this.waitForDone(runtime, INTERACTIVE_CLOSE_TIMEOUT_MS);
      }
    }
    this.runtime.delete(id);
    this.store.delete(id);
    const orderIndex = this.completedOrder.indexOf(id);
    if (orderIndex !== -1) this.completedOrder.splice(orderIndex, 1);
    return true;
  }

  private ownedBy(id: string, protocolVersion: 1 | 2 | undefined): boolean {
    const ownedProtocol =
      this.runtime.get(id)?.protocolVersion ??
      this.pendingInteractiveStarts.get(id)?.protocolVersion;
    return protocolVersion === undefined || ownedProtocol === protocolVersion;
  }

  async cancelAll(timeoutMs = SESSION_SHUTDOWN_TIMEOUT_MS, protocolVersion?: 1 | 2): Promise<void> {
    const pendingStarts = [...this.pendingInteractiveStarts.values()].filter(
      (pending) => protocolVersion === undefined || pending.protocolVersion === protocolVersion,
    );
    for (const pending of pendingStarts) pending.controller.abort();
    const activeRuntimes = this.store
      .list()
      .filter((session) => isSessionActive(session) && this.ownedBy(session.id, protocolVersion))
      .map((session) => this.runtime.get(session.id))
      .filter((runtime): runtime is RuntimeState => !!runtime);
    const stopping = Promise.allSettled(
      activeRuntimes.map((runtime) => this.closeRuntime(runtime)),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([
        stopping.then(() =>
          Promise.allSettled([
            ...activeRuntimes.map((runtime) => runtime.done),
            ...pendingStarts.map((pending) => pending.done),
          ]),
        ),
        timedOut,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Stops new work before daemon shutdown and aborts every startup handshake already in flight. */
  beginShutdown(): void {
    this.shuttingDown = true;
    this.shutdownController.abort();
    for (const pending of this.pendingInteractiveStarts.values()) pending.controller.abort();
  }

  get shutdownSignal(): AbortSignal {
    return this.shutdownController.signal;
  }

  private closeRuntime(runtime: RuntimeState): Promise<void> {
    return runtime.kind === 'legacy' ? runtime.handle.cancel() : runtime.handle.close();
  }

  private async waitForDone(runtime: RuntimeState, timeoutMs: number): Promise<void> {
    await Promise.race([
      runtime.done,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private async waitForPending(pending: PendingInteractiveStart, timeoutMs: number): Promise<void> {
    await Promise.race([
      pending.done,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
