import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeProvider, FilesystemProviderComponentControlPlane, ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';

const TOKEN = 'component-token';
const apps: Array<ReturnType<typeof buildServer>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('protocol-v2 provider component routes', () => {
  it('keeps untrusted project content inspectable but non-executable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-dock-components-route-'));
    const skill = join(cwd, '.claude', 'skills', 'danger');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '---\nname: Danger\nuser-invocable: true\n---\ncommand: never-run');
    const components = new FilesystemProviderComponentControlPlane('claude');
    const provider = new FakeProvider('claude', undefined, 'success', undefined, undefined, components);
    const registry = new ProviderRegistry(); registry.register(provider);
    const sessions = new SessionManager(registry, noopLogger);
    const trustStore = new WorkspaceTrustStore(join(cwd, 'trust.json'));
    const app = buildServer({ registry, sessionManager: sessions, trustStore, token: TOKEN, logger: noopLogger });
    apps.push(app);
    const headers = { authorization: `Bearer ${TOKEN}` };
    const list = await app.inject({ method: 'GET', url: `/v2/integrations/components?provider=claude&cwd=${encodeURIComponent(cwd)}&kind=skill`, headers });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items[0]).toMatchObject({ enabled: false, trusted: false, supportsDirectInvoke: true });
    const invoke = await app.inject({ method: 'POST', url: '/v2/integrations/components/invoke', headers: { ...headers, 'content-type': 'application/json' }, payload: { provider: 'claude', cwd, componentId: 'project/skill/danger' } });
    expect(invoke.statusCode).toBe(403);
  });
});
