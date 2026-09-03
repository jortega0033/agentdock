import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentCommandV2,
  AgentEvent,
  AgentEventEnvelope,
  AgentEventV2,
  AgentSession,
  CapabilitySelection,
  ProviderId,
  ProviderStatus,
  ProviderTransportV2,
} from '@agent-dock/shared';
import {
  InteractiveSessionError,
  ProviderRegistry,
  ProviderTransportStartupError,
  noopLogger,
} from '@agent-dock/agent-runtime';
import type {
  AcceptedWorkState,
  AgentProvider,
  InteractiveProviderSessionHandle,
  ProviderDetectionOptions,
  ProviderRuntimeMetadata,
  ProviderSessionHandle,
  StartInteractiveSessionOptions,
  StartSessionOptions,
} from '@agent-dock/agent-runtime';
import { SessionManager, type SessionManagerSecurityOptions } from '../src/session-manager.js';
import { SessionAdmissionController, SessionCapacityError } from '../src/session-admission.js';
import { AuditStore } from '../src/audit-store.js';
import { V2ProviderStartupError, V2SessionFacade } from '../src/v2-session-facade.js';
import { planLegacyProviderFallback, type ProviderV2Manifest } from '../src/provider-v2.js';
import { legacyRuntimeScope } from '../src/v2-legacy-provider.js';
import { resolveWorkspaceIdentity, type WorkspaceIdentity } from '../src/workspace-identity.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';
import { MemoryExecutionGraphStore } from '../src/execution-graph-store.js';
import { MemorySessionStore } from '../src/session-store.js';
import { AttachmentStore } from '../src/attachment-store.js';
import { SubagentGraphStore } from '../src/subagent-graph-store.js';

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

  it('does not log payloads thrown by a session listener', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const provider = new TestProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessionManager = new SessionManager(registry, logger);
    const session = sessionManager.create('claude', '/tmp', 'PROMPT_CANARY_listener');
    const testSession = provider.sessions.get(session.id)!;
    sessionManager.subscribe(session.id, 0, () => {
      throw new Error('sk-proj-CREDENTIAL_CANARY RAW_APPROVAL_CANARY');
    });

    testSession.push({ type: 'assistant.message', text: 'safe event' });
    await tick();

    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('CREDENTIAL_CANARY');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('RAW_APPROVAL_CANARY');
    expect(logger.warn).toHaveBeenCalledWith('session listener failed', {
      sessionId: session.id,
    });
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

describe('SessionManager — v1 replay byte ceiling (issue #51)', () => {
  it('stops growing history once 16 MiB of replay would be exceeded, well before the 5,000-event cap', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    const collected = collectUntilTerminal(sessionManager, session.id);

    // Each 'é' is 2 UTF-8 bytes, so 256K repetitions serialize to just over 512 KiB per event --
    // safely under the 1 MiB per-envelope ceiling, but 40 of them exceed the 16 MiB session
    // ceiling (~20 MiB) long before the 5,000-event count cap could ever be reached. Multi-byte so
    // byte accounting (not character count) is what's actually being exercised.
    const bigText = 'é'.repeat(256 * 1024);
    const eventCount = 40;
    for (let i = 0; i < eventCount; i++) {
      testSession.push({ type: 'assistant.message', text: bigText });
    }
    testSession.push({ type: 'session.completed' });
    testSession.finish();

    const delivered = await collected; // every event still arrives live regardless of replay storage
    expect(delivered.length).toBe(eventCount + 1);

    // A fresh subscriber can only replay whatever fit under the byte ceiling, not everything sent.
    const replayed: AgentEventEnvelope[] = [];
    const unsubscribe = sessionManager.subscribe(session.id, 0, (_i, event) =>
      replayed.push(event),
    );
    unsubscribe?.();
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.length).toBeLessThan(eventCount + 1);
  }, 15_000);

  it('logs the "history full" warning exactly once per session, not once per subsequent event', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const provider = new TestProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessionManager = new SessionManager(registry, logger);
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    const collected = collectUntilTerminal(sessionManager, session.id);

    const bigText = 'x'.repeat(512 * 1024);
    for (let i = 0; i < 40; i++) testSession.push({ type: 'assistant.message', text: bigText });
    testSession.push({ type: 'session.completed' });
    testSession.finish();
    await collected;

    const fullWarnings = logger.warn.mock.calls.filter(
      ([message]) => message === 'session event history full; further events will not be replayable',
    );
    expect(fullWarnings.length).toBe(1);
  }, 15_000);
});

describe('SessionManager — v1 oversized-envelope safety (issue #51)', () => {
  it('fails the session with exactly one terminal event and reaps the provider when one envelope exceeds the 1 MiB frame ceiling', async () => {
    const { provider, sessionManager } = setup();
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    const collected = collectUntilTerminal(sessionManager, session.id);

    testSession.push({ type: 'assistant.message', text: 'safe event' });
    testSession.push({ type: 'assistant.message', text: 'x'.repeat(2 * 1024 * 1024) }); // over 1 MiB
    testSession.push({ type: 'assistant.message', text: 'must never arrive' }); // source keeps pushing

    const events = await collected;
    const terminalIndices = events
      .map((e, i) => (TERMINAL_TYPES.has(e.type) ? i : -1))
      .filter((i) => i >= 0);
    expect(terminalIndices).toEqual([events.length - 1]); // exactly one terminal event, last
    expect(events.at(-1)).toMatchObject({ type: 'session.failed' });
    expect(events.some((e) => 'text' in e && e.text === 'must never arrive')).toBe(false);

    await tick(20);
    expect(testSession.isCancelled()).toBe(true); // the provider was reaped, not left running
    expect(sessionManager.get(session.id)?.status).toBe('failed');
  }, 15_000);

  it('never logs the oversized event content itself', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const provider = new TestProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessionManager = new SessionManager(registry, logger);
    const session = sessionManager.create('claude', '/tmp', 'hi');
    const testSession = provider.sessions.get(session.id)!;
    const collected = collectUntilTerminal(sessionManager, session.id);

    testSession.push({ type: 'assistant.message', text: `PAYLOAD_CANARY${'x'.repeat(2 * 1024 * 1024)}` });
    await collected;

    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PAYLOAD_CANARY');
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

describe('SessionManager — bounded retention of completed runtimes (AD-11)', () => {
  it('evicts the oldest replay runtime but keeps protocol-v2 queryable metadata', async () => {
    const { provider, sessionManager } = setup();
    const RETENTION_CAP = 50; // MAX_RETAINED_COMPLETED_RUNTIMES in session-manager.ts

    const ids: string[] = [];
    for (let i = 0; i < RETENTION_CAP + 1; i++) {
      const session = sessionManager.create('claude', '/tmp', `prompt ${i}`, undefined, 2);
      ids.push(session.id);
      const testSession = provider.sessions.get(session.id)!;
      testSession.push({ type: 'session.completed' });
      testSession.finish();
      await tick();
    }

    // Runtime replay is bounded independently from durable/queryable session metadata.
    expect(sessionManager.get(ids[0] as string)).toBeDefined();
    expect(sessionManager.subscribe(ids[0] as string, 0, () => {})).toBeUndefined();
    // The most recent one is still there.
    expect(sessionManager.get(ids[ids.length - 1] as string)).toBeDefined();
  }, 15_000);

  it('retains the legacy 50-session metadata bound for protocol v1', async () => {
    const { provider, sessionManager } = setup();
    const ids: string[] = [];
    for (let index = 0; index <= 50; index += 1) {
      const session = sessionManager.create('claude', '/tmp', `prompt ${index}`);
      ids.push(session.id);
      const testSession = provider.sessions.get(session.id)!;
      testSession.push({ type: 'session.completed' });
      testSession.finish();
      await tick();
    }
    expect(sessionManager.get(ids[0] as string)).toBeUndefined();
    expect(sessionManager.get(ids.at(-1) as string)).toBeDefined();
  }, 15_000);

  it('removes protocol-v2 compatibility records that never reached graph reservation', () => {
    const store = new MemorySessionStore();
    const session: AgentSession = {
      id: uuid(90_000),
      provider: 'claude',
      cwd: '/tmp',
      prompt: '',
      status: 'failed',
      startedAt: '2026-09-01T08:00:00.000Z',
      completedAt: '2026-09-01T08:00:01.000Z',
    };
    store.create(session, 2);

    new SessionManager(new ProviderRegistry(), noopLogger, store, {
      executionGraphStore: new MemoryExecutionGraphStore(),
    });

    expect(store.get(session.id)).toBeUndefined();
  });

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

  it('bounds cancelAll even when a provider close never resolves', async () => {
    const { provider, sessionManager } = setup();
    const running = sessionManager.create('claude', '/tmp', 'hi');
    const runningSession = provider.sessions.get(running.id)!;
    runningSession.handle.cancel = () => new Promise<void>(() => undefined);
    const startedAt = Date.now();

    await sessionManager.cancelAll(20);

    expect(Date.now() - startedAt).toBeLessThan(500);
    runningSession.finish();
  });

  it('keeps the default shutdown window open for the full interactive reap bound', async () => {
    vi.useFakeTimers();
    try {
      const closeGate = deferred<void>();
      const { interactive, sessionManager } = await setupInteractive({
        close: () => closeGate.promise,
      });
      let settled = false;
      const cancelling = sessionManager.cancelAll().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(15_500);

      expect(interactive.closeCalls()).toBe(1);
      expect(settled).toBe(false);

      interactive.push({ type: 'session.cancelled', reason: 'reaped' });
      interactive.finish();
      closeGate.resolve();
      await cancelling;

      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface InteractiveSessionOptions {
  accepted?: Promise<AcceptedWorkState>;
  send?: (command: AgentCommandV2, index: number) => Promise<void>;
  resolveInteraction?: (requestId: string, reason: string) => Promise<void>;
  interrupt?: () => Promise<void>;
  close?: () => Promise<void>;
  providerSessionId?: string;
  runtimeMetadata?: ProviderRuntimeMetadata;
}

function makeControllableInteractiveSession(options: InteractiveSessionOptions = {}) {
  const queue: AgentEventV2[] = [];
  const waiters: Array<(result: IteratorResult<AgentEventV2>) => void> = [];
  const sent: AgentCommandV2[] = [];
  let closed = false;
  let interruptCalls = 0;
  let closeCalls = 0;

  function push(event: AgentEventV2): void {
    if (closed) throw new Error('interactive test session is closed');
    const waiter = waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else queue.push(event);
  }

  function finish(): void {
    if (closed) return;
    closed = true;
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async function* events(): AsyncGenerator<AgentEventV2, void, void> {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as AgentEventV2;
        continue;
      }
      if (closed) return;
      const result = await new Promise<IteratorResult<AgentEventV2>>((resolve) =>
        waiters.push(resolve),
      );
      if (result.done) return;
      yield result.value;
    }
  }

  const handle: InteractiveProviderSessionHandle = {
    events: events(),
    accepted: options.accepted ?? Promise.resolve('accepted'),
    ...(options.providerSessionId ? { providerSessionId: options.providerSessionId } : {}),
    ...(options.runtimeMetadata ? { runtimeMetadata: options.runtimeMetadata } : {}),
    send: async (command) => {
      const index = sent.length;
      sent.push(command);
      await options.send?.(command, index);
    },
    resolveInteraction: async (requestId, reason) => {
      await options.resolveInteraction?.(requestId, reason);
    },
    interrupt: async () => {
      interruptCalls += 1;
      await options.interrupt?.();
    },
    close: async () => {
      closeCalls += 1;
      if (options.close) {
        await options.close();
        return;
      }
      push({ type: 'session.cancelled', reason: 'test close' });
      finish();
    },
  };

  return {
    handle,
    push,
    finish,
    sent,
    interruptCalls: () => interruptCalls,
    closeCalls: () => closeCalls,
  };
}

type ControllableInteractiveSession = ReturnType<typeof makeControllableInteractiveSession>;

class InteractiveTestProvider implements AgentProvider {
  readonly id: ProviderId;
  readonly name = 'Interactive Test Provider';
  readonly interactiveOptions: StartInteractiveSessionOptions[] = [];
  startupHook?: (options: StartInteractiveSessionOptions) => Promise<void>;

  constructor(
    private readonly interactive: ControllableInteractiveSession,
    id: ProviderId = 'claude',
  ) {
    this.id = id;
  }

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: true,
      authenticated: 'authenticated',
      capabilities: {
        resume: false,
        cancellation: true,
        tools: false,
        usage: false,
        thinking: false,
      },
    };
  }

  startSession(_options: StartSessionOptions): ProviderSessionHandle {
    return makeControllableSession().handle;
  }

  async startInteractiveSession(
    options: StartInteractiveSessionOptions,
  ): Promise<InteractiveProviderSessionHandle> {
    this.interactiveOptions.push(options);
    await this.startupHook?.(options);
    return this.interactive.handle;
  }
}

class PendingInteractiveProvider implements AgentProvider {
  readonly id: ProviderId = 'claude';
  readonly name = 'Pending Interactive Test Provider';
  readonly interactiveOptions: StartInteractiveSessionOptions[] = [];
  aborts = 0;

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: true,
      authenticated: 'authenticated',
      capabilities: {
        resume: false,
        cancellation: true,
        tools: false,
        usage: false,
        thinking: false,
      },
    };
  }

  startSession(_options: StartSessionOptions): ProviderSessionHandle {
    return makeControllableSession().handle;
  }

  startInteractiveSession(
    options: StartInteractiveSessionOptions,
  ): Promise<InteractiveProviderSessionHandle> {
    this.interactiveOptions.push(options);
    return new Promise((_resolve, reject) => {
      const rejectAborted = () => {
        this.aborts += 1;
        reject(new Error('interactive startup aborted'));
      };
      if (options.signal?.aborted) rejectAborted();
      else options.signal?.addEventListener('abort', rejectAborted, { once: true });
    });
  }
}

const INTERACTIVE_TRANSPORT: ProviderTransportV2 = {
  id: 'memory',
  priority: 1,
  stability: 'stable',
  possibleEffects: [],
  effectsComplete: true,
};

const INTERACTIVE_SELECTION: CapabilitySelection = {
  transport: INTERACTIVE_TRANSPORT.id,
  enabled: [],
  unavailableOptional: [],
  possibleEffects: [],
  effectsComplete: true,
};

const APPROVAL_SELECTION: CapabilitySelection = {
  ...INTERACTIVE_SELECTION,
  enabled: [
    {
      id: 'interaction.approval',
      constraints: { kind: 'interaction', timeoutMs: 60_000, maxPayloadBytes: 64 * 1024 },
    },
  ],
};

const INTERACTIVE_TURN_ID = '123e4567-e89b-42d3-a456-426614174201';
const INTERACTIVE_EXECUTION_ID = '123e4567-e89b-42d3-a456-426614174202';

async function setupInteractive(
  options: InteractiveSessionOptions = {},
  security: SessionManagerSecurityOptions = {},
) {
  const interactive = makeControllableInteractiveSession(options);
  const provider = new InteractiveTestProvider(interactive);
  const registry = new ProviderRegistry();
  registry.register(provider);
  const sessionManager = new SessionManager(registry, noopLogger, undefined, security);
  const session = await sessionManager.createInteractive(
    provider.id,
    '/tmp',
    'hello',
    INTERACTIVE_SELECTION,
    INTERACTIVE_TRANSPORT,
    INTERACTIVE_EXECUTION_ID,
    INTERACTIVE_TURN_ID,
  );
  return { interactive, provider, sessionManager, session };
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function followUpCommand(
  sessionId: string,
  index: number,
  text = `command ${index}`,
): Extract<AgentCommandV2, { type: 'input.follow_up' }> {
  return {
    type: 'input.follow_up',
    commandId: uuid(index),
    sessionId,
    turnId: INTERACTIVE_TURN_ID,
    content: [{ type: 'text', id: uuid(10_000 + index), text }],
  };
}

async function finishInteractive(
  interactive: ControllableInteractiveSession,
  status: 'completed' | 'cancelled' = 'completed',
): Promise<void> {
  interactive.push(
    status === 'completed' ? { type: 'session.completed' } : { type: 'session.cancelled' },
  );
  interactive.finish();
  await tick();
}

function createPendingInteractive(sessionManager: SessionManager, signal?: AbortSignal) {
  return sessionManager.createInteractive(
    'claude',
    '/tmp',
    'pending',
    INTERACTIVE_SELECTION,
    INTERACTIVE_TRANSPORT,
    INTERACTIVE_EXECUTION_ID,
    INTERACTIVE_TURN_ID,
    signal,
  );
}

async function trustedWorkspaceFixture(): Promise<{
  auditStore: AuditStore;
  cleanup(): Promise<void>;
  identity: WorkspaceIdentity;
  trustStore: WorkspaceTrustStore;
}> {
  const root = await mkdtemp(join(tmpdir(), 'agent-dock-session-security-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const identity = await resolveWorkspaceIdentity(workspace);
  const trustStore = new WorkspaceTrustStore(join(root, 'workspace-trust.json'));
  await trustStore.setTrusted(identity);
  return {
    auditStore: new AuditStore(join(root, 'audit.jsonl')),
    cleanup: () => rm(root, { recursive: true, force: true }),
    identity,
    trustStore,
  };
}

function approvalRequest(requestId: string): Extract<AgentEventV2, { type: 'approval.requested' }> {
  return {
    type: 'approval.requested',
    turnId: INTERACTIVE_TURN_ID,
    requestId,
    title: 'Write file',
    action: 'write',
    target: 'workspace file',
    possibleEffects: ['filesystem_write'],
    effectsComplete: true,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    permission: {
      actionClass: 'filesystem',
      operation: 'filesystem.write',
      targetFingerprint: 'a'.repeat(64),
      safeTargetSummary: 'workspace file',
      risk: 'normal',
      effectsComplete: true,
      mcpDestructive: false,
    },
  };
}

function questionRequest(requestId: string): Extract<AgentEventV2, { type: 'question.requested' }> {
  return {
    type: 'question.requested',
    turnId: INTERACTIVE_TURN_ID,
    requestId,
    questions: [
      {
        id: uuid(70_000),
        title: 'Choose a value',
        prompt: 'Which value?',
        allowsFreeText: true,
      },
    ],
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe('SessionManager — provider startup evidence', () => {
  it('always passes a provider snapshot and explicit untrusted evidence without a verified workspace', async () => {
    const { interactive, provider } = await setupInteractive();

    expect(provider.interactiveOptions).toHaveLength(1);
    expect(provider.interactiveOptions[0]?.providerStatus).toMatchObject({
      id: provider.id,
      installed: true,
      authenticated: 'authenticated',
    });
    expect(provider.interactiveOptions[0]?.workspaceTrust).toEqual({ state: 'untrusted' });
    await finishInteractive(interactive);
  });

  it('passes the exact detected snapshot and verified workspace incarnation with its trust epoch', async () => {
    const fixture = await trustedWorkspaceFixture();
    const interactive = makeControllableInteractiveSession();
    const provider = new InteractiveTestProvider(interactive);
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessionManager = new SessionManager(registry, noopLogger, undefined, {
      auditStore: fixture.auditStore,
      trustStore: fixture.trustStore,
    });
    const providerStatus: ProviderStatus = {
      id: provider.id,
      name: provider.name,
      installed: true,
      authenticated: 'authenticated',
      authSource: 'chatgpt',
      accountFingerprint: 'a'.repeat(64),
      selectedModel: 'gpt-5.4',
      executablePath: '/verified/provider',
      version: '1.2.3',
      capabilities: { cancellation: true },
    };
    try {
      await sessionManager.createInteractive(
        provider.id,
        fixture.identity.canonicalPath,
        'hello',
        INTERACTIVE_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
        undefined,
        fixture.identity,
        providerStatus,
      );

      expect(provider.interactiveOptions[0]?.providerStatus).toBe(providerStatus);
      expect(provider.interactiveOptions[0]?.workspaceTrust).toEqual({
        state: 'trusted',
        workspaceId: fixture.identity.workspaceId,
        incarnation: fixture.identity.incarnation,
        trustEpoch: 0,
      });
      await finishInteractive(interactive);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects workspace replacement during startup at the final work-delivery gate', async () => {
    const fixture = await trustedWorkspaceFixture();
    const releaseStartup = deferred<void>();
    const startupReached = deferred<void>();
    const interactive = makeControllableInteractiveSession();
    const provider = new InteractiveTestProvider(interactive);
    provider.startupHook = async (options) => {
      startupReached.resolve();
      await releaseStartup.promise;
      await options.beforeWorkDelivery?.();
    };
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessionManager = new SessionManager(registry, noopLogger, undefined, {
      trustStore: fixture.trustStore,
    });
    try {
      const start = sessionManager.createInteractive(
        provider.id,
        fixture.identity.canonicalPath,
        'hello',
        INTERACTIVE_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
        undefined,
        fixture.identity,
      );
      await startupReached.promise;
      await rename(fixture.identity.canonicalPath, `${fixture.identity.canonicalPath}-original`);
      await mkdir(fixture.identity.canonicalPath);
      releaseStartup.resolve();

      await expect(start).rejects.toMatchObject({ code: 'workspace_untrusted' });
      expect(provider.interactiveOptions[0]?.beforeWorkDelivery).toBeTypeOf('function');
      expect(sessionManager.list(2)).toEqual([]);
    } finally {
      releaseStartup.resolve();
      await fixture.cleanup();
    }
  });
});

describe('SessionManager — pending interactive startup', () => {
  function setupPending() {
    const provider = new PendingInteractiveProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);
    return { provider, sessionManager: new SessionManager(registry, noopLogger) };
  }

  it('aborts and awaits startup handshakes during cancelAll', async () => {
    const { provider, sessionManager } = setupPending();
    const start = createPendingInteractive(sessionManager);
    const rejected = expect(start).rejects.toThrow('interactive startup aborted');
    await tick();

    await sessionManager.cancelAll(1_000, 2);

    await rejected;
    expect(provider.aborts).toBe(1);
    expect(sessionManager.list(2)).toEqual([]);
  });

  it('relays request abort while startup is pending', async () => {
    const { provider, sessionManager } = setupPending();
    const controller = new AbortController();
    const start = createPendingInteractive(sessionManager, controller.signal);
    const rejected = expect(start).rejects.toThrow('interactive startup aborted');
    await tick();

    controller.abort();

    await rejected;
    expect(provider.aborts).toBe(1);
    expect(sessionManager.list(2)).toEqual([]);
  });

  it('cancels a pending startup by its registered session id', async () => {
    const { provider, sessionManager } = setupPending();
    const start = createPendingInteractive(sessionManager);
    const rejected = expect(start).rejects.toThrow('interactive startup aborted');
    await tick();
    const sessionId = provider.interactiveOptions[0]?.sessionId;
    expect(sessionId).toBeDefined();

    await expect(sessionManager.cancel(sessionId as string, 2)).resolves.toBe(true);

    await rejected;
    expect(provider.aborts).toBe(1);
    expect(sessionManager.list(2)).toEqual([]);
  });

  it('aborts pending starts and rejects new work after shutdown begins', async () => {
    const { provider, sessionManager } = setupPending();
    const start = createPendingInteractive(sessionManager);
    const rejected = expect(start).rejects.toThrow('interactive startup aborted');
    await tick();

    sessionManager.beginShutdown();

    await rejected;
    await expect(createPendingInteractive(sessionManager)).rejects.toMatchObject({
      code: 'session_terminal',
    });
    expect(provider.aborts).toBe(1);
  });

  it('synchronously aborts a matching pending start when its workspace is blocked', async () => {
    const fixture = await trustedWorkspaceFixture();
    try {
      const provider = new PendingInteractiveProvider();
      const registry = new ProviderRegistry();
      registry.register(provider);
      const sessionManager = new SessionManager(registry, noopLogger, undefined, {
        auditStore: fixture.auditStore,
        trustStore: fixture.trustStore,
      });
      const start = sessionManager.createInteractive(
        provider.id,
        fixture.identity.canonicalPath,
        'pending',
        INTERACTIVE_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
        undefined,
        fixture.identity,
      );
      const rejected = expect(start).rejects.toThrow('interactive startup aborted');
      await vi.waitFor(() => expect(provider.interactiveOptions).toHaveLength(1));

      sessionManager.blockWorkspace(fixture.identity.workspaceId);

      await rejected;
      expect(provider.aborts).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('SessionManager — interactive command dispatch', () => {
  it('times out published approvals and questions exactly once', async () => {
    const resolved: Array<[string, string]> = [];
    const published = deferred<void>();
    const { interactive, sessionManager, session } = await setupInteractive(
      {
        resolveInteraction: async (requestId, reason) => {
          resolved.push([requestId, reason]);
        },
      },
      { interactionTimeoutMs: 5 },
    );
    const publishedIds: string[] = [];
    sessionManager.subscribeInteractive(session.id, 0, (_index, event) => {
      if (event.type === 'approval.requested' || event.type === 'question.requested') {
        publishedIds.push(event.requestId);
        if (publishedIds.length === 2) published.resolve();
      }
    });

    const approval = approvalRequest(uuid(71_000));
    approval.permission!.risk = 'destructive';
    approval.possibleEffects = ['filesystem_write', 'destructive'];
    const question = questionRequest(uuid(71_001));
    interactive.push(approval);
    interactive.push(question);
    await published.promise;
    expect(sessionManager.markInteractionPublished(session.id, approval.requestId)).toBe(true);
    expect(sessionManager.markInteractionPublished(session.id, question.requestId)).toBe(true);

    await vi.waitFor(() =>
      expect(resolved).toEqual([
        [approval.requestId, 'timeout'],
        [question.requestId, 'timeout'],
      ]),
    );
    await finishInteractive(interactive);
  });

  it('beginShutdown plus cancelAll resolves each pending approval and question once before close', async () => {
    const resolved: string[] = [];
    const order: string[] = [];
    const published = deferred<void>();
    const { interactive, sessionManager, session } = await setupInteractive({
      resolveInteraction: async (requestId) => {
        resolved.push(requestId);
        order.push(`resolve:${requestId}`);
      },
    });
    const originalClose = interactive.handle.close;
    interactive.handle.close = async () => {
      order.push('close');
      await originalClose();
    };
    const requestIds: string[] = [];
    sessionManager.subscribeInteractive(session.id, 0, (_index, event) => {
      if (event.type === 'approval.requested' || event.type === 'question.requested') {
        requestIds.push(event.requestId);
        if (requestIds.length === 2) published.resolve();
      }
    });
    const approval = approvalRequest(uuid(72_000));
    approval.permission!.risk = 'destructive';
    approval.possibleEffects = ['filesystem_write', 'destructive'];
    const question = questionRequest(uuid(72_001));
    interactive.push(approval);
    interactive.push(question);
    await published.promise;
    expect(sessionManager.markInteractionPublished(session.id, approval.requestId)).toBe(true);
    expect(sessionManager.markInteractionPublished(session.id, question.requestId)).toBe(true);

    sessionManager.beginShutdown();
    await sessionManager.cancelAll(1_000);
    expect(resolved).toEqual([approval.requestId, question.requestId]);
    expect(order.at(-1)).toBe('close');
    expect(order.slice(0, 2)).toEqual([
      `resolve:${approval.requestId}`,
      `resolve:${question.requestId}`,
    ]);
  });

  it('scopes allow_session grants to their originating session', async () => {
    const fixture = await trustedWorkspaceFixture();
    const interactiveA = makeControllableInteractiveSession();
    const interactiveB = makeControllableInteractiveSession();
    try {
      const providerA = new InteractiveTestProvider(interactiveA, 'claude');
      const providerB = new InteractiveTestProvider(interactiveB, 'codex');
      const registry = new ProviderRegistry();
      registry.register(providerA);
      registry.register(providerB);
      const sessionManager = new SessionManager(registry, noopLogger, undefined, {
        auditStore: fixture.auditStore,
        trustStore: fixture.trustStore,
      });
      const sessionA = await sessionManager.createInteractive(
        providerA.id,
        fixture.identity.canonicalPath,
        'hello A',
        APPROVAL_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
        undefined,
        fixture.identity,
      );
      const sessionB = await sessionManager.createInteractive(
        providerB.id,
        fixture.identity.canonicalPath,
        'hello B',
        APPROVAL_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
        undefined,
        fixture.identity,
      );
      const publishedA = deferred<void>();
      const publishedB = deferred<void>();
      sessionManager.subscribeInteractive(sessionA.id, 0, (_index, event) => {
        if (event.type === 'approval.requested') publishedA.resolve();
      });
      sessionManager.subscribeInteractive(sessionB.id, 0, (_index, event) => {
        if (event.type === 'approval.requested') publishedB.resolve();
      });

      const requestA = approvalRequest(uuid(73_000));
      if (!requestA.permission) throw new Error('grant fixture requires normalized permission');
      interactiveA.push(requestA);
      await publishedA.promise;
      expect(sessionManager.markInteractionPublished(sessionA.id, requestA.requestId)).toBe(true);
      const grantResult = await sessionManager.dispatch(sessionA.id, {
        type: 'approval.respond',
        commandId: uuid(73_001),
        sessionId: sessionA.id,
        turnId: requestA.turnId,
        requestId: requestA.requestId,
        decision: 'allow_session',
      });
      expect(grantResult).toMatchObject({ ok: true });

      const requestB = { ...approvalRequest(uuid(73_002)), permission: { ...requestA.permission } };
      interactiveB.push(requestB);
      await publishedB.promise;
      expect(sessionManager.markInteractionPublished(sessionB.id, requestB.requestId)).toBe(true);
      await tick();
      expect(interactiveB.sent).toEqual([]);
      expect(sessionManager.get(sessionB.id)?.status).toBe('running');
      await finishInteractive(interactiveA);
      await finishInteractive(interactiveB);
    } finally {
      await fixture.cleanup();
    }
  });

  it('dispatches concurrent commands exactly once and in submission order', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const { interactive, sessionManager, session } = await setupInteractive({
      send: async (_command, index) => gates[index]?.promise,
    });
    const commands = [1, 2, 3].map((index) => followUpCommand(session.id, index));

    const results = commands.map((command) => sessionManager.dispatch(session.id, command));
    await tick();
    expect(interactive.sent).toEqual([commands[0]]);

    gates[0]?.resolve();
    await tick();
    expect(interactive.sent).toEqual(commands.slice(0, 2));

    gates[1]?.resolve();
    await tick();
    expect(interactive.sent).toEqual(commands);

    gates[2]?.resolve();
    await expect(Promise.all(results)).resolves.toEqual(
      commands.map((command) => ({
        ok: true,
        acknowledgement: {
          status: 'accepted',
          commandId: command.commandId,
          sessionId: command.sessionId,
          turnId: command.turnId,
        },
      })),
    );
    await finishInteractive(interactive);
  });

  it('allows a valid question retry after a recoverable opaque-answer rejection', async () => {
    let attempts = 0;
    const { interactive, sessionManager, session } = await setupInteractive({
      send: async (command) => {
        if (command.type !== 'question.respond') return;
        attempts += 1;
        if (attempts === 1) {
          throw new InteractiveSessionError(
            'command_rejected',
            'Question response did not match the native request',
          );
        }
      },
    });
    const published = deferred<void>();
    sessionManager.subscribeInteractive(session.id, 0, (_index, event) => {
      if (event.type === 'question.requested') published.resolve();
    });
    const request = questionRequest(uuid(74_000));
    interactive.push(request);
    await published.promise;
    expect(sessionManager.markInteractionPublished(session.id, request.requestId)).toBe(true);
    const questionId = request.questions[0]!.id;

    await expect(
      sessionManager.dispatch(session.id, {
        type: 'question.respond',
        commandId: uuid(74_001),
        sessionId: session.id,
        turnId: request.turnId,
        requestId: request.requestId,
        answers: [{ questionId, value: 'invalid opaque value' }],
      }),
    ).resolves.toMatchObject({ ok: false, code: 'command_rejected' });
    await expect(
      sessionManager.dispatch(session.id, {
        type: 'question.respond',
        commandId: uuid(74_002),
        sessionId: session.id,
        turnId: request.turnId,
        requestId: request.requestId,
        answers: [{ questionId, value: 'valid value' }],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(interactive.sent).toHaveLength(2);
    await finishInteractive(interactive);
  });

  it('returns the same pending acknowledgement for an identical command-id retry without redispatch', async () => {
    const gate = deferred<void>();
    const { interactive, sessionManager, session } = await setupInteractive({
      send: () => gate.promise,
    });
    const first = followUpCommand(session.id, 10, 'same payload');
    const reordered: AgentCommandV2 = {
      content: first.content,
      turnId: first.turnId,
      sessionId: first.sessionId,
      commandId: first.commandId,
      type: first.type,
    };

    const initial = sessionManager.dispatch(session.id, first);
    const retry = sessionManager.dispatch(session.id, reordered);
    expect(retry).toBe(initial);
    await tick();
    expect(interactive.sent).toEqual([first]);

    gate.resolve();
    const [initialResult, retryResult] = await Promise.all([initial, retry]);
    expect(retryResult).toBe(initialResult);
    expect(interactive.sent).toHaveLength(1);
    await finishInteractive(interactive);
  });

  it('rejects conflicting reuse of a command id without dispatching the conflicting payload', async () => {
    const gate = deferred<void>();
    const { interactive, sessionManager, session } = await setupInteractive({
      send: () => gate.promise,
    });
    const first = followUpCommand(session.id, 20, 'first payload');
    const conflicting = followUpCommand(session.id, 20, 'different payload');

    const pending = sessionManager.dispatch(session.id, first);
    await expect(sessionManager.dispatch(session.id, conflicting)).resolves.toMatchObject({
      ok: false,
      code: 'command_id_conflict',
    });
    expect(interactive.sent).toEqual([first]);

    gate.resolve();
    await pending;
    await finishInteractive(interactive);
  });

  it('rejects terminal interactive and noninteractive sessions deterministically', async () => {
    const interactiveSetup = await setupInteractive();
    await finishInteractive(interactiveSetup.interactive);
    await expect(
      interactiveSetup.sessionManager.dispatch(
        interactiveSetup.session.id,
        followUpCommand(interactiveSetup.session.id, 30),
      ),
    ).resolves.toMatchObject({ ok: false, code: 'session_terminal' });

    const legacySetup = setup();
    const legacy = legacySetup.sessionManager.create('claude', '/tmp', 'legacy');
    await expect(
      legacySetup.sessionManager.dispatch(legacy.id, followUpCommand(legacy.id, 31)),
    ).resolves.toMatchObject({ ok: false, code: 'session_not_capable' });
    const legacyControl = legacySetup.provider.sessions.get(legacy.id)!;
    legacyControl.push({ type: 'session.completed' });
    legacyControl.finish();
  });

  it('rejects the 65th pending command with session_backpressure', async () => {
    const gate = deferred<void>();
    const { interactive, sessionManager, session } = await setupInteractive({
      send: () => gate.promise,
    });
    const pending = Array.from({ length: 64 }, (_value, index) =>
      sessionManager.dispatch(session.id, followUpCommand(session.id, 100 + index)),
    );

    await expect(
      sessionManager.dispatch(session.id, followUpCommand(session.id, 164)),
    ).resolves.toMatchObject({ ok: false, code: 'session_backpressure' });
    await tick();
    expect(interactive.sent).toHaveLength(1);

    gate.resolve();
    await Promise.all(pending);
    expect(interactive.sent).toHaveLength(64);
    await finishInteractive(interactive);
  });

  it('rejects aggregate pending command bytes above 1 MiB before the count cap', async () => {
    const gate = deferred<void>();
    const { interactive, sessionManager, session } = await setupInteractive({
      send: () => gate.promise,
    });
    const largeText = 'x'.repeat(240_000);
    const pending = Array.from({ length: 4 }, (_value, index) =>
      sessionManager.dispatch(session.id, followUpCommand(session.id, 300 + index, largeText)),
    );

    await expect(
      sessionManager.dispatch(session.id, followUpCommand(session.id, 304, largeText)),
    ).resolves.toMatchObject({ ok: false, code: 'session_backpressure' });

    gate.resolve();
    await Promise.all(pending);
    expect(interactive.sent).toHaveLength(4);
    await finishInteractive(interactive);
  });

  it('routes session.interrupt to interrupt(), never send() or close()', async () => {
    const { interactive, sessionManager, session } = await setupInteractive();
    const interrupt: AgentCommandV2 = {
      type: 'session.interrupt',
      commandId: uuid(500),
      sessionId: session.id,
      turnId: INTERACTIVE_TURN_ID,
    };

    await expect(sessionManager.dispatch(session.id, interrupt)).resolves.toMatchObject({
      ok: true,
      acknowledgement: { commandId: interrupt.commandId },
    });
    expect(interactive.interruptCalls()).toBe(1);
    expect(interactive.sent).toHaveLength(0);
    expect(interactive.closeCalls()).toBe(0);
    await finishInteractive(interactive);
  });

  it('never lets a late accepted-work result downgrade an accepted dispatched session', async () => {
    const accepted = deferred<AcceptedWorkState>();
    const { interactive, sessionManager, session } = await setupInteractive({
      accepted: accepted.promise,
    });
    expect(sessionManager.acceptedWork(session.id)).toBe('not_accepted');

    await expect(
      sessionManager.dispatch(session.id, followUpCommand(session.id, 600)),
    ).resolves.toMatchObject({ ok: true });
    expect(sessionManager.acceptedWork(session.id)).toBe('accepted');

    accepted.resolve('not_accepted');
    await tick();
    expect(sessionManager.acceptedWork(session.id)).toBe('accepted');
    await finishInteractive(interactive);
  });

  it('does not let stale interaction traffic consume the command ledger', async () => {
    const { interactive, sessionManager, session } = await setupInteractive();
    for (let index = 0; index < 1_100; index += 1) {
      const stale: AgentCommandV2 = {
        type: 'approval.respond',
        commandId: uuid(30_000 + index),
        sessionId: session.id,
        turnId: INTERACTIVE_TURN_ID,
        requestId: uuid(40_000 + index),
        decision: 'deny',
      };
      await expect(sessionManager.dispatch(session.id, stale)).resolves.toMatchObject({
        ok: false,
        code: 'stale_interaction',
      });
    }

    const published = deferred<void>();
    sessionManager.subscribeInteractive(session.id, 0, (_index, event) => {
      if (event.type === 'approval.requested') published.resolve();
    });
    const request = approvalRequest(uuid(50_000));
    if (!request.permission) throw new Error('approval fixture requires normalized permission');
    request.permission.risk = 'destructive';
    request.possibleEffects = ['filesystem_write', 'destructive'];
    interactive.push(request);
    await published.promise;
    for (let index = 0; index < 1_100; index += 1) {
      await expect(
        sessionManager.dispatch(session.id, {
          type: 'approval.respond',
          commandId: uuid(51_000 + index),
          sessionId: session.id,
          turnId: request.turnId,
          requestId: request.requestId,
          decision: 'allow_session',
        }),
      ).resolves.toMatchObject({ ok: false, code: 'command_rejected' });
    }
    const denial: AgentCommandV2 = {
      type: 'approval.respond',
      commandId: uuid(53_000),
      sessionId: session.id,
      turnId: request.turnId,
      requestId: request.requestId,
      decision: 'deny',
    };
    await expect(sessionManager.dispatch(session.id, denial)).resolves.toMatchObject({ ok: true });

    const valid = followUpCommand(session.id, 54_000);
    await expect(sessionManager.dispatch(session.id, valid)).resolves.toMatchObject({ ok: true });
    expect(interactive.sent).toEqual([denial, valid]);
    await finishInteractive(interactive);
  });
});

describe('SessionManager — secured approvals', () => {
  it('audits a same-turn approval denied by a question timeout', async () => {
    const fixture = await trustedWorkspaceFixture();
    const resolved: Array<[string, string]> = [];
    const interactive = makeControllableInteractiveSession({
      resolveInteraction: async (requestId, reason) => {
        resolved.push([requestId, reason]);
      },
    });
    try {
      const provider = new InteractiveTestProvider(interactive);
      const registry = new ProviderRegistry();
      registry.register(provider);
      const append = vi.spyOn(fixture.auditStore, 'append');
      const sessionManager = new SessionManager(registry, noopLogger, undefined, {
        auditStore: fixture.auditStore,
        interactionTimeoutMs: 1_000,
        trustStore: fixture.trustStore,
      });
      const session = await sessionManager.createInteractive(
        provider.id,
        fixture.identity.canonicalPath,
        'hello',
        APPROVAL_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
        undefined,
        fixture.identity,
      );
      const published = deferred<void>();
      const requestIds: string[] = [];
      sessionManager.subscribeInteractive(session.id, 0, (_index, event) => {
        if (event.type === 'approval.requested' || event.type === 'question.requested') {
          requestIds.push(event.requestId);
          if (requestIds.length === 2) published.resolve();
        }
      });
      const approval = approvalRequest(uuid(60_010));
      const question = questionRequest(uuid(60_011));
      question.deadlineAt = new Date(Date.now() + 20).toISOString();
      interactive.push(approval);
      interactive.push(question);
      await published.promise;

      expect(sessionManager.markInteractionPublished(session.id, approval.requestId)).toBe(true);
      expect(sessionManager.markInteractionPublished(session.id, question.requestId)).toBe(true);
      await vi.waitFor(() => expect(resolved).toEqual([[question.requestId, 'timeout']]));
      await vi.waitFor(() =>
        expect(append).toHaveBeenCalledWith(
          expect.objectContaining({
            actor: 'timeout',
            decision: 'deny',
            requestId: approval.requestId,
          }),
        ),
      );
      expect(
        append.mock.calls.filter(([entry]) => entry.requestId === approval.requestId),
      ).toHaveLength(1);
      await finishInteractive(interactive);
    } finally {
      await fixture.cleanup();
    }
  });

  it('audits a supervisor-side fail-closed approval resolution exactly once', async () => {
    const fixture = await trustedWorkspaceFixture();
    const interactive = makeControllableInteractiveSession();
    try {
      const provider = new InteractiveTestProvider(interactive);
      const registry = new ProviderRegistry();
      registry.register(provider);
      const append = vi.spyOn(fixture.auditStore, 'append');
      const sessionManager = new SessionManager(registry, noopLogger, undefined, {
        auditStore: fixture.auditStore,
        trustStore: fixture.trustStore,
      });
      const session = await sessionManager.createInteractive(
        provider.id,
        fixture.identity.canonicalPath,
        'hello',
        APPROVAL_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
        undefined,
        fixture.identity,
      );
      const published = deferred<void>();
      sessionManager.subscribeInteractive(session.id, 0, (_index, event) => {
        if (event.type === 'approval.requested') published.resolve();
      });
      const request = approvalRequest(uuid(60_020));
      interactive.push(request);
      await published.promise;
      expect(sessionManager.markInteractionPublished(session.id, request.requestId)).toBe(true);

      const resolution: AgentEventV2 = {
        type: 'approval.resolved',
        turnId: request.turnId,
        requestId: request.requestId,
        decision: 'denied',
        actor: 'disconnect',
      };
      interactive.push(resolution);
      interactive.push(resolution);
      await vi.waitFor(() =>
        expect(append).toHaveBeenCalledWith(
          expect.objectContaining({
            actor: 'disconnect',
            decision: 'deny',
            requestId: request.requestId,
          }),
        ),
      );
      expect(
        append.mock.calls.filter(([entry]) => entry.requestId === request.requestId),
      ).toHaveLength(1);
      await finishInteractive(interactive);
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed when a secured session has no audit store', async () => {
    const fixture = await trustedWorkspaceFixture();
    const interactive = makeControllableInteractiveSession();
    try {
      const provider = new InteractiveTestProvider(interactive);
      const registry = new ProviderRegistry();
      registry.register(provider);
      const sessionManager = new SessionManager(registry, noopLogger, undefined, {
        trustStore: fixture.trustStore,
      });
      const session = await sessionManager.createInteractive(
        provider.id,
        fixture.identity.canonicalPath,
        'hello',
        APPROVAL_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
        undefined,
        fixture.identity,
      );
      const published = deferred<void>();
      sessionManager.subscribeInteractive(session.id, 0, (_index, event) => {
        if (event.type === 'approval.requested') published.resolve();
      });
      const request = approvalRequest(uuid(60_000));
      interactive.push(request);
      await published.promise;

      const command: AgentCommandV2 = {
        type: 'approval.respond',
        commandId: uuid(60_001),
        sessionId: session.id,
        turnId: request.turnId,
        requestId: request.requestId,
        decision: 'allow_once',
      };
      await expect(sessionManager.dispatch(session.id, command)).resolves.toMatchObject({
        ok: false,
        code: 'audit_failure',
      });
      expect(interactive.sent).toEqual([{ ...command, decision: 'deny' }]);
      await finishInteractive(interactive);
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed when auditing a session-grant automatic allow fails', async () => {
    const fixture = await trustedWorkspaceFixture();
    const interactive = makeControllableInteractiveSession();
    try {
      const provider = new InteractiveTestProvider(interactive);
      const registry = new ProviderRegistry();
      registry.register(provider);
      const sessionManager = new SessionManager(registry, noopLogger, undefined, {
        auditStore: fixture.auditStore,
        trustStore: fixture.trustStore,
      });
      const session = await sessionManager.createInteractive(
        provider.id,
        fixture.identity.canonicalPath,
        'hello',
        APPROVAL_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
        undefined,
        fixture.identity,
      );
      const published = deferred<void>();
      sessionManager.subscribeInteractive(session.id, 0, (_index, event) => {
        if (event.type === 'approval.requested') published.resolve();
      });
      const firstRequest = approvalRequest(uuid(60_100));
      if (!firstRequest.permission) throw new Error('grant fixture requires normalized permission');
      interactive.push(firstRequest);
      await published.promise;
      expect(sessionManager.markInteractionPublished(session.id, firstRequest.requestId)).toBe(
        true,
      );
      await expect(
        sessionManager.dispatch(session.id, {
          type: 'approval.respond',
          commandId: uuid(60_101),
          sessionId: session.id,
          turnId: firstRequest.turnId,
          requestId: firstRequest.requestId,
          decision: 'allow_session',
        }),
      ).resolves.toMatchObject({ ok: true });

      vi.spyOn(fixture.auditStore, 'append').mockRejectedValueOnce(new Error('audit unavailable'));
      const automaticRequest = {
        ...approvalRequest(uuid(60_102)),
        permission: { ...firstRequest.permission },
      };
      interactive.push(automaticRequest);
      await vi.waitFor(() => expect(interactive.sent).toHaveLength(2));

      expect(interactive.sent[1]).toMatchObject({
        type: 'approval.respond',
        requestId: automaticRequest.requestId,
        decision: 'deny',
      });
      expect(
        interactive.sent.filter(
          (command) =>
            command.type === 'approval.respond' && command.requestId === automaticRequest.requestId,
        ),
      ).toHaveLength(1);
      await finishInteractive(interactive);
    } finally {
      await fixture.cleanup();
    }
  });

  it('denies an automatic approval when revocation starts during its audit write', async () => {
    const fixture = await trustedWorkspaceFixture();
    const interactive = makeControllableInteractiveSession();
    try {
      const provider = new InteractiveTestProvider(interactive);
      const registry = new ProviderRegistry();
      registry.register(provider);
      const sessionManager = new SessionManager(registry, noopLogger, undefined, {
        auditStore: fixture.auditStore,
        trustStore: fixture.trustStore,
      });
      const session = await sessionManager.createInteractive(
        provider.id,
        fixture.identity.canonicalPath,
        'hello',
        APPROVAL_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
        undefined,
        fixture.identity,
      );
      const firstPublished = deferred<void>();
      sessionManager.subscribeInteractive(session.id, 0, (_index, event) => {
        if (event.type === 'approval.requested') firstPublished.resolve();
      });
      const firstRequest = approvalRequest(uuid(61_000));
      interactive.push(firstRequest);
      await firstPublished.promise;
      await expect(
        sessionManager.dispatch(session.id, {
          type: 'approval.respond',
          commandId: uuid(61_001),
          sessionId: session.id,
          turnId: firstRequest.turnId,
          requestId: firstRequest.requestId,
          decision: 'allow_session',
        }),
      ).resolves.toMatchObject({ ok: true });

      const auditStarted = deferred<void>();
      const releaseAudit = deferred<void>();
      const append = fixture.auditStore.append.bind(fixture.auditStore);
      fixture.auditStore.append = async (entry) => {
        auditStarted.resolve();
        await releaseAudit.promise;
        return append(entry);
      };
      const secondRequest = approvalRequest(uuid(61_002));
      interactive.push(secondRequest);
      await auditStarted.promise;

      sessionManager.blockWorkspace(fixture.identity.workspaceId);
      releaseAudit.resolve();
      await vi.waitFor(() => expect(interactive.sent).toHaveLength(2));

      expect(interactive.sent[1]).toMatchObject({
        type: 'approval.respond',
        requestId: secondRequest.requestId,
        decision: 'deny',
      });
      const effectiveAudit = (await fixture.auditStore.read({ sessionId: session.id })).entries
        .filter((entry) => entry.requestId === secondRequest.requestId)
        .map(({ decision, actor }) => ({ decision, actor }));
      expect(effectiveAudit).toEqual([
        { decision: 'allow_once', actor: 'policy' },
        { decision: 'deny', actor: 'policy' },
      ]);
      await finishInteractive(interactive);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('SessionManager — interactive replay bounds', () => {
  it('keeps the newest 5,000 events and replays their absolute indices', async () => {
    const { interactive, sessionManager, session } = await setupInteractive();
    const consumed = deferred<void>();
    const releaseLive = sessionManager.subscribeInteractive(session.id, 0, (index) => {
      if (index === 5_000) consumed.resolve();
    });

    for (let index = 0; index <= 5_000; index += 1) {
      interactive.push({ type: 'session.status', status: index % 2 === 0 ? 'idle' : 'active' });
    }
    await consumed.promise;
    releaseLive?.();

    const replayed: Array<{ index: number; event: AgentEventV2 }> = [];
    const releaseReplay = sessionManager.subscribeInteractive(session.id, 0, (index, event) => {
      replayed.push({ index, event });
    });

    expect(replayed).toHaveLength(5_000);
    expect(replayed[0]).toEqual({
      index: 1,
      event: { type: 'session.status', status: 'active' },
    });
    expect(replayed.at(-1)).toEqual({
      index: 5_000,
      event: { type: 'session.status', status: 'idle' },
    });
    releaseReplay?.();
    await finishInteractive(interactive);
  });

  it('evicts by the 16 MiB byte cap while preserving absolute replay indices', async () => {
    const { interactive, sessionManager, session } = await setupInteractive();
    const event: AgentEventV2 = {
      type: 'content.completed',
      turnId: INTERACTIVE_TURN_ID,
      block: {
        type: 'text',
        id: uuid(20_000),
        text: 'x'.repeat(250 * 1024),
      },
    };
    const retainedCount = Math.floor(
      (16 * 1024 * 1024) / Buffer.byteLength(JSON.stringify(event), 'utf8'),
    );
    const totalEvents = retainedCount + 1;
    const consumed = deferred<void>();
    const releaseLive = sessionManager.subscribeInteractive(session.id, 0, (index) => {
      if (index === totalEvents - 1) consumed.resolve();
    });

    for (let index = 0; index < totalEvents; index += 1) interactive.push(event);
    await consumed.promise;
    releaseLive?.();

    const replayedIndices: number[] = [];
    const releaseReplay = sessionManager.subscribeInteractive(session.id, 0, (index) => {
      replayedIndices.push(index);
    });

    expect(replayedIndices).toHaveLength(retainedCount);
    expect(replayedIndices[0]).toBe(totalEvents - retainedCount);
    expect(replayedIndices.at(-1)).toBe(totalEvents - 1);
    releaseReplay?.();
    await finishInteractive(interactive);
  });
});

describe('V2SessionFacade — interactive turn state', () => {
  it('bounds the recovered SSE replay window while preserving full durable history', () => {
    const graph = new MemoryExecutionGraphStore();
    const sessionId = '123e4567-e89b-42d3-a456-426614174210';
    const executionId = '123e4567-e89b-42d3-a456-426614174211';
    graph.reserve({
      session: {
        id: sessionId,
        provider: 'claude',
        transport: INTERACTIVE_TRANSPORT.id,
        cwd: '/tmp',
        status: 'active',
        selection: INTERACTIVE_SELECTION,
        executionId,
        rootExecutionId: executionId,
        continuationKind: 'fresh',
        acceptedWork: 'accepted',
        startedAt: '2026-09-01T08:00:00.000Z',
        earliestSequence: 0,
      },
      interactive: true,
    });
    for (let sequence = 0; sequence <= 5_000; sequence += 1) {
      graph.appendEvent(sessionId, {
        sessionId,
        executionId,
        sequence,
        timestamp: '2026-09-01T08:00:00.000Z',
        type: 'session.status',
        status: 'active',
      });
    }

    const sessions = new V2SessionFacade(
      new SessionManager(new ProviderRegistry(), noopLogger),
      graph,
    );
    expect(sessions.replayWindow(sessionId)).toEqual({ earliestSequence: 1, nextSequence: 5_001 });
    let replayed = 0;
    const unsubscribe = sessions.subscribe(sessionId, 1, () => {
      replayed += 1;
    });
    expect(replayed).toBe(5_000);
    unsubscribe?.();

    let durableEvents = 0;
    let cursor: string | undefined;
    do {
      const page = sessions.history(sessionId, { ...(cursor ? { cursor } : {}), limit: 100 });
      durableEvents += page?.events.length ?? 0;
      cursor = page?.nextCursor;
    } while (cursor);
    expect(durableEvents).toBe(5_001);
  });

  it('projects bounded provider session and runtime metadata from a successful transport', async () => {
    const interactive = makeControllableInteractiveSession({
      providerSessionId: 'thread_123',
      runtimeMetadata: {
        cliVersion: '0.147.0',
        schemaVersion: 'schema-0.147.0',
        fixtureSet: 'codex-app-server-0.147.0-v1',
        requestedTransportMode: 'auto',
      },
    });
    const provider = new InteractiveTestProvider(interactive);
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessions = new V2SessionFacade(new SessionManager(registry, noopLogger));

    const session = await sessions.create(
      { provider: provider.id, cwd: '/tmp', prompt: 'hello' },
      INTERACTIVE_SELECTION,
      INTERACTIVE_TRANSPORT,
      true,
    );

    expect(session.providerSessionId).toBe('thread_123');
    expect(session.runtimeMetadata).toEqual({
      cliVersion: '0.147.0',
      schemaVersion: 'schema-0.147.0',
      fixtureSet: 'codex-app-server-0.147.0-v1',
      requestedTransportMode: 'auto',
    });
    await finishInteractive(interactive);
  });

  it('persists accepted-work evidence as soon as the provider resolves it', async () => {
    const accepted = deferred<AcceptedWorkState>();
    const interactive = makeControllableInteractiveSession({ accepted: accepted.promise });
    const provider = new InteractiveTestProvider(interactive);
    const registry = new ProviderRegistry();
    registry.register(provider);
    const graph = new MemoryExecutionGraphStore();
    const manager = new SessionManager(registry, noopLogger, undefined, {
      executionGraphStore: graph,
    });
    const sessions = new V2SessionFacade(manager, graph);

    const session = await sessions.create(
      { provider: provider.id, cwd: '/tmp', prompt: 'hello' },
      INTERACTIVE_SELECTION,
      INTERACTIVE_TRANSPORT,
      true,
    );
    expect(graph.get(session.id)?.session.acceptedWork).toBe('not_accepted');

    accepted.resolve('accepted');
    await tick();
    expect(graph.get(session.id)?.session.acceptedWork).toBe('accepted');
    await finishInteractive(interactive);
  });

  it('returns a failed turn to idle so a follow-up can be dispatched', async () => {
    const interactive = makeControllableInteractiveSession();
    const provider = new InteractiveTestProvider(interactive);
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessionManager = new SessionManager(registry, noopLogger);
    const sessions = new V2SessionFacade(sessionManager);
    const selection: CapabilitySelection = {
      ...INTERACTIVE_SELECTION,
      enabled: [
        {
          id: 'session.input.follow_up',
          constraints: { kind: 'text_input', maxCharacters: 200_000, attachmentKinds: [] },
        },
      ],
    };
    const session = await sessions.create(
      { provider: provider.id, cwd: '/tmp', prompt: 'hello' },
      selection,
      INTERACTIVE_TRANSPORT,
      true,
    );
    interactive.push({
      type: 'turn.failed',
      turnId: INTERACTIVE_TURN_ID,
      code: 'test_failure',
      message: 'turn failed',
    });
    await tick();

    expect(sessions.get(session.id)?.status).toBe('idle');
    const command = followUpCommand(session.id, 700);
    await expect(sessions.dispatch(command)).resolves.toMatchObject({ ok: true });
    expect(interactive.sent).toEqual([command]);
    await finishInteractive(interactive);
  });
});

describe('V2SessionFacade — bounded startup fallback', () => {
  const fallbackEffects = [
    'read',
    'filesystem_write',
    'command',
    'network',
    'external_side_effect',
    'destructive',
  ] as const;
  const appServerTransport: ProviderTransportV2 = {
    id: 'codex-app-server',
    priority: 1,
    stability: 'stable',
    possibleEffects: [...fallbackEffects],
    effectsComplete: false,
  };
  const appServerSelection: CapabilitySelection = {
    transport: appServerTransport.id,
    enabled: [
      {
        id: 'session.cancel',
        constraints: { kind: 'acknowledgement', timeoutMs: 30_000 },
      },
    ],
    unavailableOptional: [],
    possibleEffects: [...fallbackEffects],
    effectsComplete: false,
  };

  class StartupFallbackProvider implements AgentProvider {
    readonly id = 'codex' as const;
    readonly name = 'Codex fallback test provider';
    readonly legacyOptions: StartSessionOptions[] = [];
    readonly interactiveOptions: StartInteractiveSessionOptions[] = [];
    readonly detectionOptions: Array<ProviderDetectionOptions | undefined> = [];
    interactiveStarts = 0;
    redetectedStatus?: ProviderStatus;
    detectHook?: () => Promise<void>;
    publishScopeEvidence = true;
    succeedInteractive = false;
    readonly status: ProviderStatus = {
      id: this.id,
      name: this.name,
      installed: true,
      authenticated: 'authenticated',
      authSource: 'chatgpt',
      accountFingerprint: 'a'.repeat(64),
      selectedModel: 'gpt-5.4',
      executablePath: 'C:\\Program Files\\OpenAI\\Codex\\codex.exe',
      version: '0.147.0',
      capabilities: { cancellation: true },
    };

    constructor(private readonly deliveryState: 'not_delivered' | 'ambiguous' | 'delivered') {}

    async detect(options?: ProviderDetectionOptions): Promise<ProviderStatus> {
      this.detectionOptions.push(options);
      await this.detectHook?.();
      return this.redetectedStatus ?? this.status;
    }

    startSession(options: StartSessionOptions): ProviderSessionHandle {
      this.legacyOptions.push(options);
      async function* events(): AsyncGenerator<AgentEvent, void, void> {
        yield { type: 'session.started', sessionId: options.sessionId, provider: 'codex' };
        yield { type: 'session.completed', providerSessionId: 'legacy-thread' };
      }
      return { events: events(), cancel: async () => undefined };
    }

    async startInteractiveSession(
      options: StartInteractiveSessionOptions,
    ): Promise<InteractiveProviderSessionHandle> {
      this.interactiveStarts += 1;
      this.interactiveOptions.push(options);
      if (this.publishScopeEvidence) {
        await options.beforeProviderThreadStart?.({
          accountFingerprint: this.status.accountFingerprint!,
          selectedModel: this.status.selectedModel!,
        });
      }
      if (this.succeedInteractive) return makeControllableInteractiveSession().handle;
      throw new ProviderTransportStartupError(
        'app_server_handshake_failed',
        this.deliveryState,
        'safe test failure',
      );
    }
  }

  async function fallbackSetup(
    deliveryState: 'not_delivered' | 'ambiguous' | 'delivered',
    requestedTransportMode: 'auto' | 'app-server' = 'auto',
    request = {
      required: [{ id: 'session.cancel' }],
      optional: [] as Array<{ id: string }>,
      allowExperimental: false,
    },
    primarySelection: CapabilitySelection = appServerSelection,
  ) {
    const fixture = await trustedWorkspaceFixture();
    const provider = new StartupFallbackProvider(deliveryState);
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessionManager = new SessionManager(registry, noopLogger, undefined, {
      trustStore: fixture.trustStore,
    });
    const sessions = new V2SessionFacade(sessionManager);
    const primaryManifest: ProviderV2Manifest = {
      interactive: true,
      runtimeScope: {
        ...legacyRuntimeScope(provider.status),
        trustState: 'trusted',
        versions: {
          adapterContract: '2',
          transport: provider.status.version!,
          runtime: process.version,
          schema: 'schema-0.147.0',
          fixtureSet: 'codex-app-server-0.147.0-v1',
        },
      },
      supportRecords: [],
      transports: [appServerTransport],
    };
    const planning = planLegacyProviderFallback({
      status: provider.status,
      request,
      cwd: fixture.identity.canonicalPath,
      workspaceTrust: await sessionManager.verifiedWorkspaceTrust(fixture.identity),
      requestedTransportMode,
      primaryManifest,
      primarySelection,
    });
    return { provider, sessions, sessionManager, planning, fixture, primaryManifest, request };
  }

  it('plans fallback from same-process evidence before the provider thread starts', async () => {
    const { provider, sessions, sessionManager, fixture, primaryManifest, request } =
      await fallbackSetup('not_delivered');
    const baseStatus: ProviderStatus = {
      ...provider.status,
      accountFingerprint: undefined,
      selectedModel: undefined,
    };
    try {
      const workspaceTrust = await sessionManager.verifiedWorkspaceTrust(fixture.identity);
      const session = await sessions.create(
        {
          provider: provider.id,
          cwd: fixture.identity.canonicalPath,
          prompt: 'same process fallback planning',
        },
        appServerSelection,
        appServerTransport,
        true,
        undefined,
        fixture.identity,
        {
          providerStatus: baseStatus,
          fallbackIntent: {
            request,
            cwd: fixture.identity.canonicalPath,
            workspaceTrust,
            requestedTransportMode: 'auto',
            primaryManifest,
            primarySelection: appServerSelection,
          },
        },
      );

      expect(session.transport).toBe('legacy-one-shot');
      expect(provider.interactiveOptions[0]?.beforeProviderThreadStart).toBeTypeOf('function');
      expect(provider.detectionOptions).toEqual([
        expect.objectContaining({ includeLaunchScopeEvidence: true }),
      ]);
      expect(provider.legacyOptions).toHaveLength(1);
      expect(provider.legacyOptions[0]?.model).toBe('gpt-5.4');
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not scope-probe when the supported app-server startup succeeds', async () => {
    const { provider, sessions, sessionManager, fixture, primaryManifest, request } =
      await fallbackSetup('not_delivered');
    provider.succeedInteractive = true;
    const baseStatus: ProviderStatus = {
      ...provider.status,
      accountFingerprint: undefined,
      selectedModel: undefined,
    };
    try {
      const workspaceTrust = await sessionManager.verifiedWorkspaceTrust(fixture.identity);
      const session = await sessions.create(
        {
          provider: provider.id,
          cwd: fixture.identity.canonicalPath,
          prompt: 'same process succeeds',
        },
        appServerSelection,
        appServerTransport,
        true,
        undefined,
        fixture.identity,
        {
          providerStatus: baseStatus,
          fallbackIntent: {
            request,
            cwd: fixture.identity.canonicalPath,
            workspaceTrust,
            requestedTransportMode: 'auto',
            primaryManifest,
            primarySelection: appServerSelection,
          },
        },
      );

      expect(provider.detectionOptions).toHaveLength(0);
      expect(provider.legacyOptions).toHaveLength(0);
      await sessions.cancel(session.id);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not scope-probe when app-server fails before publishing scope evidence', async () => {
    const { provider, sessions, sessionManager, fixture, primaryManifest, request } =
      await fallbackSetup('not_delivered');
    provider.publishScopeEvidence = false;
    const baseStatus: ProviderStatus = {
      ...provider.status,
      accountFingerprint: undefined,
      selectedModel: undefined,
    };
    try {
      const workspaceTrust = await sessionManager.verifiedWorkspaceTrust(fixture.identity);
      await expect(
        sessions.create(
          {
            provider: provider.id,
            cwd: fixture.identity.canonicalPath,
            prompt: 'fails before evidence',
          },
          appServerSelection,
          appServerTransport,
          true,
          undefined,
          fixture.identity,
          {
            providerStatus: baseStatus,
            fallbackIntent: {
              request,
              cwd: fixture.identity.canonicalPath,
              workspaceTrust,
              requestedTransportMode: 'auto',
              primaryManifest,
              primarySelection: appServerSelection,
            },
          },
        ),
      ).rejects.toMatchObject({ fallbackReason: 'fallback_scope_mismatch' });
      expect(provider.detectionOptions).toHaveLength(0);
      expect(provider.legacyOptions).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('falls back once before delivery and pins the exact detected provider snapshot', async () => {
    const { provider, sessions, planning, fixture } = await fallbackSetup('not_delivered');
    try {
      expect(planning.fallback).toBeDefined();
      expect(planning.primaryScope).toBeDefined();
      const session = await sessions.create(
        {
          provider: provider.id,
          cwd: fixture.identity.canonicalPath,
          prompt: 'do not expose this prompt',
        },
        appServerSelection,
        appServerTransport,
        true,
        undefined,
        fixture.identity,
        {
          providerStatus: provider.status,
          primaryScope: planning.primaryScope,
          fallback: planning.fallback,
        },
      );

      expect(provider.interactiveStarts).toBe(1);
      expect(provider.interactiveOptions[0]?.expectedContinuationEvidence).toEqual({
        accountFingerprint: 'a'.repeat(64),
        selectedModel: 'gpt-5.4',
      });
      expect(provider.legacyOptions).toHaveLength(1);
      expect(provider.legacyOptions[0]?.providerStatus).toBe(provider.status);
      expect(provider.legacyOptions[0]?.sandbox).toBe('workspace-write');
      expect(provider.legacyOptions[0]?.model).toBe('gpt-5.4');
      expect(session.transport).toBe('legacy-one-shot');
      expect(session.runtimeMetadata).toMatchObject({
        cliVersion: '0.147.0',
        requestedTransportMode: 'auto',
        fallbackReason: 'app_server_handshake_failed',
      });
      await vi.waitFor(() =>
        expect(sessions.get(session.id)?.providerSessionId).toBe('legacy-thread'),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('denies fallback when workspace trust is revoked during the scope probe', async () => {
    const { provider, sessions, planning, fixture } = await fallbackSetup('not_delivered');
    const probeStarted = deferred<void>();
    const releaseProbe = deferred<void>();
    provider.detectHook = async () => {
      probeStarted.resolve();
      await releaseProbe.promise;
    };
    try {
      const start = sessions.create(
        {
          provider: provider.id,
          cwd: fixture.identity.canonicalPath,
          prompt: 'do not launch fallback',
        },
        appServerSelection,
        appServerTransport,
        true,
        undefined,
        fixture.identity,
        {
          providerStatus: provider.status,
          primaryScope: planning.primaryScope,
          fallback: planning.fallback,
        },
      );
      await probeStarted.promise;
      await fixture.trustStore.beginRevocation(fixture.identity);
      releaseProbe.resolve();

      await expect(start).rejects.toBeInstanceOf(V2ProviderStartupError);
      expect(provider.legacyOptions).toHaveLength(0);
    } finally {
      releaseProbe.resolve();
      await fixture.cleanup();
    }
  });

  it('denies an initial legacy launch when workspace trust is revoked during re-detection', async () => {
    const { provider, sessions, planning, fixture } = await fallbackSetup('not_delivered');
    const probeStarted = deferred<void>();
    const releaseProbe = deferred<void>();
    provider.detectHook = async () => {
      probeStarted.resolve();
      await releaseProbe.promise;
    };
    try {
      const start = sessions.create(
        {
          provider: provider.id,
          cwd: fixture.identity.canonicalPath,
          prompt: 'do not launch legacy transport',
        },
        appServerSelection,
        appServerTransport,
        false,
        undefined,
        fixture.identity,
        {
          providerStatus: provider.status,
          legacyDispatch: {
            frozenScope: planning.primaryScope!,
            sandbox: 'workspace-write',
          },
        },
      );
      await probeStarted.promise;
      await fixture.trustStore.beginRevocation(fixture.identity);
      releaseProbe.resolve();

      await expect(start).rejects.toMatchObject({
        reasonCode: 'provider_scope_revalidation_failed',
        deliveryState: 'not_delivered',
      });
      expect(provider.interactiveStarts).toBe(0);
      expect(provider.legacyOptions).toHaveLength(0);
    } finally {
      releaseProbe.resolve();
      await fixture.cleanup();
    }
  });

  it('falls back with the desktop request while truthfully dropping unavailable rich optionals', async () => {
    const optional = [
      'interaction.approval',
      'interaction.question',
      'content.streaming',
      'content.tools',
      'content.plans',
      'content.usage.tokens',
      'content.usage.cost',
      'content.thinking',
    ].map((id) => ({ id }));
    const richSelection: CapabilitySelection = {
      ...appServerSelection,
      enabled: [
        ...appServerSelection.enabled,
        {
          id: 'interaction.approval',
          constraints: { kind: 'interaction', timeoutMs: 300_000, maxPayloadBytes: 32_768 },
        },
        {
          id: 'interaction.question',
          constraints: { kind: 'interaction', timeoutMs: 300_000, maxPayloadBytes: 32_768 },
        },
        {
          id: 'content.streaming',
          constraints: { kind: 'content', maxBlockBytes: 262_144, persistence: 'live_only' },
        },
        {
          id: 'content.tools',
          constraints: { kind: 'effects', allowedEffects: [...fallbackEffects] },
        },
        {
          id: 'content.plans',
          constraints: { kind: 'content', maxBlockBytes: 262_144, persistence: 'live_only' },
        },
        { id: 'content.usage.tokens', constraints: { kind: 'usage', scopes: ['turn'] } },
      ],
      unavailableOptional: [
        { id: 'content.usage.cost', reason: 'unsupported' },
        { id: 'content.thinking', reason: 'unsupported' },
      ],
    };
    const request = {
      required: [{ id: 'session.cancel' }],
      optional,
      allowExperimental: false,
    };
    const { provider, sessions, planning, fixture } = await fallbackSetup(
      'not_delivered',
      'auto',
      request,
      richSelection,
    );
    try {
      expect(planning.fallback).toBeDefined();
      const result = await sessions.create(
        {
          provider: provider.id,
          cwd: fixture.identity.canonicalPath,
          prompt: 'desktop request',
          capabilities: request,
        },
        richSelection,
        appServerTransport,
        true,
        undefined,
        fixture.identity,
        {
          providerStatus: provider.status,
          primaryScope: planning.primaryScope,
          fallback: planning.fallback,
        },
      );
      expect(result.selection.enabled.map(({ id }) => id)).toEqual(['session.cancel']);
      expect(result.selection.unavailableOptional.map(({ id }) => id).sort()).toEqual(
        optional.map(({ id }) => id).sort(),
      );
      expect(provider.legacyOptions).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['ambiguous', 'delivered'] as const)(
    'never falls back after %s delivery state',
    async (deliveryState) => {
      const { provider, sessions, planning, fixture } = await fallbackSetup(deliveryState);
      try {
        expect(planning.fallback).toBeDefined();
        expect(planning.primaryScope).toBeDefined();
        await expect(
          sessions.create(
            { provider: provider.id, cwd: fixture.identity.canonicalPath, prompt: 'one turn' },
            appServerSelection,
            appServerTransport,
            true,
            undefined,
            fixture.identity,
            {
              providerStatus: provider.status,
              primaryScope: planning.primaryScope,
              fallback: planning.fallback,
            },
          ),
        ).rejects.toBeInstanceOf(V2ProviderStartupError);
        expect(provider.interactiveStarts).toBe(1);
        expect(provider.detectionOptions).toHaveLength(0);
        expect(provider.legacyOptions).toHaveLength(0);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('does not retry when app-server was explicitly forced', async () => {
    const { provider, sessions, sessionManager, planning, fixture, primaryManifest, request } =
      await fallbackSetup('not_delivered', 'app-server');
    expect(planning.fallback).toBeUndefined();
    expect(planning.deniedReason).toBe('fallback_transport_mode_forced');
    try {
      const workspaceTrust = await sessionManager.verifiedWorkspaceTrust(fixture.identity);
      await expect(
        sessions.create(
          {
            provider: provider.id,
            cwd: fixture.identity.canonicalPath,
            prompt: 'one turn',
          },
          appServerSelection,
          appServerTransport,
          true,
          undefined,
          fixture.identity,
          {
            providerStatus: provider.status,
            fallbackIntent: {
              request,
              cwd: fixture.identity.canonicalPath,
              workspaceTrust,
              requestedTransportMode: 'app-server',
              primaryManifest,
              primarySelection: appServerSelection,
            },
          },
        ),
      ).rejects.toMatchObject({
        code: 'provider_transport_startup_failed',
        fallbackReason: 'fallback_transport_mode_forced',
      });
      expect(provider.interactiveStarts).toBe(1);
      expect(provider.detectionOptions).toHaveLength(0);
      expect(provider.legacyOptions).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ['executable', { executablePath: 'C:\\switched\\codex.exe' }],
    ['auth source', { authSource: 'api_key' as const }],
    ['account', { accountFingerprint: 'b'.repeat(64) }],
    ['model', { selectedModel: 'gpt-5.4-mini' }],
  ])('denies fallback when re-detection changes the pinned %s', async (_label, change) => {
    const { provider, sessions, planning, fixture } = await fallbackSetup('not_delivered');
    provider.redetectedStatus = { ...provider.status, ...change };
    try {
      await expect(
        sessions.create(
          { provider: provider.id, cwd: fixture.identity.canonicalPath, prompt: 'one turn' },
          appServerSelection,
          appServerTransport,
          true,
          undefined,
          fixture.identity,
          {
            providerStatus: provider.status,
            primaryScope: planning.primaryScope,
            fallback: planning.fallback,
          },
        ),
      ).rejects.toMatchObject({
        code: 'provider_transport_startup_failed',
        fallbackReason: 'fallback_provider_scope_changed',
      });
      expect(provider.interactiveStarts).toBe(1);
      expect(provider.legacyOptions).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('SessionManager — interactive removal', () => {
  it('waits for close and the provider event stream before deleting the session', async () => {
    const closeGate = deferred<void>();
    const { interactive, sessionManager, session } = await setupInteractive({
      close: () => closeGate.promise,
    });
    let removed = false;
    const removing = sessionManager.remove(session.id).then((result) => {
      removed = true;
      return result;
    });

    await tick();
    expect(interactive.closeCalls()).toBe(1);
    expect(removed).toBe(false);
    expect(sessionManager.get(session.id)).toBeDefined();

    closeGate.resolve();
    await tick();
    expect(removed).toBe(false);

    interactive.push({ type: 'session.cancelled', reason: 'closed' });
    interactive.finish();
    await expect(removing).resolves.toBe(true);
    expect(sessionManager.get(session.id)).toBeUndefined();
  });
});

describe('SessionManager — staged attachments and output schema (issue #59)', () => {
  async function* chunks(...values: Buffer[]) {
    for (const value of values) yield value;
  }

  async function newAttachmentStore(): Promise<AttachmentStore> {
    const root = await mkdtemp(join(tmpdir(), 'agent-dock-session-attachments-'));
    const store = new AttachmentStore(join(root, 'staged'), join(root, 'manifest.json'));
    await store.load();
    return store;
  }

  async function stagePng(store: AttachmentStore): Promise<string> {
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fixture'),
    ]);
    const attachment = await store.stage({
      fileName: 'image.png',
      declaredSize: bytes.length,
      stream: chunks(bytes),
    });
    return attachment.id;
  }

  it('resolves and binds a staged attachment transactionally, passing its real path to the provider', async () => {
    const attachmentStore = await newAttachmentStore();
    const attachmentId = await stagePng(attachmentStore);
    const interactive = makeControllableInteractiveSession();
    const provider = new InteractiveTestProvider(interactive);
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessionManager = new SessionManager(registry, noopLogger, undefined, { attachmentStore });

    const session = await sessionManager.createInteractive(
      provider.id,
      '/tmp',
      'hello',
      INTERACTIVE_SELECTION,
      INTERACTIVE_TRANSPORT,
      INTERACTIVE_EXECUTION_ID,
      INTERACTIVE_TURN_ID,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [attachmentId],
    );

    expect(provider.interactiveOptions[0]?.attachments).toEqual([
      { attachmentId, path: expect.stringContaining('.bin') as unknown as string, mimeType: 'image/png', byteLength: expect.any(Number) as unknown as number },
    ]);
    const [record] = await attachmentStore.referenceForDispatch([attachmentId], session.id);
    expect(record?.sessionId).toBe(session.id);
  });

  it('rejects a cross-session attachment id before creating any session record', async () => {
    const attachmentStore = await newAttachmentStore();
    const attachmentId = await stagePng(attachmentStore);
    await attachmentStore.reference([attachmentId], '123e4567-e89b-42d3-a456-426614174099');
    const interactive = makeControllableInteractiveSession();
    const provider = new InteractiveTestProvider(interactive);
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessionManager = new SessionManager(registry, noopLogger, undefined, { attachmentStore });

    await expect(
      sessionManager.createInteractive(
        provider.id,
        '/tmp',
        'hello',
        INTERACTIVE_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [attachmentId],
      ),
    ).rejects.toMatchObject({ code: 'attachment_not_found' });
    expect(provider.interactiveOptions).toHaveLength(0);
  });

  it('rejects requesting attachments when no attachment store is configured for the daemon', async () => {
    const interactive = makeControllableInteractiveSession();
    const provider = new InteractiveTestProvider(interactive);
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessionManager = new SessionManager(registry, noopLogger, undefined, {});

    await expect(
      sessionManager.createInteractive(
        provider.id,
        '/tmp',
        'hello',
        INTERACTIVE_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ['00000000-0000-4000-8000-000000000000'],
      ),
    ).rejects.toThrow('no attachment store is configured');
  });

  it('releases bound attachments once the session reaches a terminal state, recovering quota', async () => {
    const attachmentStore = await newAttachmentStore();
    const attachmentId = await stagePng(attachmentStore);
    const interactive = makeControllableInteractiveSession();
    const provider = new InteractiveTestProvider(interactive);
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessionManager = new SessionManager(registry, noopLogger, undefined, { attachmentStore });

    await sessionManager.createInteractive(
      provider.id,
      '/tmp',
      'hello',
      INTERACTIVE_SELECTION,
      INTERACTIVE_TRANSPORT,
      INTERACTIVE_EXECUTION_ID,
      INTERACTIVE_TURN_ID,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [attachmentId],
    );
    expect(attachmentStore.list()).toHaveLength(1);

    interactive.push({ type: 'session.completed' });
    interactive.finish();
    // deleteAttachments() does real disk I/O (unlink + a rewritten manifest); a fixed tick() only
    // waits for one macrotask, not for that I/O to actually settle -- poll instead.
    await vi.waitFor(() => expect(attachmentStore.list()).toHaveLength(0));
  });

  it('passes the negotiated output schema through to the provider', async () => {
    const interactive = makeControllableInteractiveSession();
    const provider = new InteractiveTestProvider(interactive);
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessionManager = new SessionManager(registry, noopLogger);
    const outputSchema = { type: 'object', required: ['answer'] };

    await sessionManager.createInteractive(
      provider.id,
      '/tmp',
      'hello',
      INTERACTIVE_SELECTION,
      INTERACTIVE_TRANSPORT,
      INTERACTIVE_EXECUTION_ID,
      INTERACTIVE_TURN_ID,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      outputSchema,
    );

    expect(provider.interactiveOptions[0]?.outputSchema).toEqual(outputSchema);
  });
});

describe('SessionManager — subagent graph wiring (issue #58)', () => {
  const AGENT_ID = uuid(50_000);
  const controls = { steer: false, interrupt: false, cancel: false };

  async function newSubagentStore(): Promise<SubagentGraphStore> {
    const dir = await mkdtemp(join(tmpdir(), 'agent-dock-subagents-'));
    return new SubagentGraphStore(join(dir, 'subagents-v1.json'));
  }

  it('upserts a spawning node into the store from a real subagent.status event', async () => {
    const subagentStore = await newSubagentStore();
    const { interactive, session } = await setupInteractive({}, { subagentStore });

    interactive.push({
      type: 'subagent.status',
      turnId: INTERACTIVE_TURN_ID,
      agentId: AGENT_ID,
      nativeChildId: 'native-child-1',
      name: 'reviewer',
      status: 'spawning',
      controls,
    });
    await tick();

    const graph = subagentStore.graph(session.id);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({
      id: AGENT_ID,
      sessionId: session.id,
      nativeChildId: 'native-child-1',
      provider: 'claude',
      name: 'reviewer',
      status: 'spawning',
    });
    expect(graph.nodes[0]?.completedAt).toBeUndefined();
  });

  it('preserves startedAt and sets completedAt only once the status becomes terminal', async () => {
    const subagentStore = await newSubagentStore();
    const { interactive, session } = await setupInteractive({}, { subagentStore });

    interactive.push({
      type: 'subagent.status',
      turnId: INTERACTIVE_TURN_ID,
      agentId: AGENT_ID,
      name: 'reviewer',
      status: 'spawning',
      controls,
    });
    await tick();
    const firstStartedAt = subagentStore.graph(session.id).nodes[0]?.startedAt;
    expect(firstStartedAt).toBeDefined();

    interactive.push({
      type: 'subagent.status',
      turnId: INTERACTIVE_TURN_ID,
      agentId: AGENT_ID,
      name: 'reviewer',
      status: 'running',
      controls,
    });
    await tick();
    const running = subagentStore.graph(session.id).nodes[0];
    expect(running?.status).toBe('running');
    expect(running?.startedAt).toBe(firstStartedAt);
    expect(running?.completedAt).toBeUndefined();

    interactive.push({
      type: 'subagent.status',
      turnId: INTERACTIVE_TURN_ID,
      agentId: AGENT_ID,
      name: 'reviewer',
      status: 'completed',
      controls,
    });
    await tick();
    const completed = subagentStore.graph(session.id).nodes[0];
    expect(completed?.status).toBe('completed');
    expect(completed?.startedAt).toBe(firstStartedAt);
    expect(completed?.completedAt).toBeDefined();

    // A replayed/duplicate terminal event for the same agentId must not slide completedAt
    // forward -- the first terminal timestamp is the real one.
    const firstCompletedAt = completed?.completedAt;
    interactive.push({
      type: 'subagent.status',
      turnId: INTERACTIVE_TURN_ID,
      agentId: AGENT_ID,
      name: 'reviewer',
      status: 'completed',
      controls,
    });
    await tick();
    expect(subagentStore.graph(session.id).nodes[0]?.completedAt).toBe(firstCompletedAt);
  });

  it('is idempotent for a replayed/duplicate event: the same agentId stays one bounded node', async () => {
    const subagentStore = await newSubagentStore();
    const { interactive, session } = await setupInteractive({}, { subagentStore });

    for (let i = 0; i < 3; i += 1) {
      interactive.push({
        type: 'subagent.status',
        turnId: INTERACTIVE_TURN_ID,
        agentId: AGENT_ID,
        name: 'reviewer',
        status: 'running',
        controls,
      });
    }
    await tick();

    expect(subagentStore.graph(session.id).nodes).toHaveLength(1);
  });

  it('does nothing when no subagentStore is configured (default security options)', async () => {
    const { interactive } = await setupInteractive({}, {});
    interactive.push({
      type: 'subagent.status',
      turnId: INTERACTIVE_TURN_ID,
      agentId: AGENT_ID,
      name: 'reviewer',
      status: 'spawning',
      controls,
    });
    await tick();
    // No assertion target exists without a store; this only proves the event loop does not throw
    // when subagentStore is undefined, matching every other optional security dependency.
  });
});

/**
 * Supports both the legacy (v1) and interactive (v2) launch paths on one provider instance, each
 * session individually controllable and independently trackable, so mixed v1/v2 admission tests
 * can hold an arbitrary number of sessions open and finish them one at a time.
 */
class MixedAdmissionProvider implements AgentProvider {
  readonly id: ProviderId = 'claude';
  readonly name = 'Mixed Admission Test Provider';
  readonly legacySessions = new Map<string, ControllableSession>();
  readonly interactiveSessions = new Map<string, ControllableInteractiveSession>();

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: true,
      authenticated: 'authenticated',
      capabilities: {
        resume: false,
        cancellation: true,
        tools: false,
        usage: false,
        thinking: false,
      },
    };
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    const session = makeControllableSession();
    this.legacySessions.set(options.sessionId, session);
    return session.handle;
  }

  async startInteractiveSession(
    options: StartInteractiveSessionOptions,
  ): Promise<InteractiveProviderSessionHandle> {
    const session = makeControllableInteractiveSession();
    this.interactiveSessions.set(options.sessionId, session);
    return session.handle;
  }
}

describe('SessionManager — admission control (issue #52)', () => {
  function setupMixed(maxActiveSessions: number) {
    const provider = new MixedAdmissionProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);
    const admission = new SessionAdmissionController({ maxActiveSessions });
    const sessionManager = new SessionManager(registry, noopLogger, undefined, { admission });
    return { provider, admission, sessionManager };
  }

  it('rejects the (N+1)th start once N sessions are pending/active, across mixed v1 and v2 calls, with no phantom durable record', async () => {
    const { provider, sessionManager } = setupMixed(2);

    const a = sessionManager.create('claude', '/tmp', 'a');
    const b = await sessionManager.createInteractive(
      'claude',
      '/tmp',
      'b',
      INTERACTIVE_SELECTION,
      INTERACTIVE_TRANSPORT,
      INTERACTIVE_EXECUTION_ID,
      INTERACTIVE_TURN_ID,
    );

    expect(() => sessionManager.create('claude', '/tmp', 'c')).toThrow(SessionCapacityError);
    await expect(
      sessionManager.createInteractive(
        'claude',
        '/tmp',
        'd',
        INTERACTIVE_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
      ),
    ).rejects.toThrow(SessionCapacityError);

    // Exactly the two admitted sessions exist; the rejected attempts never reached the provider
    // and left no durable record behind.
    expect(
      sessionManager
        .list()
        .map((session) => session.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(provider.legacySessions.size).toBe(1);
    expect(provider.interactiveSessions.size).toBe(1);
  });

  it('N+1 simultaneous starts at limit N launch exactly N providers and reject exactly one', async () => {
    const { provider, admission, sessionManager } = setupMixed(3);

    const results = await Promise.allSettled([
      (async () => sessionManager.create('claude', '/tmp', 'a'))(),
      sessionManager.createInteractive(
        'claude',
        '/tmp',
        'b',
        INTERACTIVE_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
      ),
      (async () => sessionManager.create('claude', '/tmp', 'c'))(),
      sessionManager.createInteractive(
        'claude',
        '/tmp',
        'd',
        INTERACTIVE_SELECTION,
        INTERACTIVE_TRANSPORT,
        INTERACTIVE_EXECUTION_ID,
        INTERACTIVE_TURN_ID,
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SessionCapacityError);
    expect(admission.activeCount).toBe(3);
    expect(sessionManager.list()).toHaveLength(3);
    expect(provider.legacySessions.size + provider.interactiveSessions.size).toBe(3);
  });

  it('releases the slot exactly once on normal completion, making it immediately reusable', async () => {
    const { provider, sessionManager } = setupMixed(1);
    const a = sessionManager.create('claude', '/tmp', 'a');
    expect(() => sessionManager.create('claude', '/tmp', 'blocked')).toThrow(SessionCapacityError);

    provider.legacySessions.get(a.id)!.push({ type: 'session.completed' });
    provider.legacySessions.get(a.id)!.finish();
    await tick();

    const b = sessionManager.create('claude', '/tmp', 'b');
    expect(b.id).not.toBe(a.id);
    expect(
      sessionManager
        .list()
        .map((session) => session.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });

  it('releases the slot on cancel()', async () => {
    const { provider, sessionManager } = setupMixed(1);
    const a = sessionManager.create('claude', '/tmp', 'a');
    expect(() => sessionManager.create('claude', '/tmp', 'blocked')).toThrow(SessionCapacityError);

    const testSession = provider.legacySessions.get(a.id)!;
    // Simulate the provider actually reacting to cancellation, the way run-session.ts does:
    // handle.cancel() alone doesn't end the event stream, so runtime.done never resolves without it.
    const cancelling = sessionManager.cancel(a.id);
    testSession.push({ type: 'session.cancelled' });
    testSession.finish();
    await cancelling;
    await tick();

    const b = sessionManager.create('claude', '/tmp', 'b');
    expect(b.id).not.toBe(a.id);
  });

  it('releases the slot on remove()', async () => {
    const { provider, sessionManager } = setupMixed(1);
    const a = sessionManager.create('claude', '/tmp', 'a');
    expect(() => sessionManager.create('claude', '/tmp', 'blocked')).toThrow(SessionCapacityError);

    const testSession = provider.legacySessions.get(a.id)!;
    const removing = sessionManager.remove(a.id);
    testSession.push({ type: 'session.cancelled' });
    testSession.finish();
    await removing;
    await tick();

    const b = sessionManager.create('claude', '/tmp', 'b');
    expect(b.id).not.toBe(a.id);
  });

  it('releases the slot when interactive session startup fails before the runtime is ever admitted', async () => {
    const failing = new PendingInteractiveProvider();
    const registry = new ProviderRegistry();
    registry.register(failing);
    const admission = new SessionAdmissionController({ maxActiveSessions: 1 });
    const sessionManager = new SessionManager(registry, noopLogger, undefined, { admission });

    const controller = new AbortController();
    const starting = sessionManager.createInteractive(
      failing.id,
      '/tmp',
      'hello',
      INTERACTIVE_SELECTION,
      INTERACTIVE_TRANSPORT,
      INTERACTIVE_EXECUTION_ID,
      INTERACTIVE_TURN_ID,
      controller.signal,
    );
    controller.abort();
    await expect(starting).rejects.toThrow();
    expect(admission.activeCount).toBe(0);

    // The freed slot is immediately usable by a fresh start.
    const session = sessionManager.create(failing.id, '/tmp', 'reuses the freed slot');
    expect(session.id).toBeDefined();
  });

  it('rejects invalid startup configuration (maxActiveSessions out of the 1..32 range) synchronously', () => {
    expect(() => new SessionAdmissionController({ maxActiveSessions: 0 })).toThrow();
    expect(() => new SessionAdmissionController({ maxActiveSessions: 33 })).toThrow();
  });
});
