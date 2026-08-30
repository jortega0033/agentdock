import { describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  AgentEventEnvelope,
  ProviderId,
  ProviderStatus,
} from '@agent-dock/shared';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type {
  AgentProvider,
  ProviderSessionHandle,
  StartSessionOptions,
} from '@agent-dock/agent-runtime';
import { SessionManager } from '../src/session-manager.js';

const TERMINAL_TYPES = new Set(['session.completed', 'session.failed', 'session.cancelled']);

/**
 * A hand-rolled controllable event source — deliberately not the real `FakeProvider` (its
 * scenarios are fixed, short sequences and can't be driven event-by-event, which every test here
 * needs: pushing an exact count past the cap, holding a session open until explicitly cancelled,
 * asserting nothing arrives after a terminal push). Same push/pull shape as the real
 * `AsyncChannel` internals, reimplemented locally since that class isn't part of
 * `@agent-dock/agent-runtime`'s public surface (AD-09).
 */
function makeControllableSession() {
  const queue: AgentEvent[] = [];
  const waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  let closed = false;
  let cancelled = false;

  function push(event: AgentEvent): void {
    const waiter = waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else queue.push(event);
  }

  function finish(): void {
    if (closed) return;
    closed = true;
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async function* events(): AsyncGenerator<AgentEvent, void, void> {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as AgentEvent;
        continue;
      }
      if (closed) return;
      const result = await new Promise<IteratorResult<AgentEvent>>((resolve) =>
        waiters.push(resolve),
      );
      if (result.done) return;
      yield result.value;
    }
  }

  const handle: ProviderSessionHandle = {
    events: events(),
    cancel: async () => {
      cancelled = true;
    },
  };

  return { handle, push, finish, isCancelled: () => cancelled };
}

type ControllableSession = ReturnType<typeof makeControllableSession>;

class TestProvider implements AgentProvider {
  readonly id: ProviderId;
  readonly name = 'Test Provider';
  readonly sessions = new Map<string, ControllableSession>();

  constructor(id: ProviderId = 'claude') {
    this.id = id;
  }

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: true,
      authenticated: 'authenticated',
      capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
    };
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    const session = makeControllableSession();
    this.sessions.set(options.sessionId, session);
    return session.handle;
  }
}

function setup() {
  const provider = new TestProvider();
  const registry = new ProviderRegistry();
  registry.register(provider);
  const sessionManager = new SessionManager(registry, noopLogger);
  return { provider, sessionManager };
}

/** Lets any already-queued microtask/macrotask chain (push -> waiter -> for-await -> listener) settle. */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectUntilTerminal(
  sessionManager: SessionManager,
  id: string,
): Promise<AgentEventEnvelope[]> {
  return new Promise((resolve) => {
    const out: AgentEventEnvelope[] = [];
    const unsubscribe = sessionManager.subscribe(id, 0, (_index, event) => {
      out.push(event);
      if (TERMINAL_TYPES.has(event.type)) {
        unsubscribe?.();
        resolve(out);
      }
    });
  });
}

describe('SessionManager — normal lifecycle', () => {
  it('starts a session with status "starting", moving to "running" before create() even returns', () => {
    const { sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    // create() is synchronous; consume()'s synchronous prefix (which sets 'running') has already
    // run by the time it returns, even though consume() itself is an async function. Both reads
    // below see 'running': MemorySessionStore.get() returns the same object reference create()
    // handed back, so mutateSession()'s in-place update is visible through either handle.
    expect(sessionManager.get(session.id)?.status).toBe('running');
    expect(session.status).toBe('running');
  });

  it('delivers a live event to an already-subscribed listener', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;

    const received: AgentEventEnvelope[] = [];
    sessionManager.subscribe(session.id, 0, (_i, event) => received.push(event));

    testSession.push({ type: 'assistant.message', text: 'hello' });
    await tick();

    expect(received).toEqual([
      { type: 'assistant.message', text: 'hello', sequence: 0, timestamp: received[0]?.timestamp },
    ]);
  });

  it('transitions to "completed" on session.completed', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    testSession.push({ type: 'session.completed', providerSessionId: 'thread-1' });
    testSession.finish();
    await tick();
    const record = sessionManager.get(session.id);
    expect(record?.status).toBe('completed');
    expect(record?.providerSessionId).toBe('thread-1');
    expect(record?.completedAt).toBeDefined();
  });

  it('transitions to "failed" on session.failed, recording the error message', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    testSession.push({ type: 'session.failed', message: 'boom' });
    testSession.finish();
    await tick();
    const record = sessionManager.get(session.id);
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('boom');
  });

  it('transitions to "cancelled" on session.cancelled', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    testSession.push({ type: 'session.cancelled' });
    testSession.finish();
    await tick();
    expect(sessionManager.get(session.id)?.status).toBe('cancelled');
  });
});

describe('SessionManager — terminal guarantees', () => {
  it('delivers exactly one terminal event, and it is last', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    const collected = collectUntilTerminal(sessionManager, session.id);

    testSession.push({ type: 'assistant.message', text: 'a' });
    testSession.push({ type: 'usage', inputTokens: 1, outputTokens: 1 });
    testSession.push({ type: 'session.completed' });
    testSession.finish();

    const events = await collected;
    const terminalIndices = events
      .map((e, i) => (TERMINAL_TYPES.has(e.type) ? i : -1))
      .filter((i) => i >= 0);
    expect(terminalIndices).toEqual([events.length - 1]);
  });

  it('never emits anything after the terminal event, even if the source pushes more', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    const received: AgentEventEnvelope[] = [];
    sessionManager.subscribe(session.id, 0, (_i, event) => received.push(event));

    testSession.push({ type: 'session.completed' });
    testSession.finish(); // closes the source; nothing further can be pushed through it anyway
    await tick();

    expect(received.map((e) => e.type)).toEqual(['session.completed']);
  });
});

describe('SessionManager — past the history cap (AD-01)', () => {
  it('still delivers every event live, including the terminal event, past MAX_STORED_EVENTS_PER_SESSION, with sequence staying monotonic', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    const collected = collectUntilTerminal(sessionManager, session.id);

    const OVER_CAP = 5_010; // MAX_STORED_EVENTS_PER_SESSION is 5,000
    for (let i = 0; i < OVER_CAP; i++) {
      testSession.push({ type: 'assistant.message', text: `msg ${i}` });
    }
    testSession.push({ type: 'session.completed' });
    testSession.finish();

    const events = await collected;
    expect(events.length).toBe(OVER_CAP + 1);
    expect(events.at(-1)?.type).toBe('session.completed');
    expect(events.map((e) => e.sequence)).toEqual(events.map((_e, i) => i)); // 0..N, no gaps, no reset at the cap
  }, 15_000);

  it('a fresh subscriber past the cap gets nothing to replay (history stopped growing) but still gets the terminal event live', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;

    for (let i = 0; i < 5_005; i++)
      testSession.push({ type: 'assistant.message', text: `msg ${i}` });
    await tick(20); // let the history buffer actually fill and cap out before subscribing

    const received: AgentEventEnvelope[] = [];
    const unsubscribe = sessionManager.subscribe(session.id, 0, (_i, event) =>
      received.push(event),
    );
    expect(unsubscribe).toBeDefined(); // session still exists — replay just has nothing past the cap to offer
    expect(received.length).toBe(5_000); // exactly MAX_STORED_EVENTS_PER_SESSION replayed

    testSession.push({ type: 'session.completed' });
    testSession.finish();
    await tick(20);

    expect(received.at(-1)?.type).toBe('session.completed');
  }, 15_000);
});

describe('SessionManager — replay', () => {
  it('a subscriber connecting after events were already emitted receives them via replay, in order', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;

    testSession.push({ type: 'assistant.message', text: 'one' });
    testSession.push({ type: 'assistant.message', text: 'two' });
    testSession.push({ type: 'assistant.message', text: 'three' });
    await tick();

    const replayed: AgentEventEnvelope[] = [];
    sessionManager.subscribe(session.id, 0, (_i, event) => replayed.push(event));

    expect(replayed.map((e) => (e as { text: string }).text)).toEqual(['one', 'two', 'three']);
    expect(replayed.map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it('replay is followed by live events with no gap, duplicate, or reset in sequence', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;

    testSession.push({ type: 'assistant.message', text: 'one' });
    testSession.push({ type: 'assistant.message', text: 'two' });
    await tick();

    const received: AgentEventEnvelope[] = [];
    sessionManager.subscribe(session.id, 0, (_i, event) => received.push(event));

    testSession.push({ type: 'assistant.message', text: 'three' });
    await tick();

    expect(received.map((e) => (e as { text: string }).text)).toEqual(['one', 'two', 'three']);
    expect(received.map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it('resuming from a mid-stream sequence (Last-Event-ID semantics) replays only what came after it', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;

    testSession.push({ type: 'assistant.message', text: 'one' }); // sequence 0
    testSession.push({ type: 'assistant.message', text: 'two' }); // sequence 1
    testSession.push({ type: 'assistant.message', text: 'three' }); // sequence 2
    await tick();

    const resumed: AgentEventEnvelope[] = [];
    sessionManager.subscribe(session.id, 2, (_i, event) => resumed.push(event)); // sinceIndex = lastSeenSequence + 1

    expect(resumed.map((e) => (e as { text: string }).text)).toEqual(['three']);
  });
});

describe('SessionManager — cancellation', () => {
  it('cancel() on a running session calls the handle and returns true', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    expect(await sessionManager.cancel(session.id)).toBe(true);
    expect(testSession.isCancelled()).toBe(true);
  });

  it('cancel() on an already-terminal session returns false, not a misleading success (AD-11)', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    testSession.push({ type: 'session.completed' });
    testSession.finish();
    await tick();

    expect(await sessionManager.cancel(session.id)).toBe(false);
  });

  it('cancel() on an unknown session id returns false', async () => {
    const { sessionManager } = setup();
    expect(await sessionManager.cancel('does-not-exist')).toBe(false);
  });

  it('a cancel racing with natural completion resolves to session.cancelled, never session.completed after it', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    const collected = collectUntilTerminal(sessionManager, session.id);

    void sessionManager.cancel(session.id); // the real provider would race its own kill(); here we just simulate the outcome it must produce
    testSession.push({ type: 'session.cancelled' });
    testSession.finish();

    const events = await collected;
    expect(events.at(-1)?.type).toBe('session.cancelled');
    expect(events.some((e) => e.type === 'session.completed')).toBe(false);
  });
});

describe('SessionManager — removal', () => {
  it('remove() on a running session cancels it first, then deletes the record', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    expect(await sessionManager.remove(session.id)).toBe(true);
    expect(testSession.isCancelled()).toBe(true);
    expect(sessionManager.get(session.id)).toBeUndefined();
  });

  it('remove() on a completed session just deletes it (nothing to cancel)', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    testSession.push({ type: 'session.completed' });
    testSession.finish();
    await tick();

    expect(await sessionManager.remove(session.id)).toBe(true);
    expect(sessionManager.get(session.id)).toBeUndefined();
  });

  it('remove() on an unknown id returns false', async () => {
    const { sessionManager } = setup();
    expect(await sessionManager.remove('does-not-exist')).toBe(false);
  });

  it('subscribing to a session removed between the existence check and subscribe() returns undefined rather than throwing', async () => {
    // Mirrors the daemon route's own defensive check (apps/daemon/src/routes/sessions.ts) for the
    // GET-events-vs-concurrent-DELETE race the audit flagged: subscribe() itself must fail safely.
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    testSession.push({ type: 'session.completed' });
    testSession.finish();
    await tick();
    await sessionManager.remove(session.id);

    expect(sessionManager.subscribe(session.id, 0, () => {})).toBeUndefined();
  });
});

describe('SessionManager — bounded retention of completed sessions (AD-11)', () => {
  it('evicts the oldest completed session once more than the retention cap have finished', async () => {
    const { provider, sessionManager } = setup();
    const RETENTION_CAP = 50; // MAX_RETAINED_COMPLETED_SESSIONS in session-manager.ts

    const ids: string[] = [];
    for (let i = 0; i < RETENTION_CAP + 1; i++) {
      const session = sessionManager.create('claude', '/tmp', `prompt ${i}`);
      ids.push(session.id);
      const testSession = provider.sessions.get(session.id)!;
      testSession.push({ type: 'session.completed' });
      testSession.finish();
      await tick();
    }

    // The very first session should have been evicted once the (RETENTION_CAP + 1)th completed.
    expect(sessionManager.get(ids[0] as string)).toBeUndefined();
    // The most recent one is still there.
    expect(sessionManager.get(ids[ids.length - 1] as string)).toBeDefined();
  }, 15_000);

  it('cancelAll() awaits active sessions finishing, bounded by a timeout, and does not touch already-terminal ones', async () => {
    const { provider, sessionManager } = setup();
    const running = sessionManager.create('claude', '/tmp', 'hi');
    const runningSession = provider.sessions.get(running.id)!;

    const completed = sessionManager.create('claude', '/tmp', 'hi');
    const completedSession = provider.sessions.get(completed.id)!;
    completedSession.push({ type: 'session.completed' });
    completedSession.finish();
    await tick();

    // Simulate the provider actually reacting to cancellation, the way run-session.ts does.
    void runningSession.handle.cancel().then(() => {
      runningSession.push({ type: 'session.cancelled' });
      runningSession.finish();
    });

    await sessionManager.cancelAll(2_000);

    expect(sessionManager.get(running.id)?.status).toBe('cancelled');
    expect(runningSession.isCancelled()).toBe(true);
    expect(completedSession.isCancelled()).toBe(false); // never touched — it was already terminal
  }, 10_000);
});
