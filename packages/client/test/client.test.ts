import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_DOCK_PROTOCOL_VERSION,
  AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS,
  type AgentEventEnvelope,
} from '@agent-dock/shared';
import { AgentDockClient } from '../src/client.js';
import {
  DaemonError,
  DaemonUnavailableError,
  ProtocolMismatchError,
  ProviderUnavailableError,
  SessionNotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../src/errors.js';

const BASE_URL = 'http://127.0.0.1:9999';
const TOKEN = 'test-token';

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(extraHeaders),
    json: async () => body,
  } as Response;
}

function healthOk(protocolVersion = AGENT_DOCK_PROTOCOL_VERSION) {
  return jsonResponse(200, { status: 'ok', uptimeSeconds: 1, protocolVersion });
}

const CAPS = { resume: true, cancellation: true, tools: true, usage: true, thinking: true };

function makeClient(fetchImpl: typeof fetch) {
  return new AgentDockClient({ baseUrl: BASE_URL, token: TOKEN, fetch: fetchImpl });
}

/** Builds a fake `Response` whose `.body` streams the given SSE frames. */
function sseResponse(frames: string[], status = 200) {
  let i = 0;
  const body = {
    getReader: () => ({
      read: async () => {
        if (i < frames.length) {
          return { done: false, value: new TextEncoder().encode(frames[i++]) };
        }
        return { done: true, value: undefined };
      },
    }),
  } as unknown as ReadableStream<Uint8Array>;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    body,
    json: async () => ({}),
  } as Response;
}

describe('AgentDockClient — health / protocol compatibility', () => {
  it('resolves health() when the daemon reports a matching protocol version', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(healthOk());
    const client = makeClient(fetchImpl);
    await expect(client.health()).resolves.toMatchObject({
      status: 'ok',
      protocolVersion: AGENT_DOCK_PROTOCOL_VERSION,
    });
  });

  it('throws ProtocolMismatchError when the daemon reports a different protocol version', async () => {
    const unsupportedVersion = Math.max(...AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS) + 1;
    const fetchImpl = vi.fn().mockResolvedValue(healthOk(unsupportedVersion));
    const client = makeClient(fetchImpl);
    await expect(client.health()).rejects.toBeInstanceOf(ProtocolMismatchError);
  });

  it('runs the compatibility check automatically before any other method, not just health()', async () => {
    const unsupportedVersion = Math.max(...AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS) + 1;
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk(unsupportedVersion);
      return jsonResponse(200, { providers: [] });
    });
    const client = makeClient(fetchImpl);
    await expect(client.providers.list()).rejects.toBeInstanceOf(ProtocolMismatchError);
  });

  it('caches a successful compatibility check across calls (does not re-check every request)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return jsonResponse(200, { providers: [] });
    });
    const client = makeClient(fetchImpl);
    await client.providers.list();
    await client.providers.list();
    const healthCalls = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/health'));
    expect(healthCalls).toHaveLength(1);
  });

  it('retries the compatibility check on the next call after a transient failure', async () => {
    let attempt = 0;
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) {
        attempt++;
        if (attempt === 1) throw new Error('ECONNREFUSED');
        return healthOk();
      }
      return jsonResponse(200, { providers: [] });
    });
    const client = makeClient(fetchImpl);
    await expect(client.health()).rejects.toBeInstanceOf(DaemonUnavailableError);
    await expect(client.health()).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('AgentDockClient — transport and auth errors', () => {
  it('throws DaemonUnavailableError when fetch itself rejects (connection refused)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const client = makeClient(fetchImpl);
    await expect(client.health()).rejects.toBeInstanceOf(DaemonUnavailableError);
  });

  it('throws UnauthorizedError on a 401', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return jsonResponse(401, { error: 'unauthorized' });
    });
    const client = makeClient(fetchImpl);
    await expect(client.providers.list()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('sends the bearer token on every non-health request', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return jsonResponse(200, { providers: [] });
    });
    const client = makeClient(fetchImpl);
    await client.providers.list();
    const [, init] = fetchImpl.mock.calls.find(([url]) => String(url).endsWith('/providers'))!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });

  it('never puts the token in the URL', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return jsonResponse(200, { providers: [] });
    });
    const client = makeClient(fetchImpl);
    await client.providers.list();
    for (const [url] of fetchImpl.mock.calls) {
      expect(String(url)).not.toContain(TOKEN);
    }
  });
});

describe('AgentDockClient — providers', () => {
  it('lists providers', async () => {
    const provider = {
      id: 'claude',
      name: 'Claude Code',
      installed: true,
      authenticated: 'authenticated',
      capabilities: CAPS,
    };
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      if (url.endsWith('/providers')) return jsonResponse(200, { providers: [provider] });
      throw new Error(`unexpected url: ${url}`);
    });
    const client = makeClient(fetchImpl);
    await expect(client.providers.list()).resolves.toEqual([provider]);
  });

  it('throws ProviderUnavailableError for a 404 on providers.get', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return jsonResponse(404, { error: 'provider not registered' });
    });
    const client = makeClient(fetchImpl);
    await expect(client.providers.get('codex')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('throws ValidationError when the daemon returns a provider status that fails schema validation', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return jsonResponse(200, { providers: [{ id: 'claude' }] }); // missing required fields
    });
    const client = makeClient(fetchImpl);
    await expect(client.providers.list()).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('AgentDockClient — sessions', () => {
  const session = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    provider: 'claude',
    cwd: '/tmp',
    prompt: 'hi',
    status: 'starting',
    startedAt: new Date().toISOString(),
  };

  it('creates a session', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      if (url.endsWith('/sessions')) return jsonResponse(201, session);
      throw new Error(`unexpected url: ${url}`);
    });
    const client = makeClient(fetchImpl);
    await expect(
      client.sessions.create({ provider: 'claude', cwd: '/tmp', prompt: 'hi' }),
    ).resolves.toEqual(session);
  });

  it('rejects client-side before making a request when the input is invalid', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(healthOk());
    const client = makeClient(fetchImpl);
    await expect(
      client.sessions.create({ provider: 'claude', cwd: '', prompt: 'hi' } as never),
    ).rejects.toThrow();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/sessions'))).toBe(false);
  });

  it('throws SessionNotFoundError for a 404 on sessions.get', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return jsonResponse(404, { error: 'session not found' });
    });
    const client = makeClient(fetchImpl);
    await expect(client.sessions.get('missing')).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('throws SessionNotFoundError for a 404 on sessions.cancel and sessions.delete', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return jsonResponse(404, { error: 'session not found' });
    });
    const client = makeClient(fetchImpl);
    await expect(client.sessions.cancel('missing')).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(client.sessions.delete('missing')).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('throws ValidationError for a 400 daemon-declared failure (e.g. bad cwd)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return jsonResponse(400, { error: 'working directory does not exist' });
    });
    const client = makeClient(fetchImpl);
    await expect(
      client.sessions.create({ provider: 'claude', cwd: '/nope', prompt: 'hi' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws DaemonError for an unexpected 5xx', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return jsonResponse(500, { error: 'internal server error' });
    });
    const client = makeClient(fetchImpl);
    await expect(client.sessions.get('any')).rejects.toBeInstanceOf(DaemonError);
  });
});

describe('AgentDockClient — SSE event streaming', () => {
  it('yields validated events and ends the iteration at the terminal event', async () => {
    const frames = [
      `data: ${JSON.stringify({ type: 'session.started', sessionId: 's1', provider: 'claude', sequence: 0, timestamp: '2026-01-01T00:00:00.000Z' })}\n\n`,
      `data: ${JSON.stringify({ type: 'assistant.message', text: 'hi', sequence: 1, timestamp: '2026-01-01T00:00:01.000Z' })}\n\n`,
      `data: ${JSON.stringify({ type: 'session.completed', sequence: 2, timestamp: '2026-01-01T00:00:02.000Z' })}\n\n`,
    ];
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      if (url.endsWith('/events')) return sseResponse(frames);
      throw new Error(`unexpected url: ${url}`);
    });
    const client = makeClient(fetchImpl);

    const collected = [];
    for await (const event of client.sessions.events('s1')) collected.push(event);

    expect(collected).toHaveLength(3);
    expect(collected[0]).toMatchObject({ type: 'session.started', sequence: 0 });
    expect(collected.at(-1)).toMatchObject({ type: 'session.completed', sequence: 2 });
  });

  it('tolerates one SSE frame split across two chunks', async () => {
    const full = `data: ${JSON.stringify({ type: 'session.cancelled', sequence: 0, timestamp: '2026-01-01T00:00:00.000Z' })}\n\n`;
    const mid = Math.floor(full.length / 2);
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return sseResponse([full.slice(0, mid), full.slice(mid)]);
    });
    const client = makeClient(fetchImpl);

    const collected = [];
    for await (const event of client.sessions.events('s1')) collected.push(event);
    expect(collected).toEqual([
      { type: 'session.cancelled', sequence: 0, timestamp: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('throws ValidationError on a malformed event and stops iterating', async () => {
    const frames = [
      `data: ${JSON.stringify({ type: 'session.started', sessionId: 's1', provider: 'claude', sequence: 0, timestamp: '2026-01-01T00:00:00.000Z' })}\n\n`,
      `data: {"type":"not-a-real-event-type","sequence":1,"timestamp":"2026-01-01T00:00:01.000Z"}\n\n`,
    ];
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return sseResponse(frames);
    });
    const client = makeClient(fetchImpl);

    const collected: AgentEventEnvelope[] = [];
    await expect(
      (async () => {
        for await (const event of client.sessions.events('s1')) collected.push(event);
      })(),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(collected).toHaveLength(1); // the one valid event before the malformed one
  });

  it('throws ValidationError on an SSE frame over the 1 MiB v1 frame ceiling', async () => {
    const oversized = `data: ${JSON.stringify({
      type: 'assistant.message',
      text: 'x'.repeat(2 * 1024 * 1024),
      sequence: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
    })}\n\n`;
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return sseResponse([oversized]);
    });
    const client = makeClient(fetchImpl);

    await expect(async () => {
      for await (const _event of client.sessions.events('s1')) {
        // no-op
      }
    }).rejects.toThrow(/larger than the 1048576-byte/);
  });

  it('throws SessionNotFoundError when opening the stream for an unknown session', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthOk();
      return jsonResponse(404, { error: 'session not found' });
    });
    const client = makeClient(fetchImpl);
    await expect(async () => {
      for await (const _event of client.sessions.events('missing')) {
        // no-op
      }
    }).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('stops iterating without error when the caller aborts via AbortSignal', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) return healthOk();
      if (init?.signal?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      // Never resolves on its own — only aborting ends this.
      return new Promise<Response>(() => {});
    });
    const client = makeClient(fetchImpl);

    controller.abort();
    const collected = [];
    for await (const event of client.sessions.events('s1', { signal: controller.signal }))
      collected.push(event);
    expect(collected).toEqual([]);
  });
});
