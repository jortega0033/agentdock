import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeProvider,
  FilesystemProviderComponentControlPlane,
  ProviderRegistry,
  noopLogger,
} from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { resolveWorkspaceIdentity } from '../src/workspace-identity.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';

const TOKEN = 'component-token';
const apps: Array<ReturnType<typeof buildServer>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('protocol-v2 provider component routes', () => {
  it('keeps untrusted project content inspectable but non-executable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-dock-components-route-'));
    const skill = join(cwd, '.claude', 'skills', 'danger');
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: Danger\nuser-invocable: true\n---\ncommand: never-run',
    );
    const components = new FilesystemProviderComponentControlPlane('claude');
    const provider = new FakeProvider(
      'claude',
      undefined,
      'success',
      undefined,
      undefined,
      components,
    );
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessions = new SessionManager(registry, noopLogger);
    const trustStore = new WorkspaceTrustStore(join(cwd, 'trust.json'));
    const app = buildServer({
      registry,
      sessionManager: sessions,
      trustStore,
      token: TOKEN,
      logger: noopLogger,
    });
    apps.push(app);
    const headers = { authorization: `Bearer ${TOKEN}` };
    const list = await app.inject({
      method: 'GET',
      url: `/v2/integrations/components?provider=claude&cwd=${encodeURIComponent(cwd)}&kind=skill`,
      headers,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items[0]).toMatchObject({
      enabled: false,
      trusted: false,
      supportsDirectInvoke: false,
      capabilities: ['manifest_direct_invoke'],
    });
    const invoke = await app.inject({
      method: 'POST',
      url: '/v2/integrations/components/invoke',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { provider: 'claude', cwd, componentId: 'project/skill/danger' },
    });
    expect(invoke.statusCode).toBe(403);
  });

  it('dispatches a real, supported manage operation end to end and rejects an unsupported one', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-dock-components-manage-route-'));
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash' }] } }),
    );
    await mkdir(join(cwd, '.claude', 'skills', 'review'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: Review\n---\n');
    const components = new FilesystemProviderComponentControlPlane('claude');
    const provider = new FakeProvider('claude', undefined, 'success', undefined, undefined, components);
    const registry = new ProviderRegistry();
    registry.register(provider);
    const sessions = new SessionManager(registry, noopLogger);
    const trustStore = new WorkspaceTrustStore(join(cwd, 'trust.json'));
    const identity = await resolveWorkspaceIdentity(cwd);
    await trustStore.setTrusted(identity);
    const app = buildServer({
      registry,
      sessionManager: sessions,
      trustStore,
      token: TOKEN,
      logger: noopLogger,
    });
    apps.push(app);
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

    // The route itself decides "unsupported" from a fresh descriptor before ever calling the
    // plane's manage() -- a skill has no registered handler, so this must never mutate anything.
    const unsupported = await app.inject({
      method: 'POST',
      url: '/v2/integrations/components/manage',
      headers,
      payload: { provider: 'claude', cwd, componentId: 'project/skill/review', action: 'disable' },
    });
    expect(unsupported.statusCode, unsupported.body).toBe(200);
    expect(unsupported.json().status).toBe('unsupported');

    // A hook lifecycle is the one real, provider-native operation this slice supports.
    const disable = await app.inject({
      method: 'POST',
      url: '/v2/integrations/components/manage',
      headers,
      payload: { provider: 'claude', cwd, componentId: 'project/hook/PreToolUse', action: 'disable' },
    });
    expect(disable.statusCode, disable.body).toBe(200);
    expect(disable.json()).toMatchObject({ componentId: 'project/hook/PreToolUse', status: 'disabled' });

    const settings = JSON.parse(await readFile(join(cwd, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse).toBeUndefined();
  });
});
