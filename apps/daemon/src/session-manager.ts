import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventEnvelope, AgentSession, ProviderId } from '@agent-dock/shared';
import type { Logger, ProviderRegistry, ProviderSessionHandle } from '@agent-dock/agent-runtime';
import { MemorySessionStore, type SessionStore } from './session-store.js';

/**
 * Live, non-persistable state for one session: its process handle and buffered event history.
 * Deliberately kept out of SessionStore — see session-store.ts for why. Events are stored as the
 * protocol's public `AgentEventEnvelope` (event + sequence + timestamp), stamped once here so
 * every subscriber — live or replayed — sees the same sequence/timestamp for the same event.
 */
interface RuntimeState {
  handle: ProviderSessionHandle;
  events: AgentEventEnvelope[];
  listeners: Set<(index: number, event: AgentEventEnvelope) => void>;
}

const MAX_STORED_EVENTS_PER_SESSION = 5_000;

/**
 * Orchestrates session lifecycle: creates sessions via the provider registry, consumes their
 * normalized event stream, and keeps `AgentSession` records up to date in a `SessionStore` (see
 * session-store.ts — `MemorySessionStore` by default, and the only implementation for now).
 */
export class SessionManager {
  private readonly runtime = new Map<string, RuntimeState>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly logger: Logger,
    private readonly store: SessionStore = new MemorySessionStore(),
  ) {}

  create(provider: ProviderId, cwd: string, prompt: string, resumeProviderSessionId?: string): AgentSession {
    const providerImpl = this.registry.get(provider);
    if (!providerImpl) {
      throw new Error(`no provider registered for id: ${provider}`);
    }

    const id = randomUUID();
    const session: AgentSession = {
      id,
      provider,
      cwd,
      prompt,
      status: 'starting',
      startedAt: new Date().toISOString(),
    };
    this.store.create(session);

    const handle = providerImpl.startSession({ sessionId: id, cwd, prompt, resumeProviderSessionId });
    this.runtime.set(id, { handle, events: [], listeners: new Set() });

    void this.consume(id, handle);

    this.logger.info('session created', { sessionId: id, provider, resumed: !!resumeProviderSessionId });
    return session;
  }

  private async consume(id: string, handle: ProviderSessionHandle): Promise<void> {
    const runtime = this.runtime.get(id);
    if (!runtime) return;

    this.mutateSession(id, (session) => {
      session.status = 'running';
    });

    for await (const event of handle.events) {
      this.mutateSession(id, (session) => this.applyStatusTransition(session, event));

      if (runtime.events.length < MAX_STORED_EVENTS_PER_SESSION) {
        const index = runtime.events.length;
        const envelope: AgentEventEnvelope = { ...event, sequence: index, timestamp: new Date().toISOString() };
        runtime.events.push(envelope);
        for (const listener of runtime.listeners) listener(index, envelope);
      } else {
        this.logger.warn('session event history full; further events will not be replayable', { sessionId: id });
      }
    }
  }

  /** Reads the current record from the store, applies `fn`, writes it back — the store is the source of truth, never a mutated-in-place reference held elsewhere. */
  private mutateSession(id: string, fn: (session: AgentSession) => void): void {
    const session = this.store.get(id);
    if (!session) return;
    fn(session);
    this.store.update(id, session);
  }

  private applyStatusTransition(session: AgentSession, event: AgentEvent): void {
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

  get(id: string): AgentSession | undefined {
    return this.store.get(id);
  }

  list(): AgentSession[] {
    return this.store.list();
  }

  /** Replays stored events from `sinceIndex` onward, then delivers live events as they arrive. */
  subscribe(
    id: string,
    sinceIndex: number,
    listener: (index: number, event: AgentEventEnvelope) => void,
  ): (() => void) | undefined {
    const runtime = this.runtime.get(id);
    if (!runtime) return undefined;

    for (let i = sinceIndex; i < runtime.events.length; i++) {
      listener(i, runtime.events[i] as AgentEventEnvelope);
    }

    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  }

  async cancel(id: string): Promise<boolean> {
    const runtime = this.runtime.get(id);
    if (!runtime) return false;
    await runtime.handle.cancel();
    return true;
  }

  async remove(id: string): Promise<boolean> {
    const session = this.store.get(id);
    if (!session) return false;
    const runtime = this.runtime.get(id);
    if ((session.status === 'starting' || session.status === 'running') && runtime) {
      await runtime.handle.cancel();
    }
    this.runtime.delete(id);
    this.store.delete(id);
    return true;
  }

  /** Cancels every in-flight session. Called on daemon shutdown to avoid orphaned CLI processes. */
  async cancelAll(): Promise<void> {
    await Promise.all(
      this.store
        .list()
        .filter((session) => session.status === 'starting' || session.status === 'running')
        .map((session) => this.runtime.get(session.id)?.handle.cancel())
        .filter((p): p is Promise<void> => !!p),
    );
  }
}
