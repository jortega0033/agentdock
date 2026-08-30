import { describe, expect, it, vi } from 'vitest';
import { AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS } from '@agent-dock/shared';
import { AgentDockClient } from '../src/client.js';
import {
  DaemonError,
  ProtocolMismatchError,
  ProviderUnavailableError,
  SessionNotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../src/errors.js';

const BASE_URL = 'http://127.0.0.1:9999';
const TOKEN = 'test-token';
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const EXECUTION_ID = '123e4567-e89b-42d3-a456-426614174001';
const OTHER_SESSION_ID = '123e4567-e89b-42d3-a456-426614174002';

function extensionSummaryEvent(sequence: number, sessionId = SESSION_ID) {
  return {
    type: 'extension.summary',
    sessionId,
    executionId: EXECUTION_ID,
    sequence,
    timestamp: '2026-01-01T00:00:00.000Z',
    extensionName: 'ext.vendor.future_event',
    summary: 'Native event omitted from the normalized stream',
    reason: 'unsupported',
  };
}

function v2EventFrame(
  event: ReturnType<typeof extensionSummaryEvent>,
  id = event.sequence,
): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

function invalidJsonResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => {
      throw new SyntaxError('invalid JSON');
    },
  } as unknown as Response;
}

function healthResponse(supportedProtocolVersions?: number[]): Response {
  return jsonResponse(200, {
    status: 'ok',
    uptimeSeconds: 1,
    protocolVersion: 1,
    ...(supportedProtocolVersions === undefined ? {} : { supportedProtocolVersions }),
  });
}

function sseResponse(frames: string[], status = 200): Response {
  return byteSseResponse(
    frames.map((frame) => new TextEncoder().encode(frame)),
    status,
  );
}

function byteSseResponse(chunks: Uint8Array[], status = 200): Response {
  let index = 0;
  const body = {
    getReader: () => ({
      read: async () => {
        if (index < chunks.length) {
          return { done: false, value: chunks[index++] };
        }
        return { done: true, value: undefined };
      },
      cancel: async () => undefined,
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

function makeClient(fetchImpl: typeof fetch): AgentDockClient {
  return new AgentDockClient({ baseUrl: BASE_URL, token: TOKEN, fetch: fetchImpl });
}

const PROVIDER_V2 = {
  id: 'claude',
  name: 'Claude Code',
  installed: true,
  authenticated: 'authenticated',
  transports: [],
  capabilities: [],
};

const SESSION_V2 = {
  id: SESSION_ID,
  provider: 'claude',
  transport: 'legacy-one-shot',
  cwd: 'C:\\repo',
  status: 'starting',
  selection: {
    transport: 'legacy-one-shot',
    enabled: [],
    unavailableOptional: [],
    possibleEffects: [],
    effectsComplete: true,
  },
  executionId: EXECUTION_ID,
  acceptedWork: 'not_accepted',
  startedAt: '2026-01-01T00:00:00.000Z',
  earliestSequence: 0,
};

describe('AgentDockClient.v2 protocol discovery', () => {
  it('uses v2 when it is the highest shared protocol', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      if (url.endsWith('/v2/providers')) return jsonResponse(200, { providers: [PROVIDER_V2] });
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(makeClient(fetchImpl).v2.providers.list()).resolves.toEqual([PROVIDER_V2]);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/v2/providers'))).toBe(true);
  });

  it('selects by numeric intersection rather than daemon array order', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([2, 1, 99]);
      return jsonResponse(200, { providers: [] });
    });

    await expect(makeClient(fetchImpl).v2.providers.list()).resolves.toEqual([]);
  });

  it('falls back to the legacy scalar for an old v1 daemon and refuses v2 before requesting it', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse();
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(makeClient(fetchImpl).v2.providers.list()).rejects.toBeInstanceOf(
      ProtocolMismatchError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing top-level API on unversioned v1 routes when v2 is advertised', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health'))
        return healthResponse([...AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS]);
      if (url.endsWith('/providers')) return jsonResponse(200, { providers: [] });
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(makeClient(fetchImpl).providers.list()).resolves.toEqual([]);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/v2/providers'))).toBe(false);
  });
});

describe('AgentDockClient.v2 response validation', () => {
  it('creates, reads, cancels, and deletes sessions on the versioned routes', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      if (url.endsWith(`/v2/sessions/${SESSION_ID}/cancel`)) {
        return jsonResponse(202, { status: 'cancelling', sessionId: SESSION_ID });
      }
      if (url.endsWith(`/v2/sessions/${SESSION_ID}`) && init?.method === 'DELETE')
        return jsonResponse(204, undefined);
      if (url.endsWith(`/v2/sessions/${SESSION_ID}`)) return jsonResponse(200, SESSION_V2);
      if (url.endsWith('/v2/sessions') && init?.method === 'POST')
        return jsonResponse(201, SESSION_V2);
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = makeClient(fetchImpl);

    await expect(
      client.v2.sessions.create({
        provider: 'claude',
        cwd: 'C:\\repo',
        prompt: 'Inspect this repository',
      }),
    ).resolves.toEqual(SESSION_V2);
    await expect(client.v2.sessions.get(SESSION_ID)).resolves.toEqual(SESSION_V2);
    await expect(client.v2.sessions.cancel(SESSION_ID)).resolves.toEqual({
      status: 'cancelling',
      sessionId: SESSION_ID,
    });
    await expect(client.v2.sessions.delete(SESSION_ID)).resolves.toBeUndefined();

    const createCall = fetchImpl.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/v2/sessions') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(createCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    });
  });

  it('rejects a malformed provider-list wrapper with ValidationError', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return jsonResponse(200, { providers: 'not-an-array' });
    });

    await expect(makeClient(fetchImpl).v2.providers.list()).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects malformed successful JSON with ValidationError', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return invalidJsonResponse();
    });

    await expect(makeClient(fetchImpl).v2.providers.list()).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects malformed provider and session snapshots with ValidationError', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return jsonResponse(200, { id: 'missing-required-fields' });
    });
    const client = makeClient(fetchImpl);

    await expect(client.v2.providers.get('claude')).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.v2.sessions.get('123e4567-e89b-12d3-a456-426614174000'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an invalid create request locally as ValidationError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(healthResponse([1, 2]));
    const client = makeClient(fetchImpl);

    await expect(
      client.v2.sessions.create({ provider: 'claude', cwd: '', prompt: '' } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/v2/sessions'))).toBe(false);
  });

  it('rejects invalid v2 session identifiers and replay cursors before fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(healthResponse([1, 2]));
    const client = makeClient(fetchImpl);

    await expect(client.v2.sessions.get('not-a-uuid')).rejects.toBeInstanceOf(ValidationError);
    await expect(async () => {
      for await (const _event of client.v2.sessions.events('123e4567-e89b-12d3-a456-426614174000', {
        lastEventId: '-1',
      })) {
        // no-op
      }
    }).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('validates cancellation acknowledgements and delete status codes', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      if (url.endsWith('/cancel')) return jsonResponse(202, { status: 'cancelling' });
      if (init?.method === 'DELETE') return jsonResponse(200, {});
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = makeClient(fetchImpl);

    await expect(
      client.v2.sessions.cancel('123e4567-e89b-12d3-a456-426614174000'),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.v2.sessions.delete('123e4567-e89b-12d3-a456-426614174000'),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a successful event-stream response without a body', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: null,
        json: async () => ({}),
      } as Response;
    });
    const client = makeClient(fetchImpl);

    await expect(async () => {
      for await (const _event of client.v2.sessions.events(
        '123e4567-e89b-12d3-a456-426614174000',
      )) {
        // no-op
      }
    }).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a huge one-chunk v2 SSE frame without buffering the whole chunk', async () => {
    const oversized = `data: ${'x'.repeat(8 * 1024 * 1024)}\n\n`;
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return sseResponse([oversized]);
    });
    const client = makeClient(fetchImpl);

    await expect(async () => {
      for await (const _event of client.v2.sessions.events(
        '123e4567-e89b-12d3-a456-426614174000',
      )) {
        // no-op
      }
    }).rejects.toBeInstanceOf(ValidationError);
  });

  it('accepts a 1 MiB frame when its CRLF separator is split across chunks', async () => {
    const event = extensionSummaryEvent(0);
    const prefix = `id: 0\nevent: ${event.type}\ndata: ${JSON.stringify(event)}`;
    const frame = `${prefix}${' '.repeat(1024 * 1024 - prefix.length)}`;
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return sseResponse([`${frame}\r`, '\n\r\n']);
    });
    const client = makeClient(fetchImpl);

    const collected = [];
    for await (const item of client.v2.sessions.events(SESSION_ID)) collected.push(item);

    expect(collected).toEqual([event]);
  });

  it('rejects an event from another session before yielding it', async () => {
    const event = extensionSummaryEvent(0, OTHER_SESSION_ID);
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return sseResponse([v2EventFrame(event)]);
    });

    await expect(async () => {
      for await (const _event of makeClient(fetchImpl).v2.sessions.events(SESSION_ID)) {
        // no-op
      }
    }).rejects.toMatchObject({
      message: expect.stringContaining(`for session ${OTHER_SESSION_ID}`),
    });
  });

  it.each([
    { name: 'duplicate', sequences: [4, 4], lastEventId: undefined },
    { name: 'out-of-order', sequences: [4, 3], lastEventId: undefined },
    { name: 'replayed duplicate', sequences: [3], lastEventId: '3' },
  ])('rejects $name v2 event sequences', async ({ sequences, lastEventId }) => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return sseResponse(
        sequences.map((sequence) => v2EventFrame(extensionSummaryEvent(sequence))),
      );
    });

    await expect(async () => {
      for await (const _event of makeClient(fetchImpl).v2.sessions.events(SESSION_ID, {
        lastEventId,
      })) {
        // no-op
      }
    }).rejects.toMatchObject({ message: expect.stringContaining('non-monotonic') });
  });

  it.each([
    { name: 'missing', frameId: undefined },
    { name: 'mismatched', frameId: 5 },
  ])('rejects a $name SSE id', async ({ frameId }) => {
    const event = extensionSummaryEvent(4);
    const frame =
      frameId === undefined
        ? `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        : v2EventFrame(event, frameId);
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return sseResponse([frame]);
    });

    await expect(async () => {
      for await (const _event of makeClient(fetchImpl).v2.sessions.events(SESSION_ID)) {
        // no-op
      }
    }).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a valid UTF-8 frame that is truncated before its SSE separator', async () => {
    const event = extensionSummaryEvent(0);
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return sseResponse([`id: 0\nevent: ${event.type}\ndata: ${JSON.stringify(event)}`]);
    });

    await expect(async () => {
      for await (const _event of makeClient(fetchImpl).v2.sessions.events(SESSION_ID)) {
        // no-op
      }
    }).rejects.toMatchObject({ message: expect.stringContaining('unfinished') });
  });

  it('rejects invalid and truncated UTF-8 in v2 streams', async () => {
    const responses = [
      byteSseResponse([
        new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3, 0x28, 0x0a, 0x0a]),
      ]),
      byteSseResponse([new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3])]),
    ];
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return responses.shift()!;
    });
    const client = makeClient(fetchImpl);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failure = await (async () => {
        for await (const _event of client.v2.sessions.events(SESSION_ID)) {
          // no-op
        }
      })().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ValidationError);
      expect(failure).toMatchObject({ message: expect.stringContaining('malformed UTF-8') });
    }
  });

  it('rejects malformed JSON and provider-native event discriminators', async () => {
    const responses = [
      sseResponse(['data: {not-json}\n\n']),
      sseResponse(['data: {"type":"thread.started"}\n\n']),
    ];
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return responses.shift()!;
    });
    const client = makeClient(fetchImpl);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(async () => {
        for await (const _event of client.v2.sessions.events(
          '123e4567-e89b-12d3-a456-426614174000',
        )) {
          // no-op
        }
      }).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('yields a validated extension summary and sends the replay cursor', async () => {
    const event = extensionSummaryEvent(4);
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return sseResponse([
        `:ok\n\nid: 4\nevent: extension.summary\ndata: ${JSON.stringify(event)}\n\n`,
      ]);
    });
    const client = makeClient(fetchImpl);

    const collected = [];
    for await (const item of client.v2.sessions.events(SESSION_ID, { lastEventId: '3' }))
      collected.push(item);

    expect(collected).toEqual([event]);
    const streamCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith(`/v2/sessions/${SESSION_ID}/events`),
    );
    expect((streamCall?.[1] as RequestInit).headers).toMatchObject({ 'Last-Event-ID': '3' });
  });
});

describe('AgentDockClient.v2 error mapping', () => {
  it('retains typed 401 and provider/session 404 errors', async () => {
    const status = new Map<string, number>([
      ['/v2/providers', 401],
      ['/v2/providers/claude', 404],
      ['/v2/sessions/123e4567-e89b-12d3-a456-426614174000', 404],
    ]);
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      const code = [...status].find(([suffix]) => url.endsWith(suffix))?.[1] ?? 500;
      return jsonResponse(code, { error: 'rejected' });
    });
    const client = makeClient(fetchImpl);

    await expect(client.v2.providers.list()).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(client.v2.providers.get('claude')).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(
      client.v2.sessions.get('123e4567-e89b-12d3-a456-426614174000'),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it.each([413, 409, 422, 429])('preserves daemon status %i', async (status) => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return jsonResponse(status, { error: { code: 'rejected', message: 'request rejected' } });
    });

    const failure = await makeClient(fetchImpl)
      .v2.providers.list()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DaemonError);
    expect(failure).toMatchObject({ status });
  });
});
