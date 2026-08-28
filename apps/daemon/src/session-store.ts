import type { AgentSession } from '@agent-dock/shared';

/**
 * Where SessionManager keeps `AgentSession` records — deliberately synchronous, since the only
 * implementation (`MemorySessionStore`) is. A future persistent store (e.g. SQLite) would likely
 * need this interface, and every call site in SessionManager, to become async; that's a real,
 * larger change intentionally left for when it's actually needed rather than half-implemented
 * (an untested `Promise<void>` union here today would just be a place for a future store to
 * silently break the current synchronous call sites).
 *
 * Scope is deliberately narrow: only the `AgentSession` record. A session's live process handle
 * (an `AsyncGenerator` plus a `cancel()` closure) isn't something you can "store" at all, and its
 * buffered event history is kept as separate runtime-only state in SessionManager — see
 * docs/architecture.md#sessionstore for why persisting replayable event history isn't part of
 * what this interface owns.
 */
export interface SessionStore {
  create(session: AgentSession): void;
  get(id: string): AgentSession | undefined;
  update(id: string, session: AgentSession): void;
  delete(id: string): void;
  list(): AgentSession[];
}

/**
 * The only `SessionStore` implementation in this milestone, and the daemon's default — sessions
 * remain fully in-memory and do not survive a daemon restart, by design. Swapping in a persistent
 * store later should only require implementing this interface, not touching SessionManager.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AgentSession>();

  create(session: AgentSession): void {
    this.sessions.set(session.id, session);
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  update(id: string, session: AgentSession): void {
    this.sessions.set(id, session);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  list(): AgentSession[] {
    return [...this.sessions.values()];
  }
}
