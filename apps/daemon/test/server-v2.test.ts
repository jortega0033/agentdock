import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  FAKE_PROVIDER_CAPABILITIES,
  FakeProvider,
  ProviderRegistry,
  noopLogger,
  type AgentProvider,
  type ProviderSessionHandle,
  type StartSessionOptions,
} from '@agent-dock/agent-runtime';
import {
  AGENT_DOCK_PROTOCOL_VERSION,
  AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS,
  agentEventV2EnvelopeSchema,
  agentSessionV2Schema,
  providerStatusV2Schema,
  providersV2ResponseSchema,
  type AgentEvent,
  type ProviderStatus,
} from '@agent-dock/shared';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';

const TOKEN = 'test-token-v2';

class ObservationProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly name = 'Observation Provider';
  readonly status: ProviderStatus = {
    id: this.id,
    name: this.name,
    installed: true,
    authenticated: 'authenticated',
    version: '1.2.3',
    capabilities: { cancellation: true, tools: true, usage: true, thinking: true, resume: false },
  };

  async detect(): Promise<ProviderStatus> {
    return this.status;
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    async function* events(): AsyncGenerator<AgentEvent, void, void> {
      yield { type: 'session.started', sessionId: options.sessionId, provider: 'claude' };
      yield { type: 'status', status: 'provider_native_running' };
      yield { type: 'thinking.delta', text: 'public but uncorrelated reasoning' };
      yield { type: 'tool.started', toolName: 'write_file', toolCallId: 'native-call-1' };
      yield { type: 'tool.completed', toolName: 'write_file', toolCallId: 'native-call-1' };
      yield { type: 'usage', inputTokens: 10, outputTokens: 5, cost: 0.01 };
      yield { type: 'session.completed' };
    }
    return { events: events(), cancel: async () => undefined };
  }
}

class ReplayOverflowProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly name = 'Replay Overflow Provider';

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: true,
      authenticated: 'authenticated',
      capabilities: { ...FAKE_PROVIDER_CAPABILITIES },
    };
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    async function* events(): AsyncGenerator<AgentEvent, void, void> {
      yield { type: 'session.started', sessionId: options.sessionId, provider: 'claude' };
      for (let index = 0; index < 5_005; index += 1) {
        yield { type: 'assistant.message', text: `message ${index}` };
      }
      yield { type: 'session.completed' };
    }
    return { events: events(), cancel: async () => undefined };
  }
}

function setup(scenario: 'success' | 'failure' | 'hang-until-cancelled' = 'success') {
  const registry = new ProviderRegistry();
  const provider = new FakeProvider(
    'claude',
    {
      id: 'claude',
      name: 'Claude Code',
      installed: true,
      authenticated: 'authenticated',
      capabilities: FAKE_PROVIDER_CAPABILITIES,
      version: '1.2.3',
    },
    scenario,
  );
  registry.register(provider);
  const sessionManager = new SessionManager(registry, noopLogger);
  const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });
  return { app, provider, sessionManager };
}

function setupInteractive(
  scenario:
    | 'multi-input'
    | 'approval'
    | 'question'
    | 'disconnect'
    | 'queue-overflow'
    | 'malformed-frame'
    | 'oversized-frame'
    | 'crash' = 'multi-input',
) {
  const registry = new ProviderRegistry();
  const provider = new FakeProvider('claude', undefined, 'success', scenario);
  registry.register(provider);
  const sessionManager = new SessionManager(registry, noopLogger);
  const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });
  return { app, provider, sessionManager };
}

function auth() {
  return { authorization: `Bearer ${TOKEN}` };
}

async function createInteractiveSession(app: FastifyInstance, required: string[]) {
  const response = await app.inject({
    method: 'POST',
    url: '/v2/sessions',
    headers: auth(),
    payload: {
      provider: 'claude',
      cwd,
      prompt: 'initial interactive turn',
      capabilities: {
        required: required.map((id) => ({ id })),
        optional: [],
        allowExperimental: false,
      },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return agentSessionV2Schema.parse(response.json());
}

function parseSseData(payload: string): unknown[] {
  return payload
    .split('\n\n')
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => !!line)
    .map((line) => JSON.parse(line.slice('data: '.length)) as unknown);
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-daemon-v2-test-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('v2 discovery and authorization', () => {
  it('keeps the v1 scalar and advertises every supported protocol version', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: AGENT_DOCK_PROTOCOL_VERSION,
      supportedProtocolVersions: AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS,
    });
    expect(response.json().protocolVersion).toBe(1);
  });

  it('protects v2 routes with the same bearer and Origin checks as v1', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/v2/providers' })).statusCode).toBe(401);

    const originResponse = await app.inject({
      method: 'GET',
      url: '/v2/providers',
      headers: { ...auth(), origin: 'https://example.invalid' },
    });
    expect(originResponse.statusCode).toBe(403);
    expect(originResponse.json().code).toBe('browser_origin_forbidden');
  });

  it('reports a conservative, schema-valid legacy one-shot manifest', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: '/v2/providers', headers: auth() });
    const parsed = providersV2ResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0]?.transports).toEqual([
      expect.objectContaining({
        id: 'legacy-one-shot',
        stability: 'stable',
        effectsComplete: false,
      }),
    ]);
    expect(parsed.providers[0]?.capabilities.map((record) => record.id)).not.toContain(
      'content.usage.cost',
    );
    expect(
      parsed.providers[0]?.capabilities.find((record) => record.id === 'session.cancel')?.owner,
    ).toBe('agentdock');
    expect(
      parsed.providers[0]?.capabilities.every((record) => record.scope.trustState === 'untrusted'),
    ).toBe(true);
    expect(
      parsed.providers[0]?.capabilities.find((record) => record.id === 'content.thinking')?.support,
    ).toBe('unsupported');
  });

  it('uses a provider-owned v2 manifest when the provider exposes one', async () => {
    const registry = new ProviderRegistry();
    registry.register(new FakeProvider('claude', undefined, 'success', 'multi-input'));
    const sessionManager = new SessionManager(registry, noopLogger);
    const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });

    const response = await app.inject({ method: 'GET', url: '/v2/providers', headers: auth() });
    const parsed = providersV2ResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(parsed.providers[0]?.transports.map((transport) => transport.id)).toEqual([
      'fake-interactive',
    ]);
    expect(parsed.providers[0]?.capabilities.map((record) => record.id)).toContain(
      'session.input.follow_up',
    );
  });

  it('gets one provider and preserves invalid/unregistered status behavior under /v2', async () => {
    const { app } = setup();
    const found = await app.inject({ method: 'GET', url: '/v2/providers/claude', headers: auth() });
    expect(found.statusCode).toBe(200);
    expect(() => providerStatusV2Schema.parse(found.json())).not.toThrow();

    expect(
      (await app.inject({ method: 'GET', url: '/v2/providers/not-a-provider', headers: auth() }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/v2/providers/codex', headers: auth() })).statusCode,
    ).toBe(404);
  });
});

describe('POST /v2/sessions capability negotiation', () => {
  it('does not start a provider when the client disconnects during detection', async () => {
    const { app, provider } = setupInteractive();
    const status = await provider.detect();
    let enterDetection!: () => void;
    const detectionEntered = new Promise<void>((resolve) => {
      enterDetection = resolve;
    });
    let releaseDetection!: (value: ProviderStatus) => void;
    vi.spyOn(provider, 'detect').mockImplementation(
      () =>
        new Promise<ProviderStatus>((resolve) => {
          releaseDetection = resolve;
          enterDetection();
        }),
    );
    let rawRequest: { emit(event: string): boolean } | undefined;
    app.addHook('onRequest', (request, _reply, done) => {
      if (request.url === '/v2/sessions') rawRequest = request.raw;
      done();
    });
    const response = app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'must not start' },
    });
    await detectionEntered;

    expect(rawRequest).toBeDefined();
    rawRequest?.emit('aborted');
    await response;
    releaseDetection(status);

    expect(provider.interactiveStartedOptions).toEqual([]);
  });

  it('uses the default one-shot request and returns an immutable, schema-valid selection', async () => {
    const { app, provider } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'hello v2' },
    });

    expect(created.statusCode).toBe(201);
    const snapshot = agentSessionV2Schema.parse(created.json());
    expect(snapshot.transport).toBe('legacy-one-shot');
    expect(snapshot.selection.transport).toBe('legacy-one-shot');
    expect(snapshot.selection.enabled.map((entry) => entry.id)).toContain('session.cancel');
    expect(snapshot.acceptedWork).toBe('unknown');
    expect(snapshot.earliestSequence).toBe(0);
    expect(provider.startedOptions).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const fetched = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${snapshot.id}`,
      headers: auth(),
    });
    const later = agentSessionV2Schema.parse(fetched.json());
    expect(later.selection).toEqual(snapshot.selection);
    expect(later.executionId).toBe(snapshot.executionId);
    expect(later.currentTurnId).toBe(snapshot.currentTurnId);
  });

  it('does not replace an explicitly empty capability request with the default', async () => {
    const { app, sessionManager } = setup('hang-until-cancelled');
    const created = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: {
        provider: 'claude',
        cwd,
        prompt: 'no optional operations',
        capabilities: { required: [], optional: [], allowExperimental: false },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const session = agentSessionV2Schema.parse(created.json());
    expect(session.selection.enabled).toEqual([]);

    const cancel = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/cancel`,
      headers: auth(),
    });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().code).toBe('capability_not_selected');
    await sessionManager.cancel(session.id);
  });

  it('returns 422 for an unavailable required capability before starting a provider', async () => {
    const { app, provider } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: {
        provider: 'claude',
        cwd,
        prompt: 'must not start',
        capabilities: {
          required: [{ id: 'interaction.approval' }],
          optional: [],
          allowExperimental: false,
        },
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('required_capability_unavailable');
    expect(response.json().details.unavailableRequired).toEqual([
      expect.objectContaining({ id: 'interaction.approval' }),
    ]);
    expect(provider.startedOptions).toEqual([]);
  });

  it('round-trips an unknown optional opaque request as unavailable without blocking startup', async () => {
    const { app, provider } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: {
        provider: 'claude',
        cwd,
        prompt: 'optional extension',
        capabilities: {
          required: [],
          optional: [
            { id: 'ext.example.future', constraints: { kind: 'opaque', value: { mode: 'safe' } } },
          ],
          allowExperimental: false,
        },
      },
    });

    expect(response.statusCode).toBe(201);
    const session = agentSessionV2Schema.parse(response.json());
    expect(session.selection.unavailableOptional).toEqual([
      expect.objectContaining({ id: 'ext.example.future' }),
    ]);
    expect(provider.startedOptions).toHaveLength(1);
  });

  it('uses 400 for malformed input and 413 for a prompt over the fixed cap', async () => {
    const { app, provider } = setup();
    const invalid = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('invalid_request');

    const oversized = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'x'.repeat(200_001) },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().code).toBe('payload_too_large');
    expect(provider.startedOptions).toEqual([]);
  });

  it('rate-limits session creation before filesystem or provider work', async () => {
    const { app, provider } = setup();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const unauthorized = await app.inject({
        method: 'POST',
        url: '/v2/sessions',
        payload: { provider: 'claude', cwd },
      });
      expect(unauthorized.statusCode).toBe(401);
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v2/sessions',
        headers: auth(),
        payload: { provider: 'claude', cwd },
      });
      expect(response.statusCode).toBe(400);
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate limit exceeded', code: 'rate_limited' });
    expect(limited.headers['retry-after']).toBeDefined();
    expect(provider.startedOptions).toEqual([]);
  });
});

describe('interactive v2 command dispatch', () => {
  it('enforces the frozen command constraints before provider dispatch', async () => {
    const { app, provider } = setupInteractive();
    const created = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: {
        provider: 'claude',
        cwd,
        prompt: 'initial interactive turn',
        capabilities: {
          required: [
            {
              id: 'session.input.follow_up',
              constraints: {
                kind: 'text_input',
                maxCharacters: 4,
                attachmentKinds: [],
              },
            },
            { id: 'session.cancel' },
          ],
          optional: [],
          allowExperimental: false,
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const session = agentSessionV2Schema.parse(created.json());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const response = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: auth(),
      payload: {
        type: 'input.follow_up',
        commandId: randomUUID(),
        sessionId: session.id,
        turnId: randomUUID(),
        content: [{ type: 'text', id: randomUUID(), text: '12345' }],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('command_out_of_bounds');
    expect(provider.interactiveCommands).toHaveLength(0);
    await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/cancel`,
      headers: auth(),
    });
  });

  it('starts the rich transport and deduplicates a byte-equivalent command retry', async () => {
    const { app, provider } = setupInteractive();
    const session = await createInteractiveSession(app, [
      'session.input.follow_up',
      'session.cancel',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const snapshot = agentSessionV2Schema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/v2/sessions/${session.id}`,
          headers: auth(),
        })
      ).json(),
    );
    expect(snapshot.transport).toBe('fake-interactive');
    expect(snapshot.status).toBe('idle');
    expect(snapshot.acceptedWork).toBe('accepted');
    expect(provider.interactiveStartedOptions).toHaveLength(1);
    expect(provider.startedOptions).toHaveLength(0);

    const command = {
      type: 'input.follow_up' as const,
      commandId: randomUUID(),
      sessionId: session.id,
      turnId: randomUUID(),
      content: [{ type: 'text' as const, id: randomUUID(), text: 'second turn' }],
    };
    const accepted = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: auth(),
      payload: command,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({
      status: 'accepted',
      commandId: command.commandId,
      sessionId: session.id,
      turnId: command.turnId,
    });

    const retry = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: auth(),
      payload: command,
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual(accepted.json());
    expect(provider.interactiveCommands).toHaveLength(1);

    const conflict = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: auth(),
      payload: {
        ...command,
        content: [{ type: 'text', id: randomUUID(), text: 'conflicting retry' }],
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('command_id_conflict');
    await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/cancel`,
      headers: auth(),
    });
  });

  it('keeps interrupt distinct from cancellation and resolves pending approval first', async () => {
    const { app, provider } = setupInteractive('approval');
    const session = await createInteractiveSession(app, [
      'session.interrupt',
      'session.cancel',
      'interaction.approval',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const interruptCommand = {
      type: 'session.interrupt' as const,
      commandId: randomUUID(),
      sessionId: session.id,
      turnId: session.currentTurnId as string,
    };
    const interrupted = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: auth(),
      payload: interruptCommand,
    });
    expect(interrupted.statusCode).toBe(202);
    expect(provider.interactiveInterrupts).toBe(1);
    expect(provider.interactiveCloses).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const retryAfterStateChange = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: auth(),
      payload: interruptCommand,
    });
    expect(retryAfterStateChange.statusCode).toBe(202);
    expect(retryAfterStateChange.json()).toEqual(interrupted.json());
    expect(provider.interactiveInterrupts).toBe(1);

    await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/cancel`,
      headers: auth(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const retryAfterTerminal = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: auth(),
      payload: interruptCommand,
    });
    expect(retryAfterTerminal.statusCode).toBe(202);
    expect(provider.interactiveInterrupts).toBe(1);
    const stream = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: auth(),
    });
    const events = parseSseData(stream.body) as Array<{ type: string; [key: string]: unknown }>;
    const resolutionIndex = events.findIndex((event) => event.type === 'approval.resolved');
    const interruptIndex = events.findIndex((event) => event.type === 'turn.interrupted');
    expect(resolutionIndex).toBeGreaterThanOrEqual(0);
    expect(interruptIndex).toBeGreaterThan(resolutionIndex);
    expect(events[resolutionIndex]).toMatchObject({ decision: 'denied', actor: 'policy' });
    expect(events.at(-1)?.type).toBe('session.cancelled');
  });

  it('correlates one approval response and rejects a later stale response', async () => {
    const { app, provider } = setupInteractive('approval');
    const session = await createInteractiveSession(app, ['interaction.approval', 'session.cancel']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(provider.lastInteractionRequestId).toBeDefined();
    const responseCommand = {
      type: 'approval.respond' as const,
      commandId: randomUUID(),
      sessionId: session.id,
      turnId: session.currentTurnId as string,
      requestId: provider.lastInteractionRequestId as string,
      decision: 'allow_once' as const,
    };

    const accepted = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: auth(),
      payload: responseCommand,
    });
    expect(accepted.statusCode).toBe(202);
    const retry = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: auth(),
      payload: responseCommand,
    });
    expect(retry.statusCode).toBe(202);
    expect(provider.interactiveCommands).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const stale = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: auth(),
      payload: { ...responseCommand, commandId: randomUUID() },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('stale_interaction');
    await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/cancel`,
      headers: auth(),
    });
  });

  it('rejects commands for a legacy or unselected session capability', async () => {
    const { app } = setup('hang-until-cancelled');
    const created = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'legacy' },
    });
    const session = agentSessionV2Schema.parse(created.json());
    const response = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: auth(),
      payload: {
        type: 'input.follow_up',
        commandId: randomUUID(),
        sessionId: session.id,
        turnId: randomUUID(),
        content: [{ type: 'text', id: randomUUID(), text: 'must not dispatch' }],
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('session_not_capable');
  });

  it.each([
    ['malformed-frame', 'provider_frame_invalid'],
    ['oversized-frame', 'provider_frame_too_large'],
    ['crash', 'provider_crash'],
  ] as const)('fails %s once with a bounded terminal event', async (scenario, code) => {
    const { app } = setupInteractive(scenario);
    const session = await createInteractiveSession(app, ['session.cancel']);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const stream = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: auth(),
    });
    const events = parseSseData(stream.body) as Array<{ type: string; code?: string }>;
    const terminal = events.filter((event) =>
      ['session.completed', 'session.failed', 'session.cancelled', 'session.interrupted'].includes(
        event.type,
      ),
    );
    expect(terminal).toEqual([expect.objectContaining({ type: 'session.failed', code })]);
  });

  it('fails a corrupted fake-provider queue once and preserves replay-gap semantics', async () => {
    const { app } = setupInteractive('queue-overflow');
    const session = await createInteractiveSession(app, ['session.cancel']);
    let snapshot = session;
    for (let attempt = 0; attempt < 200 && snapshot.status !== 'failed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const response = await app.inject({
        method: 'GET',
        url: `/v2/sessions/${session.id}`,
        headers: auth(),
      });
      snapshot = agentSessionV2Schema.parse(response.json());
    }
    expect(snapshot.status).toBe('failed');
    expect(snapshot.earliestSequence).toBeGreaterThan(0);

    const stale = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: auth(),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('replay_gap');

    const replay = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: {
        ...auth(),
        'last-event-id': String(snapshot.earliestSequence - 1),
      },
    });
    const events = parseSseData(replay.body) as Array<{ type: string; code?: string }>;
    expect(
      events.filter((event) =>
        [
          'session.completed',
          'session.failed',
          'session.cancelled',
          'session.interrupted',
        ].includes(event.type),
      ),
    ).toEqual([
      expect.objectContaining({ type: 'session.failed', code: 'provider_queue_overflow' }),
    ]);
  }, 15_000);

  it('resolves a pending question before failing a disconnected provider', async () => {
    const { app } = setupInteractive('disconnect');
    const session = await createInteractiveSession(app, ['interaction.question', 'session.cancel']);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const stream = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: auth(),
    });
    const events = parseSseData(stream.body) as Array<{ type: string; [key: string]: unknown }>;
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'question.cancelled', reason: 'disconnect' }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'session.failed', code: 'provider_disconnected' });
    expect(
      events.filter((event) =>
        [
          'session.completed',
          'session.failed',
          'session.cancelled',
          'session.interrupted',
        ].includes(event.type),
      ),
    ).toHaveLength(1);
  });
});

describe('v2 event, cancellation, and deletion routes', () => {
  it('keeps v1 and v2 session ownership isolated at every id-addressed route', async () => {
    const { app, sessionManager } = setup('hang-until-cancelled');
    const createdV2 = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'private v2 session' },
    });
    const v2Session = agentSessionV2Schema.parse(createdV2.json());

    for (const request of [
      { method: 'GET', url: `/sessions/${v2Session.id}` },
      { method: 'GET', url: `/sessions/${v2Session.id}/events` },
      { method: 'POST', url: `/sessions/${v2Session.id}/cancel` },
      { method: 'DELETE', url: `/sessions/${v2Session.id}` },
    ] as const) {
      const response = await app.inject({ ...request, headers: auth() });
      expect(response.statusCode).toBe(404);
    }

    const createdV1 = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'private v1 session' },
    });
    const v1Session = createdV1.json<{ id: string }>();
    for (const request of [
      { method: 'GET', url: `/v2/sessions/${v1Session.id}` },
      { method: 'GET', url: `/v2/sessions/${v1Session.id}/events` },
      { method: 'POST', url: `/v2/sessions/${v1Session.id}/cancel` },
      { method: 'DELETE', url: `/v2/sessions/${v1Session.id}` },
    ] as const) {
      const response = await app.inject({ ...request, headers: auth() });
      expect(response.statusCode).toBe(404);
    }

    expect(
      (await app.inject({ method: 'POST', url: '/sessions/cancel-all', headers: auth() }))
        .statusCode,
    ).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v2/sessions/${v2Session.id}/cancel`,
          headers: auth(),
        })
      ).statusCode,
    ).toBe(202);
    await sessionManager.cancelAll();
  });

  it('streams only schema-valid normalized v2 event kinds and closes on the terminal event', async () => {
    const { app } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'stream me' },
    });
    const session = agentSessionV2Schema.parse(created.json());
    await new Promise((resolve) => setTimeout(resolve, 30));

    const response = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: auth(),
    });
    const events = parseSseData(response.payload).map((event) =>
      agentEventV2EnvelopeSchema.parse(event),
    );

    expect(response.statusCode).toBe(200);
    expect(events.map((event) => event.type)).toEqual([
      'session.started',
      'session.status',
      'content.completed',
      'usage.tokens',
      'session.completed',
    ]);
    expect(events.every((event) => event.sessionId === session.id)).toBe(true);
    expect(events.every((event) => event.executionId === session.executionId)).toBe(true);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(events.some((event) => event.type === ('thread.started' as string))).toBe(false);
  });

  it('keeps generated IDs stable on replay, closes an empty terminal suffix, and rejects unsafe Last-Event-ID', async () => {
    const { app } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'resume safely' },
    });
    const session = agentSessionV2Schema.parse(created.json());
    await new Promise((resolve) => setTimeout(resolve, 30));

    const full = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: auth(),
    });
    const fullEvents = parseSseData(full.payload).map((event) =>
      agentEventV2EnvelopeSchema.parse(event),
    );
    const originalContent = fullEvents.find((event) => event.type === 'content.completed');
    expect(originalContent?.type).toBe('content.completed');

    const resumed = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: { ...auth(), 'last-event-id': '1' },
    });
    const resumedEvents = parseSseData(resumed.payload).map((event) =>
      agentEventV2EnvelopeSchema.parse(event),
    );
    const replayedContent = resumedEvents.find((event) => event.type === 'content.completed');
    expect(replayedContent?.type).toBe('content.completed');
    if (
      originalContent?.type === 'content.completed' &&
      replayedContent?.type === 'content.completed'
    ) {
      expect(replayedContent.block.id).toBe(originalContent.block.id);
    }

    const noNewEvents = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: { ...auth(), 'last-event-id': '4' },
    });
    expect(noNewEvents.statusCode).toBe(200);
    expect(parseSseData(noNewEvents.payload)).toEqual([]);

    const unsafe = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: { ...auth(), 'last-event-id': String(Number.MAX_SAFE_INTEGER) },
    });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().code).toBe('invalid_last_event_id');
  });

  it('summarizes uncorrelatable or constraint-drifting legacy observations instead of inventing core events', async () => {
    const registry = new ProviderRegistry();
    registry.register(new ObservationProvider());
    const sessionManager = new SessionManager(registry, noopLogger);
    const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });
    const created = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'observe safely' },
    });
    const session = agentSessionV2Schema.parse(created.json());
    const selectedTools = session.selection.enabled.find((entry) => entry.id === 'content.tools');
    expect(selectedTools?.constraints).toEqual({ kind: 'effects', allowedEffects: ['read'] });
    expect(session.selection.enabled.some((entry) => entry.id === 'content.thinking')).toBe(false);
    expect(session.selection.enabled.some((entry) => entry.id === 'content.streaming')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const response = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: auth(),
    });
    const events = parseSseData(response.payload).map((event) =>
      agentEventV2EnvelopeSchema.parse(event),
    );
    const summaries = events.filter((event) => event.type === 'extension.summary');

    expect(summaries.map((event) => event.extensionName)).toEqual([
      'legacy.thinking',
      'legacy.tool.started',
      'legacy.tool.completed',
      'legacy.usage.cost',
    ]);
    expect(events.some((event) => event.type === 'content.delta')).toBe(false);
    expect(
      events.some((event) => event.type === 'tool.started' || event.type === 'tool.completed'),
    ).toBe(false);
    expect(events.some((event) => event.type === 'usage.tokens')).toBe(true);
    expect(events.some((event) => event.type === 'usage.cost')).toBe(false);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index));
  });

  it('reports the sliding replay window and rejects a stale Last-Event-ID with replay_gap', async () => {
    const registry = new ProviderRegistry();
    registry.register(new ReplayOverflowProvider());
    const sessionManager = new SessionManager(registry, noopLogger);
    const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });
    const created = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'overflow replay' },
    });
    const session = agentSessionV2Schema.parse(created.json());

    let snapshot = session;
    for (let attempt = 0; attempt < 100 && snapshot.status !== 'completed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const fetched = await app.inject({
        method: 'GET',
        url: `/v2/sessions/${session.id}`,
        headers: auth(),
      });
      snapshot = agentSessionV2Schema.parse(fetched.json());
    }
    expect(snapshot.status).toBe('completed');
    expect(snapshot.earliestSequence).toBeGreaterThan(0);

    const response = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: { ...auth(), 'last-event-id': '0' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'replay_gap',
      details: { earliestSequence: snapshot.earliestSequence },
    });
  }, 15_000);

  it('returns the strict cancellation acknowledgement and 404s terminal cancellation', async () => {
    const { app } = setup('hang-until-cancelled');
    const created = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'cancel me' },
    });
    const session = agentSessionV2Schema.parse(created.json());

    const cancel = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/cancel`,
      headers: auth(),
    });
    expect(cancel.statusCode).toBe(202);
    expect(cancel.json()).toEqual({ status: 'cancelling', sessionId: session.id });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v2/sessions/${session.id}/cancel`,
          headers: auth(),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('deletes a terminal v2 session without exposing it through either v2 read route', async () => {
    const { app } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'delete me' },
    });
    const session = agentSessionV2Schema.parse(created.json());
    await new Promise((resolve) => setTimeout(resolve, 30));

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v2/sessions/${session.id}`,
      headers: auth(),
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}`, headers: auth() }))
        .statusCode,
    ).toBe(404);
  });
});
