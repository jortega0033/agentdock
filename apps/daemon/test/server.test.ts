import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeProvider, ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';

const TOKEN = 'test-token-123';

function setup(scenario: 'success' | 'failure' | 'hang-until-cancelled' = 'success') {
  const registry = new ProviderRegistry();
  registry.register(
    new FakeProvider('claude', { id: 'claude', name: 'Claude Code', installed: true, authenticated: true }, scenario),
  );
  // codex intentionally left unregistered to exercise the "unsupported provider" path.
  const sessionManager = new SessionManager(registry, noopLogger);
  const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });
  return { app, registry, sessionManager };
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-daemon-test-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('GET /health', () => {
  it('responds without requiring auth', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });
});

describe('authorization', () => {
  it('rejects privileged routes without a token', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/providers' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects privileged routes with the wrong token', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests from a disallowed browser origin even with a valid token', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { authorization: `Bearer ${TOKEN}`, origin: 'http://evil.example' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts privileged routes with the correct token', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /providers', () => {
  it('reports installed/authenticated status for registered providers', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/providers', headers: { authorization: `Bearer ${TOKEN}` } });
    const body = res.json();
    expect(body.providers).toEqual([
      { id: 'claude', name: 'Claude Code', installed: true, authenticated: true },
    ]);
  });

  it('404s for an unregistered but validly-shaped provider id', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/providers/codex',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s for a nonsense provider id', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/providers/not-a-provider',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /sessions', () => {
  it('rejects an invalid body', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a provider that is not registered', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'codex', cwd, prompt: 'hi' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unsupported provider/);
  });

  it('rejects a nonexistent working directory', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd: join(cwd, 'nope'), prompt: 'hi' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a session and lets it run to completion', async () => {
    const { app } = setup('success');
    const createRes = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'hello' },
    });
    expect(createRes.statusCode).toBe(201);
    const session = createRes.json();
    expect(['starting', 'running']).toContain(session.status);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const getRes = await app.inject({
      method: 'GET',
      url: `/sessions/${session.id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(getRes.json().status).toBe('completed');
  });

  it('404s when fetching an unknown session', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/sessions/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('SSE events + cancellation', () => {
  it('streams normalized events and ends the stream at session.completed', async () => {
    const { app } = setup('success');
    const createRes = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'hello' },
    });
    const sessionId = createRes.json().id;

    await new Promise((resolve) => setTimeout(resolve, 30));

    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}/events`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.payload).toContain('event: session.started');
    expect(res.payload).toContain('event: session.completed');
  });

  it('cancels a running session', async () => {
    const { app, sessionManager } = setup('hang-until-cancelled');
    const createRes = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'hello' },
    });
    const sessionId = createRes.json().id;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/cancel`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cancelRes.statusCode).toBe(202);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionManager.get(sessionId)?.status).toBe('cancelled');
  });

  it('404s cancelling an unknown session', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/00000000-0000-0000-0000-000000000000/cancel',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /sessions/:id', () => {
  it('removes a completed session', async () => {
    const { app } = setup('success');
    const createRes = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'hello' },
    });
    const sessionId = createRes.json().id;
    await new Promise((resolve) => setTimeout(resolve, 30));

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(delRes.statusCode).toBe(204);

    const getRes = await app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(getRes.statusCode).toBe(404);
  });
});

describe('adversarial input handling', () => {
  it('rejects Origin: null (sandboxed iframe / file:// context) on a privileged route', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { authorization: `Bearer ${TOKEN}`, origin: 'null' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not block a request with no Origin header at all (non-browser clients: curl, Electron main process)', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/providers', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a simple cross-origin POST with no auth header even with a browser-safelisted Content-Type (the no-preflight CSRF vector)', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { origin: 'http://evil.example', 'content-type': 'text/plain' },
      payload: JSON.stringify({ provider: 'claude', cwd, prompt: 'pwned' }),
    });
    // Must fail closed regardless of *why* — Origin check and/or auth check, either is correct —
    // but it must never reach session creation.
    expect(res.statusCode).not.toBe(201);
    expect([401, 403]).toContain(res.statusCode);
  });

  it('returns a sanitized 400 for malformed JSON, not a stack trace', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: '{not valid json',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBeTypeOf('string');
    expect(JSON.stringify(body)).not.toMatch(/at Object|node_modules|\.ts:\d+/);
  });

  it('rejects an unknown field-shaped but wrong-typed body (cwd as a number) with 400, not a crash', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd: 12345, prompt: 'hi' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('ignores unknown extra fields in the body rather than erroring or forwarding them', async () => {
    const { app } = setup('success');
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'hi', executable: '/bin/evil', env: { EVIL: '1' } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty('executable');
  });

  it('404s an unsupported HTTP method on a known path instead of crashing', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'PUT',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'hi' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a prompt over the schema size cap with 400', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'x'.repeat(200_001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a body over Fastify\'s default size limit with a sanitized error, not a crash', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ provider: 'claude', cwd, prompt: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(() => res.json()).not.toThrow();
  });

  it('never leaks the daemon token back in any response body', async () => {
    const { app } = setup('success');
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'hi' },
    });
    expect(res.payload).not.toContain(TOKEN);
  });
});
