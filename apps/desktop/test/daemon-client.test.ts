import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@agent-dock/shared';
import {
  DaemonRequestError,
  cancelSession,
  createSession,
  listProviders,
  streamSessionEvents,
} from '../electron/daemon-client.js';

const CONN = { baseUrl: 'http://127.0.0.1:9999', token: 'test-token' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('daemon-client (main-process HTTP client)', () => {
  it('sends the bearer token on every request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ providers: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await listProviders(CONN);

    expect(fetchMock).toHaveBeenCalledWith(
      `${CONN.baseUrl}/providers`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    );
  });

  it('throws DaemonRequestError with the daemon-provided message on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'invalid request body' }) }),
    );

    await expect(createSession(CONN, { provider: 'claude', cwd: '/tmp', prompt: 'hi' })).rejects.toThrow(
      DaemonRequestError,
    );
    await expect(createSession(CONN, { provider: 'claude', cwd: '/tmp', prompt: 'hi' })).rejects.toThrow(
      'invalid request body',
    );
  });

  it('cancelSession posts to the cancel endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({ status: 'cancelling' }) });
    vi.stubGlobal('fetch', fetchMock);

    await cancelSession(CONN, 'sess-1');

    expect(fetchMock).toHaveBeenCalledWith(
      `${CONN.baseUrl}/sessions/sess-1/cancel`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('streamSessionEvents parses SSE frames split across chunks', async () => {
    const frame1 = 'data: {"type":"assistant.message","text":"hel';
    const frame2 = 'lo"}\n\n';
    const frame3 = 'data: {"type":"session.completed"}\n\n';

    let call = 0;
    const chunks = [frame1, frame2, frame3];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => {
              if (call < chunks.length) {
                return { done: false, value: new TextEncoder().encode(chunks[call++]) };
              }
              return { done: true, value: undefined };
            },
          }),
        },
      }),
    );

    const events: AgentEvent[] = [];
    await streamSessionEvents(CONN, 'sess-1', (e) => events.push(e));

    expect(events).toEqual([{ type: 'assistant.message', text: 'hello' }, { type: 'session.completed' }]);
  });

  it('streamSessionEvents throws if the response has no body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }));
    await expect(streamSessionEvents(CONN, 'sess-1', () => {})).rejects.toThrow(DaemonRequestError);
  });
});
