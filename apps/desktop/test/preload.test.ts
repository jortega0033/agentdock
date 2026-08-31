import { beforeEach, describe, expect, it, vi } from 'vitest';

// AD-07: the old test here asserted properties of a mock object the test itself constructed, so
// it could never fail for the reason its name claimed. This imports the REAL electron/preload.ts
// module against a stubbed ipcRenderer, so the assertions run against code that could actually
// leak something. `vi.hoisted` is required here (not plain module-scope consts) because
// `vi.mock('electron', ...)` is hoisted above other statements by vitest's transform — referencing
// un-hoisted variables from inside the factory would throw a "used before initialization" error.
const { invoke, on, removeListener } = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

let exposedApi: Record<string, unknown> | undefined;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => {
      exposedApi = api as Record<string, unknown>;
    },
  },
  ipcRenderer: { invoke, on, removeListener },
}));

async function loadPreload(): Promise<Record<string, unknown>> {
  vi.resetModules();
  exposedApi = undefined;
  await import('../electron/preload.js'); // side effect: calls contextBridge.exposeInMainWorld
  if (!exposedApi) throw new Error('preload.ts did not call exposeInMainWorld');
  return exposedApi;
}

beforeEach(() => {
  invoke.mockReset();
  on.mockReset();
  removeListener.mockReset();
});

describe('electron/preload.ts — real bridge (AD-07)', () => {
  it('exposes exactly the documented capability functions and nothing else', async () => {
    const api = await loadPreload();
    expect(Object.keys(api).sort()).toEqual(
      [
        'getDaemonStatus',
        'onDaemonStatus',
        'listProviders',
        'createSession',
        'cancelSession',
        'onSessionEvent',
        'createInteractiveSession',
        'sendSessionCommand',
        'cancelInteractiveSession',
        'onInteractiveSessionEvent',
        'onInteractiveSessionStreamNotice',
        'selectDirectory',
      ].sort(),
    );
  });

  it('exposes no generic IPC passthrough (no raw ipcRenderer, no invoke-by-channel-name function)', async () => {
    const api = await loadPreload();
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} should be a plain function`).toBe('function');
    }
    expect(api.invoke).toBeUndefined();
    expect(api.send).toBeUndefined();
    expect(api.ipcRenderer).toBeUndefined();
  });

  it('getDaemonStatus does not let a token or base URL survive, even if the IPC response contained one', async () => {
    invoke.mockResolvedValue({
      state: 'ready',
      token: 'super-secret-token',
      baseUrl: 'http://127.0.0.1:54321',
    });
    const api = await loadPreload();

    const status = await (api.getDaemonStatus as () => Promise<unknown>)();

    expect(status).toEqual({ state: 'ready' });
    expect(status).not.toHaveProperty('token');
    expect(status).not.toHaveProperty('baseUrl');
  });

  it('onDaemonStatus does not let a token or base URL survive through the push channel either', async () => {
    const api = await loadPreload();
    const received: unknown[] = [];
    (api.onDaemonStatus as (cb: (s: unknown) => void) => () => void)((status) =>
      received.push(status),
    );

    const listener = on.mock.calls.find((call) => call[0] === 'daemon:status')?.[1] as
      ((event: unknown, status: unknown) => void) | undefined;
    expect(listener).toBeDefined();
    listener?.(
      {},
      {
        state: 'unavailable',
        error: 'daemon crashed',
        token: 'leaked-token',
        baseUrl: 'http://leak',
      },
    );

    expect(received).toEqual([{ state: 'unavailable', error: 'daemon crashed' }]);
  });

  it('getDaemonStatus falls back to "connecting" for a malformed/unrecognized response rather than passing it through', async () => {
    invoke.mockResolvedValue({ nonsense: true, token: 'leaked-token' });
    const api = await loadPreload();
    const status = await (api.getDaemonStatus as () => Promise<unknown>)();
    expect(status).toEqual({ state: 'connecting' });
  });

  it('getDaemonStatus invokes only daemon:get-status, nothing else, no arguments', async () => {
    invoke.mockResolvedValue({ state: 'ready' });
    const api = await loadPreload();
    await (api.getDaemonStatus as () => Promise<unknown>)();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('daemon:get-status');
  });

  it('createSession invokes only daemon:create-session with exactly the given input', async () => {
    invoke.mockResolvedValue({ id: 'session-1' });
    const api = await loadPreload();
    const input = { provider: 'claude', cwd: '/tmp/project', prompt: 'hello' };
    await (api.createSession as (i: unknown) => Promise<unknown>)(input);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('daemon:create-session', input);
  });

  it('cancelSession invokes only daemon:cancel-session with the given session id', async () => {
    invoke.mockResolvedValue(undefined);
    const api = await loadPreload();
    await (api.cancelSession as (id: string) => Promise<unknown>)('session-42');
    expect(invoke).toHaveBeenCalledWith('daemon:cancel-session', 'session-42');
  });

  it('uses fixed IPC channels for the interactive session lifecycle and command dispatch', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const executionId = '123e4567-e89b-42d3-a456-426614174001';
    const turnId = '123e4567-e89b-42d3-a456-426614174002';
    const commandId = '123e4567-e89b-42d3-a456-426614174003';
    const createInput = { provider: 'claude', cwd: '/tmp/project', prompt: 'hello' };
    const session = {
      id: sessionId,
      provider: 'claude',
      transport: 'fake-interactive',
      cwd: '/tmp/project',
      status: 'starting',
      selection: {
        transport: 'fake-interactive',
        enabled: [],
        unavailableOptional: [],
        possibleEffects: [],
        effectsComplete: true,
      },
      executionId,
      currentTurnId: turnId,
      acceptedWork: 'not_accepted',
      startedAt: '2026-08-31T00:00:00.000Z',
      earliestSequence: 0,
    };
    const command = { type: 'session.interrupt', commandId, sessionId, turnId };
    const acknowledgement = { status: 'accepted', commandId, sessionId, turnId };
    const cancellation = { status: 'cancelling', sessionId };
    invoke
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(acknowledgement)
      .mockResolvedValueOnce(cancellation);
    const api = await loadPreload();

    await expect(
      (api.createInteractiveSession as (input: unknown) => Promise<unknown>)(createInput),
    ).resolves.toEqual(session);
    await expect(
      (api.sendSessionCommand as (input: unknown) => Promise<unknown>)(command),
    ).resolves.toEqual(acknowledgement);
    await expect(
      (api.cancelInteractiveSession as (id: string) => Promise<unknown>)(sessionId),
    ).resolves.toEqual(cancellation);

    expect(invoke.mock.calls).toEqual([
      ['daemon:create-interactive-session', createInput],
      ['daemon:send-session-command', command],
      ['daemon:cancel-interactive-session', sessionId],
    ]);
  });

  it('rejects malformed interactive inputs before invoking privileged IPC', async () => {
    const api = await loadPreload();

    await expect(
      (api.createInteractiveSession as (input: unknown) => Promise<unknown>)({
        provider: 'claude',
        cwd: '',
        prompt: '',
      }),
    ).rejects.toBeDefined();
    await expect(
      (api.sendSessionCommand as (input: unknown) => Promise<unknown>)({
        type: 'session.interrupt',
        commandId: 'not-a-uuid',
      }),
    ).rejects.toBeDefined();
    await expect(
      (api.cancelInteractiveSession as (id: string) => Promise<unknown>)('not-a-uuid'),
    ).rejects.toBeDefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects well-shaped interactive acknowledgements that do not match the request', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const turnId = '123e4567-e89b-42d3-a456-426614174001';
    const commandId = '123e4567-e89b-42d3-a456-426614174002';
    const otherId = '123e4567-e89b-42d3-a456-426614174003';
    const command = { type: 'session.interrupt', commandId, sessionId, turnId };
    invoke
      .mockResolvedValueOnce({ status: 'accepted', commandId: otherId, sessionId, turnId })
      .mockResolvedValueOnce({ status: 'cancelling', sessionId: otherId });
    const api = await loadPreload();

    await expect(
      (api.sendSessionCommand as (input: unknown) => Promise<unknown>)(command),
    ).rejects.toThrow(/does not match/);
    await expect(
      (api.cancelInteractiveSession as (id: string) => Promise<unknown>)(sessionId),
    ).rejects.toThrow(/does not match/);
  });

  it('forwards only valid, correlated v2 event envelopes and removes its listener', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const event = {
      type: 'session.completed',
      sessionId,
      executionId: '123e4567-e89b-42d3-a456-426614174001',
      sequence: 2,
      timestamp: '2026-08-31T00:00:00.000Z',
    };
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = (
      api.onInteractiveSessionEvent as (cb: (id: string, item: unknown) => void) => () => void
    )(callback);
    const listener = on.mock.calls.find(
      (call) => call[0] === 'daemon:interactive-session-event',
    )?.[1] as ((ipcEvent: unknown, payload: unknown) => void) | undefined;

    listener?.({}, { sessionId, event });
    listener?.({}, { sessionId: '123e4567-e89b-42d3-a456-426614174009', event });
    listener?.({}, { sessionId, event: { ...event, token: 'must-not-cross-preload' } });
    listener?.({}, { sessionId, event: { type: 'session.completed' } });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(sessionId, event);
    dispose();
    expect(removeListener).toHaveBeenCalledWith('daemon:interactive-session-event', listener);
  });

  it('sanitizes replay resets and terminal stream errors before forwarding them', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const session = {
      id: sessionId,
      provider: 'claude',
      transport: 'test-interactive',
      cwd: 'C:\\repo',
      status: 'active',
      selection: {
        transport: 'test-interactive',
        enabled: [],
        unavailableOptional: [],
        possibleEffects: [],
        effectsComplete: true,
      },
      executionId: '123e4567-e89b-42d3-a456-426614174001',
      acceptedWork: 'accepted',
      startedAt: '2026-08-31T00:00:00.000Z',
      earliestSequence: 5,
    };
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = (
      api.onInteractiveSessionStreamNotice as (
        cb: (id: string, notice: unknown) => void,
      ) => () => void
    )(callback);
    const listener = on.mock.calls.find(
      (call) => call[0] === 'daemon:interactive-session-stream-notice',
    )?.[1] as ((ipcEvent: unknown, payload: unknown) => void) | undefined;

    listener?.({}, { sessionId, notice: { type: 'replay_reset', session } });
    listener?.(
      {},
      {
        sessionId,
        notice: { type: 'error', message: 'authorization failed', status: 401, token: 'drop-me' },
      },
    );
    listener?.(
      {},
      {
        sessionId: '123e4567-e89b-42d3-a456-426614174009',
        notice: { type: 'replay_reset', session },
      },
    );

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(1, sessionId, { type: 'replay_reset', session });
    expect(callback).toHaveBeenNthCalledWith(2, sessionId, {
      type: 'error',
      message: 'authorization failed',
      status: 401,
    });
    dispose();
    expect(removeListener).toHaveBeenCalledWith(
      'daemon:interactive-session-stream-notice',
      listener,
    );
  });
});
