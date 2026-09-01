import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServerDescriptorV2 } from '@agent-dock/shared';
import {
  FakeProvider,
  InMemoryProviderMcpControlPlane,
  ProviderRegistry,
  noopLogger,
} from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { resolveWorkspaceIdentity } from '../src/workspace-identity.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';

const TOKEN = 'mcp-test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const apps: Array<ReturnType<typeof buildServer>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-dock-mcp-route-'));
  const trustStore = new WorkspaceTrustStore(join(cwd, 'trust.json'));
  await trustStore.setTrusted(await resolveWorkspaceIdentity(cwd));
  const descriptor: McpServerDescriptorV2 = {
    id: 'fixture', provider: 'claude', name: 'Fixture', ownership: 'project', scope: 'project',
    transport: 'stdio', enabled: true, required: false, connectionStatus: 'ready', authStatus: 'authenticated',
    catalog: { tools: 1, resources: 0, prompts: 0 },
    capabilities: { connect: true, reload: true, configure: true, oauth: true, tools: true, resources: false, prompts: false },
    configFields: [{ key: 'command', classification: 'public', present: true, source: 'project', value: 'fixture-command' }],
    sessionIds: [],
  };
  const control = new InMemoryProviderMcpControlPlane('claude', {
    servers: [descriptor],
    catalogs: [{ serverId: 'fixture', revision: 'fixture-1', items: [{ kind: 'tool', id: 'delete_record', name: 'Delete record', destructive: true, sideEffecting: true }] }],
    oauth: { fixture: { serverId: 'fixture', status: 'pending', authorizationUrl: 'https://login.example.test/authorize' } },
  });
  const provider = new FakeProvider('claude', undefined, 'success', undefined, control);
  const registry = new ProviderRegistry();
  registry.register(provider);
  const sessionManager = new SessionManager(registry, noopLogger);
  const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger, trustStore });
  apps.push(app);
  return { app, cwd };
}

describe('protocol-v2 MCP routes', () => {
  it('lists normalized ownership and never leaks provider secrets', async () => {
    const { app, cwd } = await setup();
    const response = await app.inject({ method: 'GET', url: `/v2/integrations/mcp?provider=claude&cwd=${encodeURIComponent(cwd)}`, headers: auth });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().servers[0]).toMatchObject({ id: 'fixture', provider: 'claude', ownership: 'project' });
    expect(response.body).not.toContain('token');
  });

  it('requires a bound one-time approval for destructive tools', async () => {
    const { app, cwd } = await setup();
    const input = { provider: 'claude', cwd, serverId: 'fixture', toolId: 'delete_record', arguments: {} };
    const first = await app.inject({ method: 'POST', url: '/v2/integrations/mcp/invoke', headers: { ...auth, 'content-type': 'application/json' }, payload: input });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().status).toBe('approval_required');
    const tampered = await app.inject({ method: 'POST', url: '/v2/integrations/mcp/invoke', headers: { ...auth, 'content-type': 'application/json' }, payload: { ...input, arguments: { recordId: 'different' }, approval: { decision: 'approve_once', requestId: first.json().approvalRequestId } } });
    expect(tampered.statusCode).toBe(409);
    const second = await app.inject({ method: 'POST', url: '/v2/integrations/mcp/invoke', headers: { ...auth, 'content-type': 'application/json' }, payload: input });
    const approved = await app.inject({ method: 'POST', url: '/v2/integrations/mcp/invoke', headers: { ...auth, 'content-type': 'application/json' }, payload: { ...input, approval: { decision: 'approve_once', requestId: second.json().approvalRequestId } } });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'completed', output: { ok: true } });
    const replay = await app.inject({ method: 'POST', url: '/v2/integrations/mcp/invoke', headers: { ...auth, 'content-type': 'application/json' }, payload: { ...input, approval: { decision: 'approve_once', requestId: second.json().approvalRequestId } } });
    expect(replay.statusCode).toBe(409);
  });

  it('rejects unknown identifiers and renderer-supplied secret fields', async () => {
    const { app, cwd } = await setup();
    const unknown = await app.inject({ method: 'POST', url: '/v2/integrations/mcp/action', headers: { ...auth, 'content-type': 'application/json' }, payload: { provider: 'claude', cwd, serverId: 'arbitrary', action: 'reload' } });
    expect(unknown.statusCode).toBe(404);
    const secret = await app.inject({ method: 'POST', url: '/v2/integrations/mcp/configure', headers: { ...auth, 'content-type': 'application/json' }, payload: { provider: 'claude', cwd, action: 'add', name: 'evil', scope: 'project', config: { transport: 'streamable_http', url: 'https://example.test', headers: { Authorization: 'secret' } } } });
    expect(secret.statusCode).toBe(400);
  });

  it('returns only a validated token-opaque OAuth status', async () => {
    const { app, cwd } = await setup();
    const response = await app.inject({ method: 'POST', url: '/v2/integrations/mcp/oauth', headers: { ...auth, 'content-type': 'application/json' }, payload: { provider: 'claude', cwd, serverId: 'fixture' } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ serverId: 'fixture', status: 'pending', authorizationUrl: 'https://login.example.test/authorize' });
  });
});
