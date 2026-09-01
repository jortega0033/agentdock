import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeProvider, ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { agentSessionV2Schema } from '@agent-dock/shared';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';
import { resolveWorkspaceIdentity } from '../src/workspace-identity.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';

const TOKEN = 'workspace-lease-token';
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-workspace-lease-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('v2 workspace execution leases', () => {
  it('rejects a canonical-path mutation conflict before a second provider dispatch and releases on terminal', async () => {
    execFileSync('git', ['init', '-b', 'lease-test', cwd], { windowsHide: true });
    const registry = new ProviderRegistry();
    const provider = new FakeProvider('claude', undefined, 'success', 'multi-input');
    const support = provider.getV2Support(await provider.detect());
    if (!support) throw new Error('fake provider did not expose v2 support');
    vi.spyOn(provider, 'getV2Support').mockReturnValue({
      transports: support.transports.map((transport) => ({
        ...transport,
        possibleEffects: ['command'],
      })),
      capabilities: support.capabilities.map((capability) => ({
        ...capability,
        scope: { ...capability.scope, trustState: 'trusted' },
        prerequisites: { ...capability.prerequisites, trustStates: ['trusted'] },
      })),
    });
    const start = vi.spyOn(provider, 'startInteractiveSession');
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
    const payload = {
      provider: 'claude',
      cwd,
      prompt: 'mutate safely',
      capabilities: {
        required: [{ id: 'session.cancel' }],
        optional: [],
        allowExperimental: false,
      },
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload,
    });
    expect(first.statusCode, first.body).toBe(201);
    const firstSession = agentSessionV2Schema.parse(first.json());
    expect(firstSession.branch).toBe('lease-test');
    expect(firstSession.selection.possibleEffects).toContain('command');

    const conflict = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload: { ...payload, cwd: join(cwd, '.') },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'workspace_execution_conflict' });
    expect(start).toHaveBeenCalledTimes(1);

    const cancelled = await app.inject({
      method: 'POST',
      url: `/v2/sessions/${firstSession.id}/cancel`,
      headers: auth(),
    });
    expect(cancelled.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const snapshot = await app.inject({
        method: 'GET',
        url: `/v2/sessions/${firstSession.id}`,
        headers: auth(),
      });
      expect(agentSessionV2Schema.parse(snapshot.json()).status).toBe('cancelled');
    });

    const afterRelease = await app.inject({
      method: 'POST',
      url: '/v2/sessions',
      headers: auth(),
      payload,
    });
    expect(afterRelease.statusCode, afterRelease.body).toBe(201);
    expect(start).toHaveBeenCalledTimes(2);

    const userFile = join(cwd, 'uncommitted-user-work.txt');
    writeFileSync(userFile, 'preserve me', 'utf8');
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v2/sessions/${firstSession.id}`,
      headers: auth(),
    });
    expect(deleted.statusCode).toBe(204);
    expect(readFileSync(userFile, 'utf8')).toBe('preserve me');

    sessionManager.beginShutdown();
    await sessionManager.cancelAll();
    await app.close();
  }, 15_000);
});

function auth(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}
