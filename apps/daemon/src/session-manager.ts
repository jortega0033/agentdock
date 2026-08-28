import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentSession, ProviderId } from '@agent-dock/shared';
import type { Logger, ProviderRegistry, ProviderSessionHandle } from '@agent-dock/agent-runtime';

interface SessionEntry {
  session: AgentSession;
  handle: ProviderSessionHandle;
  events: AgentEvent[];
  listeners: Set<(index: number, event: AgentEvent) => void>;
}

const MAX_STORED_EVENTS_PER_SESSION = 5_000;

/**
 * In-memory session registry. Sessions and their event history live only for the daemon
 * process's lifetime — there is no persistence layer in the MVP, by design (see docs/architecture.md).
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly logger: Logger,
  ) {}

  create(provider: ProviderId, cwd: string, prompt: string): AgentSession {
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

    const handle = providerImpl.startSession({ sessionId: id, cwd, prompt });
    const entry: SessionEntry = { session, handle, events: [], listeners: new Set() };
    this.sessions.set(id, entry);

    void this.consume(entry);

    this.logger.info('session created', { sessionId: id, provider });
    return session;
  }

  private async consume(entry: SessionEntry): Promise<void> {
    entry.session.status = 'running';
    for await (const event of entry.handle.events) {
      this.applyStatusTransition(entry.session, event);

      if (entry.events.length < MAX_STORED_EVENTS_PER_SESSION) {
        entry.events.push(event);
        const index = entry.events.length - 1;
        for (const listener of entry.listeners) listener(index, event);
      } else {
        this.logger.warn('session event history full; further events will not be replayable', {
          sessionId: entry.session.id,
        });
      }
    }
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
    return this.sessions.get(id)?.session;
  }

  list(): AgentSession[] {
    return [...this.sessions.values()].map((entry) => entry.session);
  }

  /** Replays stored events from `sinceIndex` onward, then delivers live events as they arrive. */
  subscribe(
    id: string,
    sinceIndex: number,
    listener: (index: number, event: AgentEvent) => void,
  ): (() => void) | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;

    for (let i = sinceIndex; i < entry.events.length; i++) {
      listener(i, entry.events[i] as AgentEvent);
    }

    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  async cancel(id: string): Promise<boolean> {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    await entry.handle.cancel();
    return true;
  }

  async remove(id: string): Promise<boolean> {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    if (entry.session.status === 'starting' || entry.session.status === 'running') {
      await entry.handle.cancel();
    }
    this.sessions.delete(id);
    return true;
  }

  /** Cancels every in-flight session. Called on daemon shutdown to avoid orphaned CLI processes. */
  async cancelAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((entry) => entry.session.status === 'starting' || entry.session.status === 'running')
        .map((entry) => entry.handle.cancel()),
    );
  }
}
