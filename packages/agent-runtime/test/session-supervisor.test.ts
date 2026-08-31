import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentCommandV2,
  AgentEventV2,
  CapabilitySelection,
  ProviderTransportV2,
} from '@agent-dock/shared';
import { AsyncChannel } from '../src/process/async-channel.js';
import {
  InteractiveSessionError,
  superviseInteractiveSession,
} from '../src/providers/common/session-supervisor.js';
import type {
  AcceptedWorkState,
  InteractiveProviderTransport,
  ProviderInteractionResolution,
  StartInteractiveSessionOptions,
} from '../src/types.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174100';
const TURN_ID = '123e4567-e89b-42d3-a456-426614174101';
const EXECUTION_ID = '123e4567-e89b-42d3-a456-426614174102';
const COMMAND_ID = '123e4567-e89b-42d3-a456-426614174103';
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174104';
const QUESTION_ID = '123e4567-e89b-42d3-a456-426614174105';
const FOLLOW_UP_TURN_ID = '123e4567-e89b-42d3-a456-426614174107';

const TRANSPORT: ProviderTransportV2 = {
  id: 'memory',
  priority: 1,
  stability: 'stable',
  possibleEffects: [],
  effectsComplete: true,
};

const SELECTION: CapabilitySelection = {
  transport: TRANSPORT.id,
  enabled: [
    {
      id: 'session.input.follow_up',
      constraints: { kind: 'text_input', maxCharacters: 200_000, attachmentKinds: [] },
    },
    {
      id: 'session.interrupt',
      constraints: { kind: 'acknowledgement', timeoutMs: 30_000 },
    },
    {
      id: 'interaction.approval',
      constraints: { kind: 'interaction', timeoutMs: 300_000, maxPayloadBytes: 32 * 1024 },
    },
    {
      id: 'interaction.question',
      constraints: { kind: 'interaction', timeoutMs: 300_000, maxPayloadBytes: 32 * 1024 },
    },
  ],
  unavailableOptional: [],
  possibleEffects: [],
  effectsComplete: true,
};

const START_OPTIONS: StartInteractiveSessionOptions = {
  sessionId: SESSION_ID,
  executionId: EXECUTION_ID,
  turnId: TURN_ID,
  cwd: 'C:\\workspace',
  prompt: 'hello',
  transport: TRANSPORT,
  selection: SELECTION,
};

const FOLLOW_UP: AgentCommandV2 = {
  type: 'input.follow_up',
  commandId: COMMAND_ID,
  sessionId: SESSION_ID,
  turnId: FOLLOW_UP_TURN_ID,
  content: [
    {
      type: 'text',
      id: '123e4567-e89b-42d3-a456-426614174106',
      text: 'next',
    },
  ],
};

const TERMINAL_TYPES = new Set<AgentEventV2['type']>([
  'session.completed',
  'session.failed',
  'session.cancelled',
  'session.interrupted',
]);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface MemoryTransportOptions {
  started?: Promise<void>;
  accepted?: Promise<AcceptedWorkState>;
  events?: AsyncGenerator<unknown, void, void>;
  stderr?: AsyncGenerator<unknown, void, void>;
  send?: (command: AgentCommandV2) => Promise<void>;
  resolveInteraction?: (resolution: ProviderInteractionResolution) => Promise<void>;
  interrupt?: () => Promise<void>;
  close?: () => Promise<void>;
  forceClose?: () => Promise<void>;
}

class MemoryTransport implements InteractiveProviderTransport {
  private readonly input = new AsyncChannel<unknown>();
  readonly sent: AgentCommandV2[] = [];
  readonly resolutions: ProviderInteractionResolution[] = [];
  readonly actions: string[] = [];
  readonly started: Promise<void>;
  readonly accepted: Promise<AcceptedWorkState>;
  readonly events: AsyncGenerator<unknown, void, void>;
  readonly stderr: AsyncGenerator<unknown, void, void>;
  interruptCalls = 0;
  closeCalls = 0;
  forceCloseCalls = 0;

  constructor(private readonly behavior: MemoryTransportOptions = {}) {
    this.started = behavior.started ?? Promise.resolve();
    this.accepted = behavior.accepted ?? Promise.resolve('accepted');
    this.events = behavior.events ?? this.input[Symbol.asyncIterator]();
    this.stderr =
      behavior.stderr ??
      (async function* (): AsyncGenerator<unknown, void, void> {
        // no-op
      })();
  }

  emit(value: unknown): void {
    if (!this.input.push(value)) throw new Error('test transport input is closed or full');
  }

  disconnect(): void {
    this.input.close();
  }

  async send(command: AgentCommandV2): Promise<void> {
    this.sent.push(command);
    this.actions.push('send');
    await this.behavior.send?.(command);
  }

  async resolveInteraction(resolution: ProviderInteractionResolution): Promise<void> {
    this.resolutions.push(resolution);
    this.actions.push(`resolve:${resolution.reason}`);
    await this.behavior.resolveInteraction?.(resolution);
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
    this.actions.push('interrupt');
    if (this.behavior.interrupt) {
      await this.behavior.interrupt();
      return;
    }
    this.emit({ type: 'turn.interrupted', turnId: TURN_ID, reason: 'test interrupt' });
    this.emit({ type: 'session.status', status: 'idle' });
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.actions.push('close');
    if (this.behavior.close) {
      await this.behavior.close();
      return;
    }
    this.input.close();
  }

  async forceClose(): Promise<void> {
    this.forceCloseCalls += 1;
    this.actions.push('force-close');
    if (this.behavior.forceClose) {
      await this.behavior.forceClose();
      return;
    }
    this.input.close();
  }
}

async function nextEvent(events: AsyncGenerator<AgentEventV2, void, void>): Promise<AgentEventV2> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('timed out waiting for supervisor event')), 1_000).unref();
  });
  const result = await Promise.race([events.next(), timeout]);
  if (result.done) throw new Error('supervisor event stream ended unexpectedly');
  return result.value;
}

async function collectRemaining(
  events: AsyncGenerator<AgentEventV2, void, void>,
): Promise<AgentEventV2[]> {
  const collected: AgentEventV2[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function terminalEvents(events: AgentEventV2[]): AgentEventV2[] {
  return events.filter((event) => TERMINAL_TYPES.has(event.type));
}

function questionRequest(requestId = REQUEST_ID, questionId = QUESTION_ID): AgentEventV2 {
  return {
    type: 'question.requested',
    turnId: TURN_ID,
    requestId,
    questions: [
      {
        id: questionId,
        title: 'Question',
        prompt: 'Choose',
        allowsFreeText: true,
      },
    ],
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function sessionStarted(selection: CapabilitySelection = SELECTION): AgentEventV2 {
  return {
    type: 'session.started',
    provider: 'claude',
    transport: TRANSPORT.id,
    selection,
  };
}

async function startActiveSession(
  transport: MemoryTransport,
  handle: { events: AsyncGenerator<AgentEventV2, void, void> },
  selection: CapabilitySelection = SELECTION,
): Promise<void> {
  transport.emit(sessionStarted(selection));
  transport.emit({ type: 'session.status', status: 'active' });
  transport.emit({ type: 'turn.started', turnId: TURN_ID });
  expect(await nextEvent(handle.events)).toMatchObject({ type: 'session.started' });
  expect(await nextEvent(handle.events)).toEqual({ type: 'session.status', status: 'active' });
  expect(await nextEvent(handle.events)).toEqual({ type: 'turn.started', turnId: TURN_ID });
}

async function startIdleSession(
  transport: MemoryTransport,
  handle: { events: AsyncGenerator<AgentEventV2, void, void> },
): Promise<void> {
  await startActiveSession(transport, handle);
  transport.emit({ type: 'turn.completed', turnId: TURN_ID });
  transport.emit({ type: 'session.status', status: 'idle' });
  expect(await nextEvent(handle.events)).toEqual({ type: 'turn.completed', turnId: TURN_ID });
  expect(await nextEvent(handle.events)).toEqual({ type: 'session.status', status: 'idle' });
}

function testUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

describe('interactive session supervisor', () => {
  it('does not expose a handle until the startup handshake succeeds', async () => {
    const startup = deferred<void>();
    const transport = new MemoryTransport({ started: startup.promise });
    const pending = superviseInteractiveSession(transport, START_OPTIONS, {
      commandTimeoutMs: 100,
    });
    const resolved = vi.fn();
    void pending.then(resolved);

    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();

    startup.resolve();
    const handle = await pending;
    expect(await handle.accepted).toBe('accepted');

    await handle.close();
    expect(terminalEvents(await collectRemaining(handle.events))).toHaveLength(1);
  });

  it('closes the transport when the startup handshake fails', async () => {
    const transport = new MemoryTransport({ started: Promise.reject(new Error('no handshake')) });

    await expect(
      superviseInteractiveSession(transport, START_OPTIONS, { commandTimeoutMs: 10 }),
    ).rejects.toThrow('no handshake');
    expect(transport.closeCalls).toBe(1);
  });

  it('force-closes a hung transport after a failed startup handshake', async () => {
    const transport = new MemoryTransport({
      started: Promise.reject(new Error('no handshake')),
      close: () => new Promise<void>(() => undefined),
    });

    await expect(
      superviseInteractiveSession(transport, START_OPTIONS, {
        commandTimeoutMs: 5,
        closeTimeoutMs: 5,
      }),
    ).rejects.toThrow('no handshake');
    expect(transport.forceCloseCalls).toBe(1);
  });

  it('observes accepted-work rejection while startup is still pending', async () => {
    const startup = deferred<void>();
    const transport = new MemoryTransport({
      started: startup.promise,
      accepted: Promise.reject(new Error('acceptance failed early')),
    });
    const pending = superviseInteractiveSession(transport, START_OPTIONS, {
      commandTimeoutMs: 100,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    startup.resolve();
    const handle = await pending;

    await expect(handle.accepted).resolves.toBe('unknown');
    expect(terminalEvents(await collectRemaining(handle.events))).toEqual([
      expect.objectContaining({ type: 'session.failed', code: 'provider_crash' }),
    ]);
  });

  it('aborts and reaps while the startup handshake is pending', async () => {
    const controller = new AbortController();
    const transport = new MemoryTransport({
      started: new Promise<void>(() => undefined),
      accepted: new Promise<AcceptedWorkState>(() => undefined),
    });
    const pending = superviseInteractiveSession(
      transport,
      { ...START_OPTIONS, signal: controller.signal },
      { commandTimeoutMs: 100, closeTimeoutMs: 20 },
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'session_aborted' });
    expect(transport.closeCalls).toBe(1);
  });

  it('aborts and reaps while the accepted-work boundary is pending', async () => {
    const controller = new AbortController();
    const transport = new MemoryTransport({
      accepted: new Promise<AcceptedWorkState>(() => undefined),
    });
    const handle = await superviseInteractiveSession(
      transport,
      { ...START_OPTIONS, signal: controller.signal },
      { commandTimeoutMs: 100, closeTimeoutMs: 20 },
    );

    controller.abort();

    await expect(handle.accepted).resolves.toBe('unknown');
    expect(terminalEvents(await collectRemaining(handle.events))).toEqual([
      expect.objectContaining({ type: 'session.cancelled' }),
    ]);
    expect(transport.closeCalls).toBe(1);
  });

  it('fails and reaps a session whose initial accepted-work boundary times out', async () => {
    const transport = new MemoryTransport({
      accepted: new Promise<AcceptedWorkState>(() => undefined),
    });
    const handle = await superviseInteractiveSession(transport, START_OPTIONS, {
      commandTimeoutMs: 5,
      closeTimeoutMs: 20,
    });

    await expect(handle.accepted).resolves.toBe('unknown');
    const events = await collectRemaining(handle.events);
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: 'session.failed', code: 'command_timeout' }),
    ]);
    expect(transport.closeCalls).toBe(1);
  });

  it('resolves send only after the transport accepts the command', async () => {
    const accepted = deferred<void>();
    const transport = new MemoryTransport({ send: () => accepted.promise });
    const handle = await superviseInteractiveSession(transport, START_OPTIONS, {
      commandTimeoutMs: 100,
    });
    await startIdleSession(transport, handle);
    const resolved = vi.fn();
    const sending = handle.send(FOLLOW_UP).then(resolved);

    await Promise.resolve();
    expect(transport.sent).toEqual([FOLLOW_UP]);
    expect(resolved).not.toHaveBeenCalled();

    accepted.resolve();
    await sending;
    expect(resolved).toHaveBeenCalledOnce();

    await handle.close();
    await collectRemaining(handle.events);
  });

  it('fails the session when command acceptance times out', async () => {
    const transport = new MemoryTransport({ send: () => new Promise<void>(() => undefined) });
    const handle = await superviseInteractiveSession(transport, START_OPTIONS, {
      commandTimeoutMs: 5,
      closeTimeoutMs: 20,
    });
    await startIdleSession(transport, handle);

    await expect(handle.send(FOLLOW_UP)).rejects.toMatchObject({ code: 'command_timeout' });
    const events = await collectRemaining(handle.events);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'command_timeout' }),
    );
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: 'session.failed', code: 'command_timeout' }),
    ]);
  });

  it('rejects a second queued follow-up after the first reserves the idle turn boundary', async () => {
    const accepted = deferred<void>();
    const transport = new MemoryTransport({ send: () => accepted.promise });
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startIdleSession(transport, handle);
    const first = handle.send(FOLLOW_UP);

    await expect(
      handle.send({ ...FOLLOW_UP, commandId: testUuid(700), turnId: testUuid(701) }),
    ).rejects.toMatchObject({ code: 'command_rejected' });
    expect(transport.sent).toEqual([FOLLOW_UP]);

    accepted.resolve();
    await first;
    await handle.close();
    await collectRemaining(handle.events);
  });

  it('rejects reuse of any earlier completed turn id, not only the most recent one', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startIdleSession(transport, handle);
    await handle.send(FOLLOW_UP);
    transport.emit({ type: 'session.status', status: 'active' });
    transport.emit({ type: 'turn.started', turnId: FOLLOW_UP_TURN_ID });
    transport.emit({ type: 'turn.completed', turnId: FOLLOW_UP_TURN_ID });
    transport.emit({ type: 'session.status', status: 'idle' });
    expect(await nextEvent(handle.events)).toEqual({ type: 'session.status', status: 'active' });
    expect(await nextEvent(handle.events)).toEqual({
      type: 'turn.started',
      turnId: FOLLOW_UP_TURN_ID,
    });
    expect(await nextEvent(handle.events)).toEqual({
      type: 'turn.completed',
      turnId: FOLLOW_UP_TURN_ID,
    });
    expect(await nextEvent(handle.events)).toEqual({ type: 'session.status', status: 'idle' });

    await expect(
      handle.send({ ...FOLLOW_UP, commandId: testUuid(702), turnId: TURN_ID }),
    ).rejects.toMatchObject({ code: 'command_rejected' });

    await handle.close();
    await collectRemaining(handle.events);
  });

  it('fails once when provider lifecycle starts twice', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    transport.emit(sessionStarted());
    expect(await nextEvent(handle.events)).toMatchObject({ type: 'session.started' });

    transport.emit(sessionStarted());

    const events = await collectRemaining(handle.events);
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: 'session.failed', code: 'provider_correlation_error' }),
    ]);
    expect(transport.closeCalls).toBe(1);
  });

  it('fails once when provider content references a non-active turn', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startActiveSession(transport, handle);
    transport.emit({
      type: 'content.delta',
      turnId: testUuid(99),
      contentBlockId: testUuid(100),
      delta: 'wrong turn',
    });

    const events = await collectRemaining(handle.events);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'content.delta' }));
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: 'session.failed', code: 'provider_correlation_error' }),
    ]);
  });

  it('correlates an approval response and publishes exactly one user resolution', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startActiveSession(transport, handle);
    transport.emit({
      type: 'approval.requested',
      turnId: TURN_ID,
      requestId: REQUEST_ID,
      title: 'Allow?',
      action: 'read',
      target: 'workspace',
      possibleEffects: ['read'],
      effectsComplete: true,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await nextEvent(handle.events)).toMatchObject({
      type: 'approval.requested',
      requestId: REQUEST_ID,
    });

    const response: AgentCommandV2 = {
      type: 'approval.respond',
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      requestId: REQUEST_ID,
      decision: 'deny',
    };
    await handle.send(response);

    expect(transport.sent).toEqual([response]);
    expect(await nextEvent(handle.events)).toEqual({
      type: 'approval.resolved',
      turnId: TURN_ID,
      requestId: REQUEST_ID,
      decision: 'denied',
      actor: 'user',
    });

    await expect(handle.send(response)).rejects.toMatchObject({ code: 'stale_interaction' });
    await handle.close();
    await collectRemaining(handle.events);
  });

  it('accepts one provider-emitted resolution during response dispatch without duplicating it', async () => {
    const accepted = deferred<void>();
    const transport = new MemoryTransport({
      send: async () => {
        transport.emit({
          type: 'question.resolved',
          turnId: TURN_ID,
          requestId: REQUEST_ID,
          answers: [{ questionId: QUESTION_ID, value: 'provider answer' }],
        });
        await accepted.promise;
      },
    });
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startActiveSession(transport, handle);
    transport.emit(questionRequest());
    await nextEvent(handle.events);

    const command: AgentCommandV2 = {
      type: 'question.respond',
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      requestId: REQUEST_ID,
      answers: [{ questionId: QUESTION_ID, value: 'client answer' }],
    };
    const sending = handle.send(command);
    const resolution = await nextEvent(handle.events);
    expect(resolution).toMatchObject({
      type: 'question.resolved',
      requestId: REQUEST_ID,
      answers: [{ value: 'provider answer' }],
    });
    accepted.resolve();
    await sending;

    await handle.close();
    const remaining = await collectRemaining(handle.events);
    expect(
      [resolution, ...remaining].filter((event) => event.type === 'question.resolved'),
    ).toHaveLength(1);
  });

  it('fails once when a provider resolves an unknown interaction', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startActiveSession(transport, handle);
    transport.emit({
      type: 'approval.resolved',
      turnId: TURN_ID,
      requestId: REQUEST_ID,
      decision: 'denied',
      actor: 'policy',
    });

    const events = await collectRemaining(handle.events);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'approval.resolved' }));
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: 'session.failed', code: 'provider_correlation_error' }),
    ]);
  });

  it('rejects an unselected interaction provider-side without exposing it', async () => {
    const selection: CapabilitySelection = {
      ...SELECTION,
      enabled: SELECTION.enabled.filter((entry) => entry.id !== 'interaction.question'),
    };
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, { ...START_OPTIONS, selection });
    await startActiveSession(transport, handle, selection);

    transport.emit(questionRequest());

    expect(await nextEvent(handle.events)).toEqual({
      type: 'extension.summary',
      turnId: TURN_ID,
      extensionName: 'provider.interaction.question',
      summary: 'provider emitted an unselected question interaction; rejected before exposure',
      reason: 'capability_drift',
    });
    expect(transport.resolutions).toEqual([
      {
        kind: 'question',
        requestId: REQUEST_ID,
        turnId: TURN_ID,
        reason: 'overflow',
      },
    ]);
    expect(transport.closeCalls).toBe(0);

    await handle.interrupt();
    expect(await nextEvent(handle.events)).toMatchObject({ type: 'turn.interrupted' });
    expect(await nextEvent(handle.events)).toEqual({ type: 'session.status', status: 'idle' });
    await handle.close();
    const remaining = await collectRemaining(handle.events);
    expect(remaining).not.toContainEqual(expect.objectContaining({ requestId: REQUEST_ID }));
  });

  it('fails closed when an unselected interaction cannot be rejected provider-side', async () => {
    const selection: CapabilitySelection = {
      ...SELECTION,
      enabled: SELECTION.enabled.filter((entry) => entry.id !== 'interaction.question'),
    };
    const transport = new MemoryTransport({
      resolveInteraction: async () => {
        throw new Error('native rejection failed');
      },
    });
    const handle = await superviseInteractiveSession(transport, { ...START_OPTIONS, selection });
    await startActiveSession(transport, handle, selection);

    transport.emit(questionRequest());

    const events = await collectRemaining(handle.events);
    expect(events).not.toContainEqual(expect.objectContaining({ requestId: REQUEST_ID }));
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({
        type: 'session.failed',
        code: 'provider_capability_violation',
      }),
    ]);
  });

  it('atomically accepts provider-side question cancellation and rejects a later response', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startActiveSession(transport, handle);
    transport.emit(questionRequest());
    await nextEvent(handle.events);
    transport.emit({
      type: 'question.cancelled',
      turnId: TURN_ID,
      requestId: REQUEST_ID,
      reason: 'provider_cancelled',
    });
    expect(await nextEvent(handle.events)).toMatchObject({
      type: 'question.cancelled',
      requestId: REQUEST_ID,
      reason: 'provider_cancelled',
    });

    await expect(
      handle.send({
        type: 'question.respond',
        commandId: COMMAND_ID,
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        requestId: REQUEST_ID,
        answers: [{ questionId: QUESTION_ID, value: 'too late' }],
      }),
    ).rejects.toMatchObject({ code: 'stale_interaction' });
    expect(transport.sent).toHaveLength(0);

    await handle.close();
    await collectRemaining(handle.events);
  });

  it('resolves a timed-out question safely without forwarding a response', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS, {
      interactionTimeoutMs: 5,
    });
    await startActiveSession(transport, handle);
    transport.emit(questionRequest());

    expect(await nextEvent(handle.events)).toMatchObject({
      type: 'question.requested',
      requestId: REQUEST_ID,
    });
    expect(await nextEvent(handle.events)).toEqual({
      type: 'question.cancelled',
      turnId: TURN_ID,
      requestId: REQUEST_ID,
      reason: 'timeout',
    });
    expect(transport.sent).toHaveLength(0);
    expect(transport.resolutions).toEqual([
      {
        kind: 'question',
        requestId: REQUEST_ID,
        turnId: TURN_ID,
        reason: 'timeout',
      },
    ]);
    expect(transport.interruptCalls).toBe(1);

    await handle.close();
    await collectRemaining(handle.events);
  });

  it('does not interrupt after a timed-out question turn has already confirmed idle', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS, {
      interactionTimeoutMs: 10,
    });
    await startActiveSession(transport, handle);
    transport.emit(questionRequest());
    expect(await nextEvent(handle.events)).toMatchObject({ type: 'question.requested' });
    transport.emit({ type: 'turn.completed', turnId: TURN_ID });
    transport.emit({ type: 'session.status', status: 'idle' });
    expect(await nextEvent(handle.events)).toEqual({ type: 'turn.completed', turnId: TURN_ID });
    expect(await nextEvent(handle.events)).toEqual({ type: 'session.status', status: 'idle' });

    expect(await nextEvent(handle.events)).toMatchObject({
      type: 'question.cancelled',
      reason: 'timeout',
    });
    expect(transport.interruptCalls).toBe(0);

    await handle.close();
    await collectRemaining(handle.events);
  });

  it('resolves pending interactions before interrupt and does not close the session', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startActiveSession(transport, handle);
    transport.emit(questionRequest());
    await nextEvent(handle.events);

    await handle.interrupt();

    expect(await nextEvent(handle.events)).toEqual({
      type: 'question.cancelled',
      turnId: TURN_ID,
      requestId: REQUEST_ID,
      reason: 'interrupt',
    });
    expect(await nextEvent(handle.events)).toMatchObject({ type: 'turn.interrupted' });
    expect(await nextEvent(handle.events)).toEqual({ type: 'session.status', status: 'idle' });
    expect(transport.interruptCalls).toBe(1);
    expect(transport.closeCalls).toBe(0);
    expect(transport.resolutions).toEqual([
      {
        kind: 'question',
        requestId: REQUEST_ID,
        turnId: TURN_ID,
        reason: 'interrupt',
      },
    ]);
    expect(transport.actions.indexOf('resolve:interrupt')).toBeLessThan(
      transport.actions.indexOf('interrupt'),
    );

    await handle.close();
    await collectRemaining(handle.events);
  });

  it('resolves a pending question before failing a disconnected provider', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startActiveSession(transport, handle);
    transport.emit(questionRequest());
    await nextEvent(handle.events);

    transport.disconnect();
    const events = await collectRemaining(handle.events);

    expect(events.map((event) => event.type)).toEqual([
      'question.cancelled',
      'error',
      'session.failed',
    ]);
    expect(events[0]).toMatchObject({ reason: 'disconnect' });
    expect(events[1]).toMatchObject({ code: 'provider_disconnected' });
    expect(terminalEvents(events)).toHaveLength(1);
    expect(transport.resolutions).toEqual([]);
  });

  it('sends provider-native fail-closed resolutions before cancellation cleanup', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startActiveSession(transport, handle);
    transport.emit(questionRequest());
    await nextEvent(handle.events);

    await handle.close();
    const events = await collectRemaining(handle.events);

    expect(transport.resolutions).toEqual([
      {
        kind: 'question',
        requestId: REQUEST_ID,
        turnId: TURN_ID,
        reason: 'cancel',
      },
    ]);
    expect(transport.actions.indexOf('resolve:cancel')).toBeLessThan(
      transport.actions.indexOf('close'),
    );
    expect(events.map((event) => event.type)).toEqual(['question.cancelled', 'session.cancelled']);
  });

  it('denies the 33rd interaction provider-side and interrupts an overflowing question turn', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startActiveSession(transport, handle);
    for (let index = 0; index < 32; index += 1) {
      const requestId = testUuid(1_000 + index);
      transport.emit(questionRequest(requestId, testUuid(2_000 + index)));
      expect(await nextEvent(handle.events)).toMatchObject({
        type: 'question.requested',
        requestId,
      });
    }
    const overflowRequestId = testUuid(3_000);
    transport.emit(questionRequest(overflowRequestId, testUuid(4_000)));

    const cancellations: AgentEventV2[] = [];
    for (let index = 0; index < 33; index += 1) cancellations.push(await nextEvent(handle.events));
    expect(cancellations).toHaveLength(33);
    expect(cancellations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'question.cancelled',
          requestId: overflowRequestId,
          reason: 'overflow',
        }),
      ]),
    );
    expect(
      cancellations.every(
        (event) => event.type === 'question.cancelled' && event.reason === 'overflow',
      ),
    ).toBe(true);
    for (let attempt = 0; attempt < 20 && transport.interruptCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(transport.resolutions).toHaveLength(33);
    expect(transport.resolutions).toContainEqual(
      expect.objectContaining({
        kind: 'question',
        requestId: overflowRequestId,
        reason: 'overflow',
      }),
    );
    expect(transport.interruptCalls).toBe(1);

    await handle.close();
    await collectRemaining(handle.events);
  });

  it('enforces the frozen interaction payload bound before exposing a provider request', async () => {
    const transport = new MemoryTransport();
    const selection: CapabilitySelection = {
      ...SELECTION,
      enabled: SELECTION.enabled.map((entry) =>
        entry.id === 'interaction.question'
          ? {
              ...entry,
              constraints: { kind: 'interaction', timeoutMs: 300_000, maxPayloadBytes: 128 },
            }
          : entry,
      ),
    };
    const handle = await superviseInteractiveSession(transport, {
      ...START_OPTIONS,
      selection,
    });
    await startActiveSession(transport, handle, selection);
    transport.emit({
      ...questionRequest(),
      questions: [
        {
          id: QUESTION_ID,
          title: 'Question',
          prompt: 'x'.repeat(256),
          allowsFreeText: true,
        },
      ],
    });

    expect(await nextEvent(handle.events)).toMatchObject({
      type: 'question.cancelled',
      requestId: REQUEST_ID,
      reason: 'overflow',
    });
    expect(transport.resolutions).toEqual([
      {
        kind: 'question',
        requestId: REQUEST_ID,
        turnId: TURN_ID,
        reason: 'overflow',
      },
    ]);
    expect(transport.interruptCalls).toBe(1);

    await handle.close();
    await collectRemaining(handle.events);
  });

  it('cancels the session when an overflow interruption never confirms idle', async () => {
    const transport = new MemoryTransport({ interrupt: async () => undefined });
    const selection: CapabilitySelection = {
      ...SELECTION,
      enabled: SELECTION.enabled.map((entry) =>
        entry.id === 'interaction.question'
          ? {
              ...entry,
              constraints: { kind: 'interaction', timeoutMs: 300_000, maxPayloadBytes: 128 },
            }
          : entry,
      ),
    };
    const handle = await superviseInteractiveSession(
      transport,
      { ...START_OPTIONS, selection },
      { commandTimeoutMs: 5, closeTimeoutMs: 20 },
    );
    await startActiveSession(transport, handle, selection);
    transport.emit({
      ...questionRequest(),
      questions: [
        {
          id: QUESTION_ID,
          title: 'Question',
          prompt: 'x'.repeat(256),
          allowsFreeText: true,
        },
      ],
    });

    expect(await nextEvent(handle.events)).toMatchObject({
      type: 'question.cancelled',
      reason: 'overflow',
    });
    const remaining = await collectRemaining(handle.events);
    expect(terminalEvents(remaining)).toEqual([
      expect.objectContaining({ type: 'session.cancelled' }),
    ]);
    expect(transport.closeCalls).toBe(1);
  });

  it.each([
    ['malformed JSON', '{not-json', 'provider_frame_invalid'],
    ['an oversized frame', 'x'.repeat(1024 * 1024 + 1), 'provider_frame_too_large'],
  ])('fails once for %s', async (_label, frame, code) => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    transport.emit(frame);

    const events = await collectRemaining(handle.events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code }));
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: 'session.failed', code }),
    ]);
  });

  it('rejects an oversized parsed object before serializing it', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    transport.emit({
      type: 'session.status',
      status: 'active',
      padding: 'x'.repeat(2 * 1024 * 1024),
    });

    expect(terminalEvents(await collectRemaining(handle.events))).toEqual([
      expect.objectContaining({ type: 'session.failed', code: 'provider_frame_too_large' }),
    ]);
  });

  it('never invokes provider object serialization hooks while bounding a frame', async () => {
    const serialized = vi.fn();
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    transport.emit({ type: 'session.status', status: 'active', toJSON: serialized });

    expect(terminalEvents(await collectRemaining(handle.events))).toEqual([
      expect.objectContaining({ type: 'session.failed', code: 'provider_frame_invalid' }),
    ]);
    expect(serialized).not.toHaveBeenCalled();
  });

  it('accepts a bounded UTF-8 JSON byte frame', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    transport.emit(new TextEncoder().encode(JSON.stringify(sessionStarted())));

    expect(await nextEvent(handle.events)).toMatchObject({ type: 'session.started' });
    await handle.close();
    expect(terminalEvents(await collectRemaining(handle.events))).toHaveLength(1);
  });

  it('classifies a non-serializable undefined frame as provider_frame_invalid', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    transport.emit(undefined);

    const events = await collectRemaining(handle.events);
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: 'session.failed', code: 'provider_frame_invalid' }),
    ]);
  });

  it('classifies a normalized envelope over 1 MiB separately from its bounded native frame', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    transport.emit({
      type: 'session.status',
      status: 'active',
      padding: 'x'.repeat(1024 * 1024 - 100),
    });

    const events = await collectRemaining(handle.events);
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: 'session.failed', code: 'event_too_large' }),
    ]);
  });

  it('replaces oversized user-visible content with a typed truncation summary', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startActiveSession(transport, handle);
    const oversizedBlock = {
      type: 'text' as const,
      id: testUuid(5_000),
      text: 'x'.repeat(300 * 1024),
    };
    transport.emit({
      type: 'content.completed',
      turnId: TURN_ID,
      block: oversizedBlock,
    });

    expect(await nextEvent(handle.events)).toEqual({
      type: 'content.completed',
      turnId: TURN_ID,
      block: {
        type: 'provider_extension',
        id: oversizedBlock.id,
        extensionName: 'provider.content.completed',
        representation: 'safe_summary',
        safeSummary: 'provider content exceeded the 256 KiB content-block limit',
        reason: 'truncated',
        originalBytes: Buffer.byteLength(JSON.stringify(oversizedBlock)),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    await handle.close();
    await collectRemaining(handle.events);
  });

  it('caps cumulative deltas per stable content block and suppresses post-marker content', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startActiveSession(transport, handle);
    const contentBlockId = testUuid(5_001);
    const firstDelta = 'a'.repeat(200 * 1024);
    const oversizedDelta = 'b'.repeat(300 * 1024);
    transport.emit({
      type: 'content.delta',
      turnId: TURN_ID,
      contentBlockId,
      delta: firstDelta,
    });
    transport.emit({
      type: 'content.delta',
      turnId: TURN_ID,
      contentBlockId,
      delta: oversizedDelta,
    });

    expect(await nextEvent(handle.events)).toMatchObject({
      type: 'content.delta',
      contentBlockId,
    });
    expect(await nextEvent(handle.events)).toEqual({
      type: 'content.completed',
      turnId: TURN_ID,
      block: {
        type: 'provider_extension',
        id: contentBlockId,
        extensionName: 'provider.content.delta',
        representation: 'safe_summary',
        safeSummary: 'provider content exceeded the 256 KiB content-block limit',
        reason: 'truncated',
        originalBytes: 500 * 1024,
        sha256: createHash('sha256').update(firstDelta).update(oversizedDelta).digest('hex'),
      },
    });

    transport.emit({
      type: 'content.delta',
      turnId: TURN_ID,
      contentBlockId,
      delta: 'must be suppressed',
    });
    transport.emit({
      type: 'content.completed',
      turnId: TURN_ID,
      block: { type: 'text', id: contentBlockId, text: 'must also be suppressed' },
    });
    await handle.close();
    const remaining = await collectRemaining(handle.events);
    expect(remaining).toEqual([expect.objectContaining({ type: 'session.cancelled' })]);
  });

  it('turns an event-stream crash into one terminal provider_crash failure', async () => {
    async function* crashingEvents(): AsyncGenerator<unknown, void, void> {
      yield sessionStarted();
      yield { type: 'session.status', status: 'active' };
      yield { type: 'turn.started', turnId: TURN_ID };
      throw new Error('transport exploded');
    }
    const transport = new MemoryTransport({ events: crashingEvents() });
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);

    const events = await collectRemaining(handle.events);
    expect(events.map((event) => event.type)).toEqual([
      'session.started',
      'session.status',
      'turn.started',
      'error',
      'session.failed',
    ]);
    expect(events[3]).toMatchObject({ type: 'error', code: 'provider_crash' });
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({ type: 'session.failed', code: 'provider_crash' }),
    ]);
  });

  it('bounds provider crash diagnostics before emitting terminal events', async () => {
    async function* crashingEvents(): AsyncGenerator<unknown, void, void> {
      yield* [];
      throw new Error('x'.repeat(2 * 1024 * 1024));
    }
    const transport = new MemoryTransport({ events: crashingEvents() });
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);

    const events = await collectRemaining(handle.events);
    const failure = events.find((event) => event.type === 'session.failed');
    expect(failure?.type).toBe('session.failed');
    if (failure?.type === 'session.failed') {
      expect(Buffer.byteLength(failure.message)).toBeLessThanOrEqual(4 * 1024);
    }
    expect(terminalEvents(events)).toHaveLength(1);
  });

  it.each([
    {
      label: '5,000-event provider queue',
      count: 5_001,
      event: (_index: number): AgentEventV2 => ({ type: 'session.status', status: 'active' }),
    },
    {
      label: '16 MiB provider queue',
      count: 70,
      event: (index: number): AgentEventV2 => ({
        type: 'content.completed',
        turnId: TURN_ID,
        block: {
          type: 'text',
          id: `123e4567-e89b-42d3-a456-${index.toString(16).padStart(12, '0')}`,
          text: 'x'.repeat(250 * 1024),
        },
      }),
    },
  ])(
    'fails once when the $label is corrupted',
    async ({ count, event }) => {
      const transport = new MemoryTransport();
      const handle = await superviseInteractiveSession(transport, START_OPTIONS);
      await startActiveSession(transport, handle);
      for (let index = 0; index < count; index += 1) transport.emit(event(index));
      for (let attempt = 0; attempt < 200 && transport.closeCalls === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const events = await collectRemaining(handle.events);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'error', code: 'provider_queue_overflow' }),
      );
      expect(terminalEvents(events)).toEqual([
        expect.objectContaining({ type: 'session.failed', code: 'provider_queue_overflow' }),
      ]);
      expect(transport.closeCalls).toBe(1);
    },
    15_000,
  );

  it('retains a pending interaction resolution when provider queue overflow is terminal', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startActiveSession(transport, handle);
    transport.emit(questionRequest());
    expect(await nextEvent(handle.events)).toMatchObject({
      type: 'question.requested',
      requestId: REQUEST_ID,
    });

    for (let index = 0; index <= 5_000; index += 1) {
      transport.emit({ type: 'session.status', status: 'active' });
    }
    for (let attempt = 0; attempt < 200 && transport.closeCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const events = await collectRemaining(handle.events);
    expect(events.filter((event) => event.type === 'question.cancelled')).toEqual([
      {
        type: 'question.cancelled',
        turnId: TURN_ID,
        requestId: REQUEST_ID,
        reason: 'disconnect',
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'session.failed',
      code: 'provider_queue_overflow',
    });
  }, 15_000);

  it('publishes only the first provider terminal event and rejects later commands', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);
    await startActiveSession(transport, handle);
    transport.emit({ type: 'turn.completed', turnId: TURN_ID });
    transport.emit({ type: 'session.status', status: 'idle' });
    expect(await nextEvent(handle.events)).toEqual({ type: 'turn.completed', turnId: TURN_ID });
    expect(await nextEvent(handle.events)).toEqual({ type: 'session.status', status: 'idle' });
    transport.emit({ type: 'session.completed' });
    transport.emit({ type: 'session.failed', code: 'late', message: 'must not escape' });

    const events = await collectRemaining(handle.events);
    expect(terminalEvents(events)).toEqual([{ type: 'session.completed' }]);
    await expect(handle.send(FOLLOW_UP)).rejects.toEqual(
      expect.objectContaining<Partial<InteractiveSessionError>>({
        name: 'InteractiveSessionError',
        code: 'session_terminal',
      }),
    );
    await expect(handle.interrupt()).rejects.toMatchObject({ code: 'session_terminal' });
  });

  it('makes concurrent close calls idempotent and emits one cancellation terminal', async () => {
    const transport = new MemoryTransport();
    const handle = await superviseInteractiveSession(transport, START_OPTIONS);

    await Promise.all([handle.close(), handle.close(), handle.close()]);
    const events = await collectRemaining(handle.events);

    expect(transport.closeCalls).toBe(1);
    expect(terminalEvents(events)).toEqual([
      { type: 'session.cancelled', reason: 'session closed' },
    ]);
  });

  it('blocks dispatch immediately while graceful teardown is still pending', async () => {
    const closeGate = deferred<void>();
    const transport = new MemoryTransport({ close: () => closeGate.promise });
    const handle = await superviseInteractiveSession(transport, START_OPTIONS, {
      closeTimeoutMs: 100,
    });

    const closing = handle.close();
    await expect(handle.send(FOLLOW_UP)).rejects.toMatchObject({ code: 'session_terminal' });
    await expect(handle.interrupt()).rejects.toMatchObject({ code: 'session_terminal' });
    expect(transport.sent).toHaveLength(0);
    expect(transport.interruptCalls).toBe(0);

    closeGate.resolve();
    await closing;
    expect(terminalEvents(await collectRemaining(handle.events))).toHaveLength(1);
  });

  it('uses forceClose after the graceful close deadline and still terminates once', async () => {
    const transport = new MemoryTransport({
      close: () => new Promise<void>(() => undefined),
      forceClose: async () => undefined,
    });
    const handle = await superviseInteractiveSession(transport, START_OPTIONS, {
      closeTimeoutMs: 5,
    });

    await handle.close();
    const events = await collectRemaining(handle.events);

    expect(transport.closeCalls).toBe(1);
    expect(transport.forceCloseCalls).toBe(1);
    expect(terminalEvents(events)).toHaveLength(1);
  });

  it('fails instead of claiming cancellation when hard-stop cannot confirm tree reaping', async () => {
    const transport = new MemoryTransport({
      close: () => new Promise<void>(() => undefined),
      forceClose: async () => {
        throw new Error('kill failed');
      },
    });
    const handle = await superviseInteractiveSession(transport, START_OPTIONS, {
      closeTimeoutMs: 5,
    });

    await handle.close();
    const events = await collectRemaining(handle.events);
    expect(terminalEvents(events)).toEqual([
      expect.objectContaining({
        type: 'session.failed',
        code: 'provider_force_close_failed',
      }),
    ]);
    expect(transport.forceCloseCalls).toBe(1);
  });
});
