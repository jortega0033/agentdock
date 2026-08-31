import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FakeProvider, ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { auditReadResponseV2Schema, workspaceTrustViewV2Schema } from '@agent-dock/shared';
import { AuditStore } from '../src/audit-store.js';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';

const TOKEN = 'security-route-token';
const applications: FastifyInstance[] = [];
let root: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-dock-security-routes-'));
  cwd = join(root, 'workspace');
  mkdirSync(cwd);
});

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
  rmSync(root, { recursive: true, force: true });
});

function setup(interactiveScenario?: 'approval' | 'question') {
  const registry = new ProviderRegistry();
  const provider = new FakeProvider('claude', undefined, 'success', interactiveScenario);
  registry.register(provider);
  const auditStore = new AuditStore(join(root, 'state', 'audit-v1.jsonl'));
  const trustStore = new WorkspaceTrustStore(join(root, 'state', 'workspace-trust-v1.json'));
  const sessionManager = new SessionManager(registry, noopLogger, undefined, {
    auditStore,
    trustStore,
  });
  const app = buildServer({
    registry,
    sessionManager,
    token: TOKEN,
    logger: noopLogger,
    auditStore,
    trustStore,
  });
  applications.push(app);
  return { app, provider, sessionManager, trustStore };
}

function auth() {
  return { authorization: `Bearer ${TOKEN}` };
}

async function inspect(app: FastifyInstance) {
  const response = await app.inject({
    method: 'POST',
    url: '/v2/workspaces/inspect',
    headers: auth(),
    payload: { cwd },
  });
  expect(response.statusCode, response.body).toBe(200);
  return workspaceTrustViewV2Schema.parse(response.json());
}

describe('v2 workspace and audit routes', () => {
  it('keeps both security surfaces behind bearer authentication', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/v2/audit' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v2/workspaces/inspect',
          payload: { cwd },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('defaults to untrusted and blocks provider detection before explicit trust', async () => {
    const { app, provider } = setup();
    const detect = vi.spyOn(provider, 'detect');
    expect((await inspect(app)).state).toBe('untrusted');

    const response = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { provider: 'claude', cwd, prompt: 'must not start' },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: 'workspace_untrusted' });
    expect(detect).not.toHaveBeenCalled();
  });

  it('persists exact-incarnation trust and revokes it through one authenticated route', async () => {
    const { app } = setup();
    const initial = await inspect(app);
    const trustedResponse = await app.inject({
      method: 'PUT',
      url: `/v2/workspaces/${initial.workspaceId}/trust`,
      headers: auth(),
      payload: { cwd, incarnation: initial.incarnation, state: 'trusted' },
    });
    expect(trustedResponse.statusCode, trustedResponse.body).toBe(200);
    expect(workspaceTrustViewV2Schema.parse(trustedResponse.json()).state).toBe('trusted');
    expect((await inspect(app)).state).toBe('trusted');

    const revokedResponse = await app.inject({
      method: 'PUT',
      url: `/v2/workspaces/${initial.workspaceId}/trust`,
      headers: auth(),
      payload: { cwd, incarnation: initial.incarnation, state: 'untrusted' },
    });
    expect(revokedResponse.statusCode, revokedResponse.body).toBe(200);
    expect(workspaceTrustViewV2Schema.parse(revokedResponse.json()).state).toBe('untrusted');
  });

  it('rejects a stale incarnation and exposes only parsed audit metadata', async () => {
    const { app } = setup();
    const initial = await inspect(app);
    const update = await app.inject({
      method: 'PUT',
      url: `/v2/workspaces/${initial.workspaceId}/trust`,
      headers: auth(),
      payload: { cwd, incarnation: 'f'.repeat(64), state: 'trusted' },
    });
    expect(update.statusCode).toBe(409);
    expect(update.json()).toMatchObject({ code: 'workspace_identity_changed' });

    const audit = await app.inject({ method: 'GET', url: '/v2/audit', headers: auth() });
    expect(audit.statusCode, audit.body).toBe(200);
    expect(auditReadResponseV2Schema.parse(audit.json()).entries).toEqual([]);
  });

  it('still cancels sessions and records untrusted when the intermediate marker write fails', async () => {
    const { app, sessionManager, trustStore } = setup();
    const initial = await inspect(app);
    await app.inject({
      method: 'PUT',
      url: `/v2/workspaces/${initial.workspaceId}/trust`,
      headers: auth(),
      payload: { cwd, incarnation: initial.incarnation, state: 'trusted' },
    });
    vi.spyOn(trustStore, 'beginRevocation').mockRejectedValueOnce(
      new Error('transient persistence failure'),
    );
    const revoke = vi.spyOn(sessionManager, 'revokeWorkspace');

    const response = await app.inject({
      method: 'PUT',
      url: `/v2/workspaces/${initial.workspaceId}/trust`,
      headers: auth(),
      payload: { cwd, incarnation: initial.incarnation, state: 'untrusted' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(revoke).toHaveBeenCalledWith(initial.workspaceId);
    expect(workspaceTrustViewV2Schema.parse(response.json()).state).toBe('untrusted');
  });

  it.each([
    ['approval', 'interaction.approval'],
    ['question', 'interaction.question'],
  ] as const)(
    'synchronously revokes an active trusted workspace and resolves its pending %s once',
    async (scenario, requiredCapability) => {
      const { app, provider, sessionManager } = setup(scenario);
      const initial = await inspect(app);
      const trusted = await app.inject({
        method: 'PUT',
        url: `/v2/workspaces/${initial.workspaceId}/trust`,
        headers: auth(),
        payload: { cwd, incarnation: initial.incarnation, state: 'trusted' },
      });
      expect(trusted.statusCode, trusted.body).toBe(200);

      const started = await app.inject({
        method: 'POST',
        url: '/v2/sessions',
        headers: auth(),
        payload: {
          provider: 'claude',
          cwd,
          prompt: 'pending interaction',
          capabilities: {
            required: [{ id: requiredCapability }, { id: 'session.cancel' }],
            optional: [],
            allowExperimental: false,
          },
        },
      });
      expect(started.statusCode, started.body).toBe(201);
      const sessionId = (started.json() as { id: string }).id;
      await vi.waitFor(() => expect(provider.lastInteractionRequestId).toBeDefined());

      const stream = app.inject({
        method: 'GET',
        url: `/v2/sessions/${sessionId}/events`,
        headers: { ...auth(), 'x-agentdock-responder': '1' },
      });
      await vi.waitFor(() => expect(sessionManager.get(sessionId)?.status).toBe('running'));
      const revoked = await app.inject({
        method: 'PUT',
        url: `/v2/workspaces/${initial.workspaceId}/trust`,
        headers: auth(),
        payload: { cwd, incarnation: initial.incarnation, state: 'untrusted' },
      });

      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(sessionManager.get(sessionId)?.status).toBe('cancelled');
      expect(provider.interactiveResolutions).toEqual([
        expect.objectContaining({
          kind: scenario,
          requestId: provider.lastInteractionRequestId,
          reason: 'trust_revoked',
        }),
      ]);
      const events = (await stream).body
        .split('\n\n')
        .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
        .filter((line): line is string => !!line)
        .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string });
      expect(events.filter((event) => event.type === 'session.cancelled')).toHaveLength(1);
    },
  );
});
