import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_PROVIDER_CAPABILITIES,
  FakeProvider,
  ProviderRegistry,
  noopLogger,
  type Logger,
} from '@agent-dock/agent-runtime';
import { AGENT_DOCK_PROTOCOL_VERSION } from '@agent-dock/shared';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';

const TOKEN = 'test-token-123';

function setup(
  scenario: 'success' | 'failure' | 'hang-until-cancelled' = 'success',
  logger: Logger = noopLogger,
) {
  const registry = new ProviderRegistry();
  registry.register(
    new FakeProvider(
      'claude',
      {
        id: 'claude',
        name: 'Claude Code',
        installed: true,
        authenticated: 'authenticated',
        capabilities: FAKE_PROVIDER_CAPABILITIES,
      },
      scenario,
    ),
  );
  // codex intentionally left unregistered to exercise the "unsupported provider" path.
  const sessionManager = new SessionManager(registry, logger);
  const app = buildServer({ registry, sessionManager, token: TOKEN, logger });
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

  it('reports the protocol version, so a client can check compatibility before using the API', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json().protocolVersion).toBe(AGENT_DOCK_PROTOCOL_VERSION);
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
    const res = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = res.json();
    expect(body.providers).toEqual([
      {
        id: 'claude',
        name: 'Claude Code',
        installed: true,
        authenticated: 'authenticated',
        capabilities: FAKE_PROVIDER_CAPABILITIES,
      },
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

  it('rejects a resume request for a provider whose capabilities.resume is false', async () => {
    // The default `setup()` FakeProvider uses FAKE_PROVIDER_CAPABILITIES, which has resume: false.
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'hi', resumeProviderSessionId: 'prior-thread' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not support resume/);
  });

  it('accepts a resume request for a provider whose capabilities.resume is true, and passes the id through', async () => {
    const registry = new ProviderRegistry();
    const resumableCapabilities = { ...FAKE_PROVIDER_CAPABILITIES, resume: true };
    const provider = new FakeProvider('claude', {
      id: 'claude',
      name: 'Claude Code',
      installed: true,
      authenticated: 'authenticated',
      capabilities: resumableCapabilities,
    });
    registry.register(provider);
    const sessionManager = new SessionManager(registry, noopLogger);
    const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });

    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'hi', resumeProviderSessionId: 'prior-thread' },
    });
    expect(res.statusCode).toBe(201);
    expect(provider.startedOptions.at(-1)?.resumeProviderSessionId).toBe('prior-thread');
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

  it('stamps every event with a monotonic sequence and an ISO timestamp (protocol v1 envelope)', async () => {
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

    const dataLines = res.payload
      .split('\n\n')
      .map((frame) => frame.split('\n').find((line) => line.startsWith('data: ')))
      .filter((line): line is string => !!line)
      .map((line) => JSON.parse(line.slice('data: '.length)));

    expect(dataLines.length).toBeGreaterThan(0);
    dataLines.forEach((event, i) => {
      expect(event.sequence).toBe(i);
      expect(() => new Date(event.timestamp).toISOString()).not.toThrow();
    });
  });

  it('Last-Event-ID resumes the stream from the next sequence, not a full replay (protocol v1 documented behavior)', async () => {
    const { app } = setup('success');
    const createRes = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'hello' },
    });
    const sessionId = createRes.json().id;
    await new Promise((resolve) => setTimeout(resolve, 30));

    function parseFrames(payload: string) {
      return payload
        .split('\n\n')
        .filter((frame) => frame.startsWith('id: '))
        .map((frame) => {
          const idLine = frame.split('\n').find((l) => l.startsWith('id: '));
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          return {
            sequence: Number(idLine?.slice('id: '.length)),
            event: JSON.parse(dataLine?.slice('data: '.length) ?? '{}'),
          };
        });
    }

    // A full, fresh subscription — this is what "the client saw sequence N" is based on.
    const fullRes = await app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}/events`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const fullFrames = parseFrames(fullRes.payload);
    expect(fullFrames.length).toBeGreaterThan(2); // the fake "success" scenario emits several events

    const n = fullFrames[0]!.sequence; // pretend the client got disconnected right after the first event

    // Reconnect with Last-Event-ID: n — must receive n+1 onward, not the full replay again.
    const resumedRes = await app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}/events`,
      headers: { authorization: `Bearer ${TOKEN}`, 'last-event-id': String(n) },
    });
    const resumedFrames = parseFrames(resumedRes.payload);

    expect(resumedFrames.map((f) => f.sequence)).toEqual(
      fullFrames.slice(1).map((f) => f.sequence),
    );
    expect(resumedFrames.every((f) => f.sequence > n)).toBe(true);
    expect(resumedFrames.map((f) => f.event.type)).toEqual(
      fullFrames.slice(1).map((f) => f.event.type),
    );
  });

  it('ends the SSE response cleanly instead of hanging forever if the session is removed between the existence check and subscribe() (AD-11 race)', async () => {
    const { app, sessionManager } = setup('success');
    const createRes = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'hello' },
    });
    const sessionId = createRes.json().id;

    // Simulates losing the race: the existence check (sessionManager.get) inside the route
    // handler passes, but by the time subscribe() runs, the runtime state is already gone.
    const subscribeSpy = vi.spyOn(sessionManager, 'subscribe').mockReturnValueOnce(undefined);

    const res = await app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}/events`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    // The key assertion is that inject() resolved at all (didn't time out) with a real ended
    // response — before the fix, this exact scenario left an already-200'd stream open forever.
    expect(res.statusCode).toBe(200);
    subscribeSpy.mockRestore();
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

  it('404s cancelling a session that already completed, rather than reporting a misleading success (AD-11)', async () => {
    const { app } = setup('success');
    const createRes = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'hello' },
    });
    const sessionId = createRes.json().id;
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the fake "success" scenario finish

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/sessions/${sessionId}/cancel`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cancelRes.statusCode).toBe(404);
  });

  it('POST /sessions/cancel-all cancels every in-flight session and leaves completed ones alone', async () => {
    const { app, sessionManager } = setup('hang-until-cancelled');
    const createRes = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'hello' },
    });
    const sessionId = createRes.json().id;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/cancel-all',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(202);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sessionManager.get(sessionId)?.status).toBe('cancelled');
  });

  it('POST /sessions/cancel-all requires a valid token like every other privileged route', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/sessions/cancel-all' });
    expect(res.statusCode).toBe(401);
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
  it('never writes request-controlled secrets to daemon logs', async () => {
    const entries: unknown[] = [];
    const capture = (message: string, meta?: Record<string, unknown>) => {
      entries.push({ message, meta });
    };
    const logger: Logger = {
      debug: capture,
      info: capture,
      warn: capture,
      error: capture,
    };
    const { app } = setup('success', logger);
    const credentialCanary = 'credential-canary-do-not-log';
    const approvalCanary = 'approval-canary-do-not-log';

    await app.inject({
      method: 'GET',
      url: `/providers?request=${encodeURIComponent(approvalCanary)}`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: `https://${credentialCanary}.example`,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: `{"prompt":"${credentialCanary}"`,
    });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(credentialCanary);
    expect(serialized).not.toContain(approvalCanary);
    expect(serialized).not.toContain(TOKEN);
  });

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
    const res = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an https Origin even with a valid token (AD-04)', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a chrome-extension:// Origin even with a valid token — the exact gap the old http(s)-only check missed (AD-04)', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { authorization: `Bearer ${TOKEN}`, origin: 'chrome-extension://abcdefghijklmnop' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a malformed/unrecognized-scheme Origin rather than letting it fall through unrecognized (AD-04)', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { authorization: `Bearer ${TOKEN}`, origin: 'moz-extension://whatever' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a missing token independently of Origin — omitting Origin does not bypass auth', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/providers' });
    expect(res.statusCode).toBe(401);
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
      payload: {
        provider: 'claude',
        cwd,
        prompt: 'hi',
        executable: '/bin/evil',
        env: { EVIL: '1' },
      },
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

  it("rejects a body over Fastify's default size limit with a sanitized error, not a crash", async () => {
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
