import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import {
  FAKE_PROVIDER_CAPABILITIES,
  FAKE_INTERACTIVE_COMPATIBILITY,
  CLAUDE_LEGACY_COMPATIBILITY,
  FakeProvider,
  ProviderTransportStartupError,
  ProviderRegistry,
  noopLogger,
  type AgentProvider,
  type Logger,
  type ProviderDetectionOptions,
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
  sessionEventHistoryV2PageSchema,
  sessionListV2PageSchema,
  type AgentEvent,
  type AgentEventV2,
  type AgentSessionV2,
  type CapabilitySupportRecord,
  type ProviderStatus,
} from '@agent-dock/shared';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { SessionAdmissionController } from '../src/session-admission.js';
import { resolveWorkspaceIdentity } from '../src/workspace-identity.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';
import { FileExecutionGraphStore } from '../src/execution-graph-store.js';

const TOKEN = 'test-token-v2';

class ObservationProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly name = 'Observation Provider';
  readonly status: ProviderStatus = {
    id: this.id,
    name: this.name,
    installed: true,
    authenticated: 'authenticated',
    version: CLAUDE_LEGACY_COMPATIBILITY.providerVersion,
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
      version: CLAUDE_LEGACY_COMPATIBILITY.providerVersion,
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

class UnknownCodexProvider implements AgentProvider {
  readonly id = 'codex' as const;
  readonly name = 'Unknown-version Codex fixture';
  readonly startedOptions: StartSessionOptions[] = [];
  detectCalls = 0;
  readonly detectionOptions: Array<ProviderDetectionOptions | undefined> = [];
  redetectedStatus?: ProviderStatus;

  constructor(
    readonly status: ProviderStatus,
    private readonly trustedScopeEvidence?: Pick<
      ProviderStatus,
      'accountFingerprint' | 'selectedModel'
    >,
  ) {}

  async detect(options?: ProviderDetectionOptions): Promise<ProviderStatus> {
    this.detectCalls += 1;
    this.detectionOptions.push(options);
    const status =
      options?.includeLaunchScopeEvidence === true && this.redetectedStatus
        ? this.redetectedStatus
        : this.status;
    const { accountFingerprint, selectedModel, ...baseStatus } = status;
    const evidence = this.trustedScopeEvidence ?? { accountFingerprint, selectedModel };
    return options?.workspaceTrust?.state === 'trusted' &&
      options.includeLaunchScopeEvidence === true
      ? { ...baseStatus, ...evidence }
      : baseStatus;
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    this.startedOptions.push(options);
    async function* events(): AsyncGenerator<AgentEvent, void, void> {
      yield { type: 'session.started', sessionId: options.sessionId, provider: 'codex' };
      yield { type: 'session.completed', providerSessionId: 'unknown-version-thread' };
    }
    return { events: events(), cancel: async () => undefined };
  }

  async startInteractiveSession(): Promise<never> {
    throw new Error('unknown-version fixture must not use app-server');
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
      version: CLAUDE_LEGACY_COMPATIBILITY.providerVersion,
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
  logger: Logger = noopLogger,
) {
  const registry = new ProviderRegistry();
  const provider = new FakeProvider('claude', undefined, 'success', scenario);
  registry.register(provider);
  const sessionManager = new SessionManager(registry, logger);
  const app = buildServer({ registry, sessionManager, token: TOKEN, logger });
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

function openEventStream(
  app: FastifyInstance,
  sessionId: string,
  responder = false,
): Promise<LightMyRequestResponse> {
  return new Promise((resolve, reject) => {
    app.inject(
      {
        method: 'GET',
        url: `/v2/sessions/${sessionId}/events`,
        headers: { ...auth(), ...(responder ? { 'x-agentdock-responder': '1' } : {}) },
        payloadAsStream: true,
      },
      (error, response) => {
        if (error || !response) reject(error ?? new Error('event stream did not open'));
        else resolve(response);
      },
    );
  });
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-daemon-v2-test-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('POST /v2/sessions admission control (issue #52)', () => {
  it('maps admission-controller rejection to 429 session_capacity_exceeded', async () => {
    const registry = new ProviderRegistry();
    const provider = new FakeProvider('claude', undefined, 'success', 'multi-input');
    registry.register(provider);
    const sessionManager = new SessionManager(registry, noopLogger, undefined, {
      admission: new SessionAdmissionController({ maxActiveSessions: 1 }),
    });
    const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });

    await createInteractiveSession(app, ['session.cancel']);

    const second = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: {
        provider: 'claude',
        cwd,
        prompt: 'second turn',
        capabilities: {
          required: [{ id: 'session.cancel' }],
          optional: [],
          allowExperimental: false,
        },
      },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ code: 'session_capacity_exceeded' });
  });
});

describe('v2 discovery and authorization', () => {
  it('never serializes internal account/model launch evidence on provider routes', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new FakeProvider('claude', {
        id: 'claude',
        name: 'Private evidence fixture',
        installed: true,
        authenticated: 'authenticated',
        authSource: 'chatgpt',
        accountFingerprint: 'f'.repeat(64),
        selectedModel: 'private-model-evidence',
        capabilities: FAKE_PROVIDER_CAPABILITIES,
      }),
    );
    const sessionManager = new SessionManager(registry, noopLogger);
    const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });

    for (const url of [
      '/providers',
      '/providers/claude',
      '/v2/providers',
      '/v2/providers/claude',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: auth() });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain('accountFingerprint');
      expect(response.body).not.toContain('selectedModel');
      expect(response.body).not.toContain('private-model-evidence');
    }
  });

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
    expect(parsed.providers[0]?.sandbox.agentDock.state).toBe('not_requested');
  });

  it('returns a bounded schema-valid provider status when v2 support resolution is unavailable', async () => {
    const registry = new ProviderRegistry();
    const provider = new FakeProvider(
      'codex',
      {
        id: 'codex',
        name: 'Codex',
        installed: true,
        authenticated: 'authenticated',
        capabilities: FAKE_PROVIDER_CAPABILITIES,
        version: '0.148.0',
      },
      'success',
      'multi-input',
    );
    vi.spyOn(provider, 'getV2Support').mockImplementation(() => {
      throw new Error('unsupported app-server version');
    });
    registry.register(provider);
    const sessionManager = new SessionManager(registry, noopLogger);
    const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });

    const response = await app.inject({ method: 'GET', url: '/v2/providers', headers: auth() });

    expect(response.statusCode).toBe(200);
    const parsed = providersV2ResponseSchema.parse(response.json());
    expect(parsed.providers[0]).toMatchObject({
      id: 'codex',
      error:
        'Codex app-server transport is unavailable for the detected CLI version or transport mode',
    });
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
  it('uses parent-addressed resume and fork routes with immutable lineage', async () => {
    const status: ProviderStatus = {
      id: 'claude',
      name: 'Continuation fixture',
      installed: true,
      authenticated: 'authenticated',
      authSource: 'chatgpt',
      accountFingerprint: 'a'.repeat(64),
      selectedModel: 'fixture-model',
      executablePath: 'C:\\fixtures\\claude.exe',
      version: FAKE_INTERACTIVE_COMPATIBILITY.providerVersion,
      capabilities: { ...FAKE_PROVIDER_CAPABILITIES, resume: true },
    };
    const registry = new ProviderRegistry();
    const provider = new FakeProvider('claude', status, 'success', 'multi-input');
    const baseSupport = provider.getV2Support(status)!;
    const scope = baseSupport.capabilities[0]!.scope;
    const continuationRecord = (id: 'session.resume' | 'session.fork'): CapabilitySupportRecord =>
      ({
        id,
        kind: 'operation',
        owner: 'provider',
        support: 'supported',
        stability: 'stable',
        evidence: [{ kind: 'fixture', reference: FAKE_INTERACTIVE_COMPATIBILITY.fixtureSet }],
        scope,
        prerequisites: {
          capabilities: [],
          trustStates: ['untrusted'],
          sessionStates: ['starting'],
          services: [],
        },
        possibleEffects: [],
        effectsComplete: true,
        constraints: { kind: 'continuation', native: true },
      }) as CapabilitySupportRecord;
    vi.spyOn(provider, 'getV2Support').mockReturnValue({
      ...baseSupport,
      capabilities: [
        ...baseSupport.capabilities,
        continuationRecord('session.resume'),
        continuationRecord('session.fork'),
      ],
    });
    const originalStart = provider.startInteractiveSession.bind(provider);
    let forkTargetSequence = 0;
    vi.spyOn(provider, 'startInteractiveSession').mockImplementation(async (options) => {
      const handle = await originalStart(options);
      return {
        events: handle.events,
        accepted: handle.accepted,
        send: (command) => handle.send(command),
        resolveInteraction: (requestId, reason) => handle.resolveInteraction(requestId, reason),
        interrupt: () => handle.interrupt(),
        close: () => handle.close(),
        providerSessionId:
          options.continuation?.kind === 'fork'
            ? 'native-fork-' + String(++forkTargetSequence)
            : (options.continuation?.providerSessionId ?? 'native-thread-1'),
        continuationEvidence: {
          accountFingerprint: createHash('sha256').update('fixture@example.test').digest('hex'),
          selectedModel: 'fixture-model',
        },
      };
    });
    registry.register(provider);
    const identity = await resolveWorkspaceIdentity(cwd);
    const trustStore = new WorkspaceTrustStore(join(cwd, 'trust.json'));
    await trustStore.setTrusted(identity);
    const sessionManager = new SessionManager(registry, noopLogger, undefined, { trustStore });
    const app = buildServer({
      registry,
      sessionManager,
      trustStore,
      token: TOKEN,
      logger: noopLogger,
    });
    const capabilities = {
      required: [{ id: 'session.cancel' }],
      optional: [],
      allowExperimental: false,
    };
    const payload = {
      provider: 'claude' as const,
      cwd,
      prompt: 'start continuation parent',
      capabilities,
    };
    const continuationInput = (prompt: string) => ({ prompt, capabilities });
    const cancelAndWait = async (sessionId: string): Promise<void> => {
      const cancelled = await app.inject({
        method: 'POST',
        url: '/v2/sessions/' + sessionId + '/cancel',
        headers: auth(),
      });
      expect(cancelled.statusCode, cancelled.body).toBe(202);
      await vi.waitFor(async () => {
        const snapshot = await app.inject({
          method: 'GET',
          url: '/v2/sessions/' + sessionId,
          headers: auth(),
        });
        expect(agentSessionV2Schema.parse(snapshot.json()).status).toBe('cancelled');
      });
    };

    const fresh = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload,
    });
    expect(fresh.statusCode, fresh.body).toBe(201);
    const freshSession = agentSessionV2Schema.parse(fresh.json());
    expect(freshSession.providerSessionId).toBe('native-thread-1');
    expect(provider.interactiveStartedOptions[0]?.continuation).toBeUndefined();

    const sessionsBeforeTargetCollision = sessionManager.list(2).length;
    const closesBeforeTargetCollision = provider.interactiveCloses;
    const targetCollision = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { ...payload, prompt: 'provider reused an active native id' },
    });
    expect(targetCollision.statusCode).toBe(409);
    expect(targetCollision.json()).toMatchObject({ code: 'continuation_in_use' });
    expect(sessionManager.list(2)).toHaveLength(sessionsBeforeTargetCollision);
    expect(provider.interactiveCloses).toBe(closesBeforeTargetCollision + 1);
    const dispatchesAfterTargetCollision = provider.interactiveStartedOptions.length;

    const rawContinuation = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: {
        ...payload,
        prompt: 'renderer-selected native id',
        continuation: { kind: 'resume', providerSessionId: freshSession.providerSessionId },
      },
    });
    expect(rawContinuation.statusCode).toBe(400);
    expect(rawContinuation.json()).toMatchObject({ code: 'raw_continuation_forbidden' });
    expect(provider.interactiveStartedOptions).toHaveLength(dispatchesAfterTargetCollision);

    const activeParent = await app.inject({
      method: 'POST',
      url: '/v2/sessions/' + freshSession.id + '/resume',
      headers: auth(),
      payload: continuationInput('resume active parent'),
    });
    expect(activeParent.statusCode).toBe(409);
    expect(activeParent.json()).toMatchObject({ code: 'continuation_parent_active' });
    expect(provider.interactiveStartedOptions).toHaveLength(dispatchesAfterTargetCollision);

    await cancelAndWait(freshSession.id);

    const dispatchesBeforeResume = provider.interactiveStartedOptions.length;
    const attempts = await Promise.all(
      ['first resume', 'concurrent resume'].map((prompt) =>
        app.inject({
          method: 'POST',
          url: '/v2/sessions/' + freshSession.id + '/resume',
          headers: auth(),
          payload: continuationInput(prompt),
        }),
      ),
    );
    const continued = attempts.find((attempt) => attempt.statusCode === 201);
    const conflict = attempts.find((attempt) => attempt.statusCode === 409);
    expect(continued).toBeDefined();
    expect(conflict).toBeDefined();
    expect(conflict?.json()).toMatchObject({ code: 'continuation_in_use' });
    expect(provider.interactiveStartedOptions).toHaveLength(dispatchesBeforeResume + 1);

    const resumedSession = agentSessionV2Schema.parse(continued!.json());
    expect(resumedSession).toMatchObject({
      providerSessionId: freshSession.providerSessionId,
      rootExecutionId: freshSession.executionId,
      parentSessionId: freshSession.id,
      parentExecutionId: freshSession.executionId,
      continuationKind: 'resume',
    });
    expect(provider.interactiveStartedOptions.at(-1)?.continuation).toEqual({
      kind: 'resume',
      providerSessionId: freshSession.providerSessionId,
    });
    expect(provider.interactiveStartedOptions.at(-1)?.expectedContinuationEvidence).toEqual({
      accountFingerprint: createHash('sha256').update('fixture@example.test').digest('hex'),
      selectedModel: 'fixture-model',
    });
    expect(continued!.body).not.toContain('accountFingerprint');

    await cancelAndWait(resumedSession.id);

    const dispatchesBeforeStaleAncestor = provider.interactiveStartedOptions.length;
    const staleAncestor = await app.inject({
      method: 'POST',
      url: '/v2/sessions/' + freshSession.id + '/resume',
      headers: auth(),
      payload: continuationInput('resume a stale ancestor'),
    });
    expect(staleAncestor.statusCode).toBe(404);
    expect(staleAncestor.json()).toMatchObject({ code: 'continuation_binding_not_found' });
    expect(provider.interactiveStartedOptions).toHaveLength(dispatchesBeforeStaleAncestor);

    const dispatchesBeforeFork = provider.interactiveStartedOptions.length;
    const forked = await app.inject({
      method: 'POST',
      url: '/v2/sessions/' + resumedSession.id + '/fork',
      headers: auth(),
      payload: continuationInput('fork terminal resumed session'),
    });
    expect(forked.statusCode, forked.body).toBe(201);
    expect(provider.interactiveStartedOptions).toHaveLength(dispatchesBeforeFork + 1);
    const forkedSession = agentSessionV2Schema.parse(forked.json());
    expect(forkedSession).toMatchObject({
      providerSessionId: 'native-fork-1',
      rootExecutionId: freshSession.executionId,
      parentSessionId: resumedSession.id,
      parentExecutionId: resumedSession.executionId,
      continuationKind: 'fork',
    });
    expect(provider.interactiveStartedOptions.at(-1)?.continuation).toEqual({
      kind: 'fork',
      providerSessionId: resumedSession.providerSessionId,
    });
    await cancelAndWait(forkedSession.id);
  });

  it('derives legacy resume identity from a terminal parent and rejects unsupported fork', async () => {
    const status: ProviderStatus = {
      id: 'claude',
      name: 'Legacy continuation fixture',
      installed: true,
      authenticated: 'authenticated',
      authSource: 'chatgpt',
      accountFingerprint: 'b'.repeat(64),
      selectedModel: 'fixture-model',
      executablePath: 'C:\\fixtures\\claude.exe',
      version: CLAUDE_LEGACY_COMPATIBILITY.providerVersion,
      capabilities: { ...FAKE_PROVIDER_CAPABILITIES, resume: true },
    };
    const registry = new ProviderRegistry();
    const provider = new FakeProvider('claude', status);
    registry.register(provider);
    const identity = await resolveWorkspaceIdentity(cwd);
    const trustStore = new WorkspaceTrustStore(join(cwd, 'trust.json'));
    await trustStore.setTrusted(identity);
    const sessionManager = new SessionManager(registry, noopLogger, undefined, { trustStore });
    const app = buildServer({
      registry,
      sessionManager,
      trustStore,
      token: TOKEN,
      logger: noopLogger,
    });
    const payload = { provider: 'claude' as const, cwd, prompt: 'legacy fresh' };
    const fresh = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload,
    });
    expect(fresh.statusCode, fresh.body).toBe(201);
    const freshSession = agentSessionV2Schema.parse(fresh.json());
    let terminalParent = freshSession;
    await vi.waitFor(async () => {
      const snapshot = await app.inject({
        method: 'GET',
        url: '/v2/sessions/' + freshSession.id,
        headers: auth(),
      });
      terminalParent = agentSessionV2Schema.parse(snapshot.json());
      expect(terminalParent.status).toBe('completed');
      expect(terminalParent.providerSessionId).toBe('fake-' + freshSession.id);
    });

    const resumed = await app.inject({
      method: 'POST',
      url: '/v2/sessions/' + freshSession.id + '/resume',
      headers: auth(),
      payload: { prompt: 'legacy resume' },
    });
    expect(resumed.statusCode, resumed.body).toBe(201);
    expect(provider.startedOptions[1]?.resumeProviderSessionId).toBe(
      terminalParent.providerSessionId,
    );
    const resumedSession = agentSessionV2Schema.parse(resumed.json());
    expect(resumedSession).toMatchObject({
      rootExecutionId: freshSession.executionId,
      parentSessionId: freshSession.id,
      parentExecutionId: freshSession.executionId,
      continuationKind: 'resume',
    });
    await vi.waitFor(async () => {
      const snapshot = await app.inject({
        method: 'GET',
        url: '/v2/sessions/' + resumedSession.id,
        headers: auth(),
      });
      const terminalResume = agentSessionV2Schema.parse(snapshot.json());
      expect(terminalResume.status).toBe('completed');
    });

    const forked = await app.inject({
      method: 'POST',
      url: '/v2/sessions/' + freshSession.id + '/fork',
      headers: auth(),
      payload: { prompt: 'legacy fork' },
    });
    expect(forked.statusCode).toBe(422);
    expect(forked.json()).toMatchObject({ code: 'required_capability_unavailable' });
    expect(provider.startedOptions).toHaveLength(2);
  });

  it('fails a continuation deterministically when the terminal parent has no native id', async () => {
    const registry = new ProviderRegistry();
    const provider = new ObservationProvider();
    const start = vi.spyOn(provider, 'startSession');
    registry.register(provider);
    const sessionManager = new SessionManager(registry, noopLogger);
    const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });
    const fresh = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'no native id' },
    });
    expect(fresh.statusCode, fresh.body).toBe(201);
    const freshSession = agentSessionV2Schema.parse(fresh.json());
    await vi.waitFor(async () => {
      const snapshot = await app.inject({
        method: 'GET',
        url: '/v2/sessions/' + freshSession.id,
        headers: auth(),
      });
      const parent = agentSessionV2Schema.parse(snapshot.json());
      expect(parent.status).toBe('completed');
      expect(parent.providerSessionId).toBeUndefined();
    });

    const missing = await app.inject({
      method: 'POST',
      url: '/v2/sessions/' + freshSession.id + '/resume',
      headers: auth(),
      payload: { prompt: 'resume without native id' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'continuation_not_found' });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('paginates durable session lists and normalized event history', async () => {
    const { app } = setup();
    const created: AgentSessionV2[] = [];
    for (const prompt of ['first paginated session', 'second paginated session']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v2/sessions',
        headers: auth(),
        payload: { provider: 'claude', cwd, prompt },
      });
      expect(response.statusCode, response.body).toBe(201);
      created.push(agentSessionV2Schema.parse(response.json()));
    }

    await vi.waitFor(async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v2/sessions/' + created[0]!.id + '/history?limit=100',
        headers: auth(),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(sessionEventHistoryV2PageSchema.parse(response.json()).events.length).toBeGreaterThan(
        1,
      );
    });

    const firstListResponse = await app.inject({
      method: 'GET',
      url: '/v2/sessions?limit=1',
      headers: auth(),
    });
    expect(firstListResponse.statusCode, firstListResponse.body).toBe(200);
    const firstListPage = sessionListV2PageSchema.parse(firstListResponse.json());
    expect(firstListPage.sessions).toHaveLength(1);
    expect(firstListPage.nextCursor).toBeDefined();

    const secondListResponse = await app.inject({
      method: 'GET',
      url: '/v2/sessions?limit=1&cursor=' + encodeURIComponent(firstListPage.nextCursor as string),
      headers: auth(),
    });
    expect(secondListResponse.statusCode, secondListResponse.body).toBe(200);
    const secondListPage = sessionListV2PageSchema.parse(secondListResponse.json());
    expect(secondListPage.sessions).toHaveLength(1);
    expect([firstListPage.sessions[0]!.id, secondListPage.sessions[0]!.id].sort()).toEqual(
      created.map((session) => session.id).sort(),
    );

    const firstHistoryResponse = await app.inject({
      method: 'GET',
      url: '/v2/sessions/' + created[0]!.id + '/history?limit=1',
      headers: auth(),
    });
    expect(firstHistoryResponse.statusCode, firstHistoryResponse.body).toBe(200);
    const firstHistoryPage = sessionEventHistoryV2PageSchema.parse(firstHistoryResponse.json());
    expect(firstHistoryPage.events).toHaveLength(1);
    expect(firstHistoryPage.nextCursor).toBeDefined();

    const secondHistoryResponse = await app.inject({
      method: 'GET',
      url:
        '/v2/sessions/' +
        created[0]!.id +
        '/history?limit=1&cursor=' +
        encodeURIComponent(firstHistoryPage.nextCursor as string),
      headers: auth(),
    });
    expect(secondHistoryResponse.statusCode, secondHistoryResponse.body).toBe(200);
    const secondHistoryPage = sessionEventHistoryV2PageSchema.parse(secondHistoryResponse.json());
    expect(secondHistoryPage.events).toHaveLength(1);
    expect(secondHistoryPage.events[0]!.sessionId).toBe(created[0]!.id);
    expect(secondHistoryPage.events[0]!.sequence).toBeGreaterThan(
      firstHistoryPage.events[0]!.sequence,
    );
  });

  it('serves retained session metadata and normalized history after daemon reconstruction', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new FakeProvider('claude', {
        id: 'claude',
        name: 'Claude Code',
        installed: true,
        authenticated: 'authenticated',
        capabilities: FAKE_PROVIDER_CAPABILITIES,
        version: CLAUDE_LEGACY_COMPATIBILITY.providerVersion,
      }),
    );
    const graphPath = join(cwd, 'execution-graph');
    const firstManager = new SessionManager(registry, noopLogger, undefined, {
      executionGraphStore: new FileExecutionGraphStore(graphPath),
    });
    const firstDaemon = buildServer({
      registry,
      sessionManager: firstManager,
      token: TOKEN,
      logger: noopLogger,
    });
    const created = await firstDaemon.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'survive restart' },
    });
    const session = agentSessionV2Schema.parse(created.json());
    await vi.waitFor(async () => {
      const snapshot = await firstDaemon.inject({
        method: 'GET',
        url: `/v2/sessions/${session.id}`,
        headers: auth(),
      });
      expect(agentSessionV2Schema.parse(snapshot.json()).status).toBe('completed');
    });
    await firstDaemon.close();

    const recoveredManager = new SessionManager(registry, noopLogger, undefined, {
      executionGraphStore: new FileExecutionGraphStore(graphPath),
    });
    const recoveredDaemon = buildServer({
      registry,
      sessionManager: recoveredManager,
      token: TOKEN,
      logger: noopLogger,
    });
    const recovered = await recoveredDaemon.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}`,
      headers: auth(),
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(agentSessionV2Schema.parse(recovered.json())).toMatchObject({
      id: session.id,
      executionId: session.executionId,
      status: 'completed',
    });
    const history = await recoveredDaemon.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/history?limit=100`,
      headers: auth(),
    });
    const events = sessionEventHistoryV2PageSchema.parse(history.json()).events;
    expect(events[0]?.type).toBe('session.started');
    expect(events.at(-1)?.type).toBe('session.completed');
    await recoveredDaemon.close();
  });

  it('returns storage_full before provider dispatch when no lineage can make room', async () => {
    const registry = new ProviderRegistry();
    const provider = new FakeProvider('claude', {
      id: 'claude',
      name: 'Claude Code',
      installed: true,
      authenticated: 'authenticated',
      capabilities: FAKE_PROVIDER_CAPABILITIES,
      version: CLAUDE_LEGACY_COMPATIBILITY.providerVersion,
    });
    registry.register(provider);
    const quotaPath = join(cwd, 'quota');
    mkdirSync(quotaPath, { recursive: true });
    writeFileSync(join(quotaPath, 'retained.bin'), Buffer.alloc(2_048));
    const sessionManager = new SessionManager(registry, noopLogger, undefined, {
      executionGraphStore: new FileExecutionGraphStore(join(cwd, 'full-graph'), {
        maxBytes: 1_024,
        additionalQuotaPaths: [quotaPath],
      }),
    });
    const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });

    const response = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'must not dispatch' },
    });

    expect(response.statusCode).toBe(507);
    expect(response.json()).toMatchObject({ code: 'storage_full' });
    expect(provider.startedOptions).toHaveLength(0);
    await app.close();
  });

  it('dispatches unknown-version auto exec only through a trusted, pinned, authenticated scope', async () => {
    const previousMode = process.env.AGENT_DOCK_CODEX_TRANSPORT;
    process.env.AGENT_DOCK_CODEX_TRANSPORT = 'auto';
    try {
      const status: ProviderStatus = {
        id: 'codex',
        name: 'Unknown Codex',
        installed: true,
        authenticated: 'authenticated',
        authSource: 'chatgpt',
        executablePath: 'C:\\pinned\\codex.exe',
        version: '0.999.0',
        capabilities: { cancellation: true, resume: true },
      };
      const registry = new ProviderRegistry();
      const provider = new UnknownCodexProvider(status, {
        accountFingerprint: 'c'.repeat(64),
        selectedModel: 'gpt-5.4',
      });
      registry.register(provider);
      const identity = await resolveWorkspaceIdentity(cwd);
      const trustStore = new WorkspaceTrustStore(join(cwd, 'unknown-auto-trust.json'));
      await trustStore.setTrusted(identity);
      const sessionManager = new SessionManager(registry, noopLogger, undefined, { trustStore });
      const app = buildServer({
        registry,
        sessionManager,
        trustStore,
        token: TOKEN,
        logger: noopLogger,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v2/sessions',
        headers: auth(),
        payload: {
          provider: 'codex',
          cwd,
          prompt: 'pinned unknown auto',
          capabilities: { required: [], optional: [], allowExperimental: false },
        },
      });

      expect(response.statusCode, response.body).toBe(201);
      expect(provider.detectCalls).toBe(2);
      expect(provider.detectionOptions).toHaveLength(2);
      expect(provider.detectionOptions).toEqual([
        expect.objectContaining({
          cwd: identity.canonicalPath,
          workspaceTrust: expect.objectContaining({ state: 'trusted' }),
          includeLaunchScopeEvidence: false,
        }),
        expect.objectContaining({
          cwd: identity.canonicalPath,
          workspaceTrust: expect.objectContaining({ state: 'trusted' }),
          includeLaunchScopeEvidence: true,
        }),
      ]);
      expect(provider.startedOptions).toHaveLength(1);
      expect(provider.startedOptions[0]).toMatchObject({
        cwd: identity.canonicalPath,
        providerStatus: {
          ...status,
          accountFingerprint: 'c'.repeat(64),
          selectedModel: 'gpt-5.4',
        },
        sandbox: 'workspace-write',
        model: 'gpt-5.4',
      });
    } finally {
      if (previousMode === undefined) delete process.env.AGENT_DOCK_CODEX_TRANSPORT;
      else process.env.AGENT_DOCK_CODEX_TRANSPORT = previousMode;
    }
  });

  it.each([
    ['unauthenticated', { authenticated: 'unauthenticated' as const }],
    ['unknown auth source', { authSource: 'unknown' as const }],
    ['missing account evidence', { accountFingerprint: undefined }],
    ['missing model evidence', { selectedModel: undefined }],
  ])('rejects unknown-version auto exec before dispatch for %s', async (_label, change) => {
    const previousMode = process.env.AGENT_DOCK_CODEX_TRANSPORT;
    process.env.AGENT_DOCK_CODEX_TRANSPORT = 'auto';
    try {
      const status: ProviderStatus = {
        id: 'codex',
        name: 'Unknown Codex',
        installed: true,
        authenticated: 'authenticated',
        authSource: 'chatgpt',
        accountFingerprint: 'd'.repeat(64),
        selectedModel: 'gpt-5.4',
        executablePath: 'C:\\pinned\\codex.exe',
        version: '0.999.0',
        capabilities: { cancellation: true },
        ...change,
      };
      const registry = new ProviderRegistry();
      const provider = new UnknownCodexProvider(status);
      registry.register(provider);
      const identity = await resolveWorkspaceIdentity(cwd);
      const trustStore = new WorkspaceTrustStore(join(cwd, `unknown-auto-${_label}.json`));
      await trustStore.setTrusted(identity);
      const sessionManager = new SessionManager(registry, noopLogger, undefined, { trustStore });
      const app = buildServer({
        registry,
        sessionManager,
        trustStore,
        token: TOKEN,
        logger: noopLogger,
      });
      const response = await app.inject({
        method: 'POST',
        url: '/v2/sessions',
        headers: auth(),
        payload: {
          provider: 'codex',
          cwd,
          prompt: 'must not start',
          capabilities: { required: [], optional: [], allowExperimental: false },
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: 'provider_scope_unverified' });
      expect(provider.startedOptions).toHaveLength(0);
    } finally {
      if (previousMode === undefined) delete process.env.AGENT_DOCK_CODEX_TRANSPORT;
      else process.env.AGENT_DOCK_CODEX_TRANSPORT = previousMode;
    }
  });

  it('rejects unknown-version auto exec if bounded re-detection changes executable or auth scope', async () => {
    const previousMode = process.env.AGENT_DOCK_CODEX_TRANSPORT;
    process.env.AGENT_DOCK_CODEX_TRANSPORT = 'auto';
    try {
      const status: ProviderStatus = {
        id: 'codex',
        name: 'Unknown Codex',
        installed: true,
        authenticated: 'authenticated',
        authSource: 'chatgpt',
        accountFingerprint: 'e'.repeat(64),
        selectedModel: 'gpt-5.4',
        executablePath: 'C:\\pinned\\codex.exe',
        version: '0.999.0',
        capabilities: { cancellation: true },
      };
      const registry = new ProviderRegistry();
      const provider = new UnknownCodexProvider(status);
      provider.redetectedStatus = { ...status, executablePath: 'C:\\switched\\codex.exe' };
      registry.register(provider);
      const identity = await resolveWorkspaceIdentity(cwd);
      const trustStore = new WorkspaceTrustStore(join(cwd, 'unknown-switch-trust.json'));
      await trustStore.setTrusted(identity);
      const sessionManager = new SessionManager(registry, noopLogger, undefined, { trustStore });
      const app = buildServer({
        registry,
        sessionManager,
        trustStore,
        token: TOKEN,
        logger: noopLogger,
      });
      const response = await app.inject({
        method: 'POST',
        url: '/v2/sessions',
        headers: auth(),
        payload: {
          provider: 'codex',
          cwd,
          prompt: 'must not start',
          capabilities: { required: [], optional: [], allowExperimental: false },
        },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        code: 'provider_transport_startup_failed',
        details: { reason: 'provider_scope_revalidation_failed' },
      });
      expect(provider.startedOptions).toHaveLength(0);
    } finally {
      if (previousMode === undefined) delete process.env.AGENT_DOCK_CODEX_TRANSPORT;
      else process.env.AGENT_DOCK_CODEX_TRANSPORT = previousMode;
    }
  });

  it.each(['app-server', 'invalid-mode'])(
    'returns bounded 422 for unsupported forced mode %s',
    async (mode) => {
      const previousMode = process.env.AGENT_DOCK_CODEX_TRANSPORT;
      process.env.AGENT_DOCK_CODEX_TRANSPORT = mode;
      try {
        const registry = new ProviderRegistry();
        const provider = new UnknownCodexProvider({
          id: 'codex',
          name: 'Unknown Codex',
          installed: true,
          authenticated: 'authenticated',
          capabilities: { cancellation: true },
          version: '0.999.0',
        });
        registry.register(provider);
        const sessionManager = new SessionManager(registry, noopLogger);
        const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });
        const response = await app.inject({
          method: 'POST',
          url: '/v2/sessions',
          headers: auth(),
          payload: { provider: 'codex', cwd, prompt: 'must not start' },
        });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ code: 'provider_transport_unavailable' });
        expect(provider.startedOptions).toHaveLength(0);
      } finally {
        if (previousMode === undefined) delete process.env.AGENT_DOCK_CODEX_TRANSPORT;
        else process.env.AGENT_DOCK_CODEX_TRANSPORT = previousMode;
      }
    },
  );

  it.each(['sdk', 'invalid-mode'])(
    'returns bounded 422 for unsupported Claude transport mode %s',
    async (mode) => {
      const previousMode = process.env.AGENT_DOCK_CLAUDE_TRANSPORT;
      process.env.AGENT_DOCK_CLAUDE_TRANSPORT = mode;
      try {
        const registry = new ProviderRegistry();
        const provider = new ObservationProvider();
        const start = vi.spyOn(provider, 'startSession');
        registry.register(provider);
        const sessionManager = new SessionManager(registry, noopLogger);
        const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });

        const response = await app.inject({
          method: 'POST',
          url: '/v2/sessions',
          headers: auth(),
          payload: { provider: 'claude', cwd, prompt: 'must not start' },
        });

        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ code: 'provider_transport_unavailable' });
        expect(start).not.toHaveBeenCalled();
      } finally {
        if (previousMode === undefined) delete process.env.AGENT_DOCK_CLAUDE_TRANSPORT;
        else process.env.AGENT_DOCK_CLAUDE_TRANSPORT = previousMode;
      }
    },
  );

  it('returns a bounded visible reason when startup cannot safely fall back', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } satisfies Logger;
    const { app, provider } = setupInteractive('multi-input', logger);
    const promptCanary = 'PROMPT_CANARY_do_not_log';
    const credentialCanary = 'sk-proj-CREDENTIAL_CANARY_do_not_log';
    const approvalCanary = 'RAW_APPROVAL_CANARY_do_not_log';
    vi.spyOn(provider, 'startInteractiveSession').mockRejectedValueOnce(
      new ProviderTransportStartupError(
        'app_server_handshake_failed',
        'not_delivered',
        `${credentialCanary} ${approvalCanary} native payload must not be returned`,
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: {
        provider: 'claude',
        cwd,
        prompt: promptCanary,
        capabilities: {
          required: [{ id: 'session.cancel' }],
          optional: [],
          allowExperimental: false,
        },
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: 'provider_transport_startup_failed',
      details: {
        reason: 'app_server_handshake_failed',
        deliveryState: 'not_delivered',
        fallback: 'fallback_scope_mismatch',
      },
    });
    expect(response.body).not.toContain(promptCanary);
    expect(response.body).not.toContain(credentialCanary);
    expect(response.body).not.toContain(approvalCanary);
    expect(response.body).not.toContain('native payload');
    const serializedLogs = JSON.stringify(
      Object.values(logger).flatMap((method) => method.mock.calls),
    );
    expect(serializedLogs).not.toContain(promptCanary);
    expect(serializedLogs).not.toContain(credentialCanary);
    expect(serializedLogs).not.toContain(approvalCanary);
    expect(provider.startedOptions).toHaveLength(0);
  });

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
    expect(provider.startedOptions[0]?.providerStatus).toMatchObject({
      id: 'claude',
      installed: true,
      authenticated: 'authenticated',
    });

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
    const responderStream = await openEventStream(app, session.id, true);
    responderStream.stream().resume();
    const responderLease = responderStream.headers['x-agentdock-responder-lease'];
    expect(responderLease).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const responderHeaders = {
      ...auth(),
      'x-agentdock-responder-lease': responderLease as string,
    };

    const accepted = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: responderHeaders,
      payload: responseCommand,
    });
    expect(accepted.statusCode).toBe(202);
    const retry = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: responderHeaders,
      payload: responseCommand,
    });
    expect(retry.statusCode).toBe(202);
    expect(provider.interactiveCommands).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const stale = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: responderHeaders,
      payload: { ...responseCommand, commandId: randomUUID() },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('stale_interaction');
    await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/cancel`,
      headers: auth(),
    });
    responderStream.raw.res.destroy();
  });

  it('authorizes interaction responses only for the sole live responder lease', async () => {
    const { app, provider } = setupInteractive('approval');
    const session = await createInteractiveSession(app, ['interaction.approval', 'session.cancel']);
    await vi.waitFor(() => expect(provider.lastInteractionRequestId).toBeDefined());
    const responseCommand = {
      type: 'approval.respond' as const,
      commandId: randomUUID(),
      sessionId: session.id,
      turnId: session.currentTurnId as string,
      requestId: provider.lastInteractionRequestId as string,
      decision: 'allow_once' as const,
    };

    const observerCommand = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: auth(),
      payload: responseCommand,
    });
    expect(observerCommand.statusCode).toBe(403);
    expect(observerCommand.json()).toMatchObject({ code: 'responder_lease_required' });

    const observerStream = await openEventStream(app, session.id);
    expect(observerStream.headers).not.toHaveProperty('x-agentdock-responder-lease');
    observerStream.raw.res.destroy();

    const responderStream = await openEventStream(app, session.id, true);
    responderStream.stream().resume();
    const responderLease = responderStream.headers['x-agentdock-responder-lease'];
    expect(responderLease).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const competing = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: { ...auth(), 'x-agentdock-responder': '1' },
    });
    expect(competing.statusCode).toBe(409);
    expect(competing.json()).toMatchObject({ code: 'responder_already_connected' });

    const competingCommand = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: { ...auth(), 'x-agentdock-responder-lease': 'x'.repeat(43) },
      payload: responseCommand,
    });
    expect(competingCommand.statusCode).toBe(403);
    expect(competingCommand.json()).toMatchObject({ code: 'responder_lease_required' });

    const accepted = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/commands`,
      headers: {
        ...auth(),
        'x-agentdock-responder-lease': responderLease as string,
      },
      payload: responseCommand,
    });
    expect(accepted.statusCode).toBe(202);
    await vi.waitFor(() => expect(provider.interactiveCommands).toHaveLength(1));
    responderStream.raw.res.destroy();
  });

  it('admits one responder stream and denies its pending approval exactly once on cancellation', async () => {
    const { app, provider } = setupInteractive('approval');
    const session = await createInteractiveSession(app, ['interaction.approval', 'session.cancel']);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const firstStream = app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: { ...auth(), 'x-agentdock-responder': '1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const competing = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/events`,
      headers: { ...auth(), 'x-agentdock-responder': '1' },
    });
    expect(competing.statusCode).toBe(409);
    expect(competing.json()).toMatchObject({ code: 'responder_already_connected' });

    await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/cancel`,
      headers: auth(),
    });
    const streamed = parseSseData((await firstStream).body) as Array<{
      type: string;
      requestId?: string;
    }>;

    expect(provider.interactiveResolutions).toEqual([
      expect.objectContaining({
        kind: 'approval',
        requestId: provider.lastInteractionRequestId,
        decision: 'deny',
        reason: 'cancel',
      }),
    ]);
    expect(
      streamed.filter(
        (event) =>
          event.type === 'approval.resolved' &&
          event.requestId === provider.lastInteractionRequestId,
      ),
    ).toHaveLength(1);
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
    const { app, provider } = setupInteractive(scenario);
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
    // The route negotiates and starts exactly one transport. In particular, the accepted
    // crashing provider must never trigger an automatic fallback and duplicate side effects.
    expect(provider.interactiveStartedOptions).toHaveLength(1);
    expect(provider.startedOptions).toHaveLength(0);
  });

  it('fails a corrupted fake-provider queue once and preserves replay-gap semantics', async () => {
    const { app, provider } = setupInteractive('queue-overflow');
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
    expect(provider.interactiveStartedOptions).toHaveLength(1);
    expect(provider.startedOptions).toHaveLength(0);
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

  it('persists a safe summary for non-persistable extensions and bounds terminal reasons', async () => {
    const { app, provider } = setupInteractive();
    const secret = 'NON_PERSISTABLE_EXTENSION_SECRET';
    const longReason = 'é'.repeat(2_048);
    vi.spyOn(provider, 'startInteractiveSession').mockImplementation(async (options) => {
      provider.interactiveStartedOptions.push(options);
      async function* events(): AsyncGenerator<AgentEventV2, void, void> {
        yield {
          type: 'session.started',
          provider: 'claude',
          transport: options.transport.id,
          selection: options.selection,
        };
        yield { type: 'session.status', status: 'active' };
        yield { type: 'turn.started', turnId: options.turnId };
        yield {
          type: 'content.completed',
          turnId: options.turnId,
          block: {
            type: 'provider_extension',
            id: randomUUID(),
            extensionName: 'fixture.private',
            representation: 'bounded_data',
            safeSummary: 'private provider data omitted',
            data: { secret },
            safeToPersist: false,
          },
        };
        yield { type: 'session.cancelled', reason: longReason };
      }
      return {
        events: events(),
        accepted: Promise.resolve('accepted' as const),
        send: async () => undefined,
        resolveInteraction: async () => undefined,
        interrupt: async () => undefined,
        close: async () => undefined,
      };
    });

    const session = await createInteractiveSession(app, ['session.cancel']);
    let terminal = session;
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v2/sessions/${session.id}`,
        headers: auth(),
      });
      expect(response.statusCode, response.body).toBe(200);
      terminal = agentSessionV2Schema.parse(response.json());
      expect(terminal.status).toBe('cancelled');
    });
    expect(Buffer.byteLength(terminal.terminalReason ?? '', 'utf8')).toBeLessThanOrEqual(256);
    expect(terminal.terminalReason).toBe('é'.repeat(128));

    const historyResponse = await app.inject({
      method: 'GET',
      url: `/v2/sessions/${session.id}/history?limit=100`,
      headers: auth(),
    });
    expect(historyResponse.statusCode, historyResponse.body).toBe(200);
    const history = sessionEventHistoryV2PageSchema.parse(historyResponse.json()).events;
    const content = history.find((event) => event.type === 'content.completed');
    expect(content).toMatchObject({
      type: 'content.completed',
      block: {
        type: 'provider_extension',
        extensionName: 'fixture.private',
        representation: 'safe_summary',
        safeSummary: 'private provider data omitted',
        reason: 'persistence_disallowed',
      },
    });
    expect(JSON.stringify(history)).not.toContain(secret);
    const cancelled = history.at(-1);
    expect(cancelled).toMatchObject({ type: 'session.cancelled', reason: 'é'.repeat(128) });
  });

  it('omits raw compatibility errors from durable v2 session metadata', async () => {
    const { app } = setup('failure');
    const created = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'fail without durable diagnostics' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const session = agentSessionV2Schema.parse(created.json());

    let terminal = session;
    await vi.waitFor(async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v2/sessions/${session.id}`,
        headers: auth(),
      });
      terminal = agentSessionV2Schema.parse(response.json());
      expect(terminal.status).toBe('failed');
    });
    expect(terminal).not.toHaveProperty('error');

    const listed = await app.inject({ method: 'GET', url: '/v2/sessions', headers: auth() });
    const stored = sessionListV2PageSchema
      .parse(listed.json())
      .sessions.find((candidate) => candidate.id === session.id);
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty('error');
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

  it('rejects active-lineage deletion without removing the session', async () => {
    const { app } = setup('hang-until-cancelled');
    const created = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'delete only when terminal' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const session = agentSessionV2Schema.parse(created.json());

    const activeDelete = await app.inject({
      method: 'DELETE',
      url: `/v2/sessions/${session.id}`,
      headers: auth(),
    });
    expect(activeDelete.statusCode).toBe(409);
    expect(activeDelete.json()).toMatchObject({ code: 'active_lineage' });
    expect(
      (await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}`, headers: auth() }))
        .statusCode,
    ).toBe(200);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${session.id}/cancel`,
      headers: auth(),
    });
    expect(cancelled.statusCode, cancelled.body).toBe(202);
    await vi.waitFor(async () => {
      const snapshot = await app.inject({
        method: 'GET',
        url: `/v2/sessions/${session.id}`,
        headers: auth(),
      });
      expect(agentSessionV2Schema.parse(snapshot.json()).status).toBe('cancelled');
    });

    const terminalDelete = await app.inject({
      method: 'DELETE',
      url: `/v2/sessions/${session.id}`,
      headers: auth(),
    });
    expect(terminalDelete.statusCode).toBe(204);
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
