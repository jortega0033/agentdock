import { describe, expect, it, vi } from 'vitest';
import { AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS } from '@agent-dock/shared';
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
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const EXECUTION_ID = '123e4567-e89b-42d3-a456-426614174001';
const OTHER_SESSION_ID = '123e4567-e89b-42d3-a456-426614174002';
const TURN_ID = '123e4567-e89b-42d3-a456-426614174003';
const COMMAND_ID = '123e4567-e89b-42d3-a456-426614174004';

const COMMAND_V2 = {
  type: 'session.interrupt',
  commandId: COMMAND_ID,
  sessionId: SESSION_ID,
  turnId: TURN_ID,
} as const;

const COMMAND_ACKNOWLEDGEMENT_V2 = {
  status: 'accepted',
  commandId: COMMAND_ID,
  sessionId: SESSION_ID,
  turnId: TURN_ID,
} as const;

const WORKSPACE_ID = 'a'.repeat(64);
const WORKSPACE_INCARNATION = 'b'.repeat(64);
const WORKSPACE_TRUST_VIEW = {
  schemaVersion: 1,
  workspaceId: WORKSPACE_ID,
  incarnation: WORKSPACE_INCARNATION,
  displayName: 'workspace',
  reusable: true,
  state: 'untrusted',
} as const;

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
  sandbox: {
    providerId: 'claude',
    platform: 'win32',
    provider: { mechanism: 'provider_policy', state: 'unknown', evidence: [] },
    agentDock: { mechanism: 'agentdock_policy', state: 'not_requested', evidence: [] },
    os: { mechanism: 'os_sandbox', state: 'unavailable', evidence: [] },
    badge: 'none',
  },
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

const SESSION_PAGE_V2 = { sessions: [SESSION_V2], nextCursor: 'page_2' };
const SESSION_HISTORY_PAGE_V2 = {
  events: [extensionSummaryEvent(0)],
  nextCursor: 'page_2',
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

describe('AgentDockClient.v2 MCP control', () => {
  it('uses fixed versioned routes and validates configuration before IPC-facing callers can send it', async () => {
    const list = { servers: [], revision: 'mcp-1' };
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      if (url.includes('/v2/integrations/mcp')) return jsonResponse(200, list);
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = makeClient(fetchImpl);
    await expect(client.v2.integrations.mcp.list('codex', 'C:\\repo')).resolves.toEqual(list);
    await expect(client.v2.integrations.mcp.configure({
      provider: 'codex', cwd: 'C:\\repo', action: 'add', name: 'docs', scope: 'user',
      config: { transport: 'streamable_http', url: 'https://mcp.example.test' },
    })).resolves.toEqual(list);
    await expect(client.v2.integrations.mcp.configure({
      provider: 'codex', cwd: 'C:\\repo', action: 'add', name: 'unsafe', scope: 'user',
      config: { transport: 'streamable_http', url: 'http://mcp.example.test' },
    })).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
    });
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
    const requestController = new AbortController();

    await expect(
      client.v2.sessions.create(
        {
          provider: 'claude',
          cwd: 'C:\\repo',
          prompt: 'Inspect this repository',
        },
        { signal: requestController.signal },
      ),
    ).resolves.toEqual(SESSION_V2);
    await expect(client.v2.sessions.get(SESSION_ID)).resolves.toEqual(SESSION_V2);
    await expect(
      client.v2.sessions.cancel(SESSION_ID, { signal: requestController.signal }),
    ).resolves.toEqual({
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
      signal: requestController.signal,
    });
    const cancelCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith(`/v2/sessions/${SESSION_ID}/cancel`),
    );
    expect(cancelCall?.[1]).toMatchObject({ signal: requestController.signal });
  });

  it('lists persisted sessions, reads paginated history, and starts daemon-owned continuations', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      if (url.endsWith('/v2/sessions?cursor=page_1&limit=25'))
        return jsonResponse(200, SESSION_PAGE_V2);
      if (url.endsWith(`/v2/sessions/${SESSION_ID}/history?limit=25`))
        return jsonResponse(200, SESSION_HISTORY_PAGE_V2);
      if (
        (url.endsWith(`/v2/sessions/${SESSION_ID}/resume`) ||
          url.endsWith(`/v2/sessions/${SESSION_ID}/fork`)) &&
        init?.method === 'POST'
      ) {
        return jsonResponse(201, SESSION_V2);
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    const client = makeClient(fetchImpl);

    await expect(client.v2.sessions.list({ cursor: 'page_1', limit: 25 })).resolves.toEqual(
      SESSION_PAGE_V2,
    );
    await expect(client.v2.sessions.history(SESSION_ID, { limit: 25 })).resolves.toEqual(
      SESSION_HISTORY_PAGE_V2,
    );
    await expect(client.v2.sessions.resume(SESSION_ID, { prompt: 'continue' })).resolves.toEqual(
      SESSION_V2,
    );
    await expect(client.v2.sessions.fork(SESSION_ID, { prompt: 'branch' })).resolves.toEqual(
      SESSION_V2,
    );

    const resumeCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith(`/v2/sessions/${SESSION_ID}/resume`),
    );
    expect(JSON.parse((resumeCall?.[1] as RequestInit).body as string)).toEqual({
      prompt: 'continue',
    });
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('providerSessionId'))).toBe(
      false,
    );
  });

  it('sends a validated command on the authenticated versioned route', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      if (url.endsWith(`/v2/sessions/${SESSION_ID}/commands`)) {
        return jsonResponse(202, COMMAND_ACKNOWLEDGEMENT_V2);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    await expect(makeClient(fetchImpl).v2.sessions.send(COMMAND_V2)).resolves.toEqual(
      COMMAND_ACKNOWLEDGEMENT_V2,
    );

    const commandCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith(`/v2/sessions/${SESSION_ID}/commands`),
    );
    expect(commandCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    });
    expect(JSON.parse(String((commandCall?.[1] as RequestInit).body))).toEqual(COMMAND_V2);
  });

  it('keeps the responder lease private and attaches it only to interaction responses', async () => {
    const responderLease = 'L'.repeat(43);
    const requestId = '123e4567-e89b-42d3-a456-426614174005';
    const approvalCommand = {
      type: 'approval.respond' as const,
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      requestId,
      decision: 'deny' as const,
    };
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      if (url.endsWith(`/v2/sessions/${SESSION_ID}/events`)) {
        const response = sseResponse([v2EventFrame(extensionSummaryEvent(0))]);
        response.headers.set('X-AgentDock-Responder-Lease', responderLease);
        return response;
      }
      if (url.endsWith(`/v2/sessions/${SESSION_ID}/commands`)) {
        const command = JSON.parse(String(init?.body)) as typeof approvalCommand;
        return jsonResponse(202, {
          status: 'accepted',
          commandId: command.commandId,
          sessionId: command.sessionId,
          turnId: command.turnId,
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const observer = makeClient(fetchImpl);
    await observer.v2.sessions.send(approvalCommand);

    const responder = makeClient(fetchImpl);
    const events = responder.v2.sessions.events(SESSION_ID, { responder: true });
    await expect(events.next()).resolves.toEqual({ done: false, value: extensionSummaryEvent(0) });
    await responder.v2.sessions.send(approvalCommand);
    await events.return(undefined);

    const commandCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).endsWith(`/v2/sessions/${SESSION_ID}/commands`),
    );
    expect(commandCalls).toHaveLength(2);
    expect((commandCalls[0]?.[1] as RequestInit).headers).not.toHaveProperty(
      'X-AgentDock-Responder-Lease',
    );
    expect((commandCalls[1]?.[1] as RequestInit).headers).toMatchObject({
      'X-AgentDock-Responder-Lease': responderLease,
    });
    expect(await events.next()).toEqual({ done: true, value: undefined });
  });

  it('rejects an invalid command locally before compatibility or command requests', async () => {
    const fetchImpl = vi.fn();

    await expect(
      makeClient(fetchImpl as unknown as typeof fetch).v2.sessions.send({
        ...COMMAND_V2,
        commandId: 'not-a-uuid',
      } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'malformed',
      acknowledgement: { status: 'accepted', commandId: COMMAND_ID },
    },
    {
      name: 'wrong command id',
      acknowledgement: {
        ...COMMAND_ACKNOWLEDGEMENT_V2,
        commandId: '123e4567-e89b-42d3-a456-426614174005',
      },
    },
    {
      name: 'wrong session id',
      acknowledgement: { ...COMMAND_ACKNOWLEDGEMENT_V2, sessionId: OTHER_SESSION_ID },
    },
    {
      name: 'wrong turn id',
      acknowledgement: {
        ...COMMAND_ACKNOWLEDGEMENT_V2,
        turnId: '123e4567-e89b-42d3-a456-426614174006',
      },
    },
  ])('rejects a $name command acknowledgement', async ({ acknowledgement }) => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return jsonResponse(202, acknowledgement);
    });

    await expect(makeClient(fetchImpl).v2.sessions.send(COMMAND_V2)).rejects.toBeInstanceOf(
      ValidationError,
    );
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

  it('ends cleanly when abort resolves a read with a partial frame buffered', async () => {
    const controller = new AbortController();
    let reads = 0;
    const body = {
      getReader: () => ({
        read: async () => {
          reads += 1;
          if (reads === 1) {
            return {
              done: false,
              value: new TextEncoder().encode('id: 0\ndata: {"type":"extension.summary"}'),
            };
          }
          controller.abort();
          return { done: true, value: undefined };
        },
        cancel: async () => undefined,
      }),
    } as unknown as ReadableStream<Uint8Array>;
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return { ok: true, status: 200, headers: new Headers(), body } as Response;
    });

    await expect(
      (async () => {
        for await (const _event of makeClient(fetchImpl).v2.sessions.events(SESSION_ID, {
          signal: controller.signal,
        })) {
          // no-op
        }
      })(),
    ).resolves.toBeUndefined();
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
      const response = sseResponse([
        `:ok\n\nid: 4\nevent: extension.summary\ndata: ${JSON.stringify(event)}\n\n`,
      ]);
      response.headers.set('X-AgentDock-Responder-Lease', 'R'.repeat(43));
      return response;
    });
    const client = makeClient(fetchImpl);

    const collected = [];
    for await (const item of client.v2.sessions.events(SESSION_ID, {
      lastEventId: '3',
      responder: true,
    }))
      collected.push(item);

    expect(collected).toEqual([event]);
    const streamCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith(`/v2/sessions/${SESSION_ID}/events`),
    );
    expect((streamCall?.[1] as RequestInit).headers).toMatchObject({
      'Last-Event-ID': '3',
      'X-AgentDock-Responder': '1',
    });
  });

  it('surfaces a bounded subscriber overflow control frame', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return sseResponse([
        'event: stream.error\ndata: {"type":"stream.error","code":"stream_overflow","lastSequence":7}\n\n',
      ]);
    });

    const failure = await (async () => {
      for await (const _event of makeClient(fetchImpl).v2.sessions.events(SESSION_ID)) {
        // no-op
      }
    })().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DaemonError);
    expect(failure).toMatchObject({ status: 429 });
    expect(failure).toHaveProperty('message', expect.stringContaining('after sequence 7'));
  });

  it('maps a mid-stream reader failure to a retryable transport error', async () => {
    const event = extensionSummaryEvent(0);
    let reads = 0;
    const body = {
      getReader: () => ({
        read: async () => {
          reads += 1;
          if (reads === 1) {
            return {
              done: false,
              value: new TextEncoder().encode(v2EventFrame(event)),
            };
          }
          throw new TypeError('network connection reset');
        },
        cancel: async () => undefined,
      }),
    } as unknown as ReadableStream<Uint8Array>;
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return { ok: true, status: 200, headers: new Headers(), body } as Response;
    });
    const received: unknown[] = [];

    const failure = await (async () => {
      for await (const item of makeClient(fetchImpl).v2.sessions.events(SESSION_ID)) {
        received.push(item);
      }
    })().catch((error: unknown) => error);

    expect(received).toEqual([event]);
    expect(failure).toBeInstanceOf(DaemonUnavailableError);
  });
});

describe('AgentDockClient.v2 security APIs', () => {
  it('inspects and updates an exact workspace incarnation', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return jsonResponse(200, WORKSPACE_TRUST_VIEW);
    });
    const client = makeClient(fetchImpl);

    await expect(client.v2.workspaces.inspect('C:\\repo')).resolves.toEqual(WORKSPACE_TRUST_VIEW);
    await expect(
      client.v2.workspaces.setTrust(WORKSPACE_ID, {
        cwd: 'C:\\repo',
        incarnation: WORKSPACE_INCARNATION,
        state: 'trusted',
      }),
    ).resolves.toEqual(WORKSPACE_TRUST_VIEW);

    const inspectCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith('/v2/workspaces/inspect'),
    );
    expect(inspectCall?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String((inspectCall?.[1] as RequestInit).body))).toEqual({ cwd: 'C:\\repo' });
    const trustCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith(`/v2/workspaces/${WORKSPACE_ID}/trust`),
    );
    expect(trustCall?.[1]).toMatchObject({ method: 'PUT' });
  });

  it('reads a validated audit page with bounded query parameters', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return jsonResponse(200, { schemaVersion: 1, entries: [] });
    });
    const client = makeClient(fetchImpl);

    await expect(
      client.v2.audit.list({ cursor: 'MA', limit: 25, sessionId: SESSION_ID }),
    ).resolves.toEqual({ schemaVersion: 1, entries: [] });
    expect(
      fetchImpl.mock.calls.some(([url]) =>
        String(url).endsWith(`/v2/audit?cursor=MA&limit=25&sessionId=${SESSION_ID}`),
      ),
    ).toBe(true);
  });

  it('rejects forged workspace IDs and invalid audit bounds before a privileged request', async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl);
    await expect(
      client.v2.workspaces.setTrust('forged', {
        cwd: 'C:\\repo',
        incarnation: WORKSPACE_INCARNATION,
        state: 'trusted',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(client.v2.audit.list({ limit: 101 })).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it('maps a missing command session to SessionNotFoundError', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return jsonResponse(404, { error: 'session not found' });
    });

    await expect(makeClient(fetchImpl).v2.sessions.send(COMMAND_V2)).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it.each([
    ['resume', 'continuation_not_found'],
    ['fork', 'continuation_binding_not_found'],
  ] as const)('preserves %s continuation 404 code %s', async (kind, code) => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return jsonResponse(404, { error: 'continuation unavailable', code });
    });

    const sessions = makeClient(fetchImpl).v2.sessions;
    const failure = await sessions[kind](SESSION_ID, { prompt: 'continue' }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DaemonError);
    expect(failure).toMatchObject({ status: 404, code, message: 'continuation unavailable' });
  });

  it('keeps a genuinely missing continuation parent typed as SessionNotFoundError', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return jsonResponse(404, { error: 'session not found', code: 'session_not_found' });
    });

    await expect(
      makeClient(fetchImpl).v2.sessions.resume(SESSION_ID, { prompt: 'continue' }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it.each([409, 413, 429])('preserves command dispatch status %i', async (status) => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/health')) return healthResponse([1, 2]);
      return jsonResponse(status, { error: 'command rejected', code: 'command_rejected' });
    });

    const failure = await makeClient(fetchImpl)
      .v2.sessions.send(COMMAND_V2)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DaemonError);
    expect(failure).toMatchObject({ status });
  });
});
