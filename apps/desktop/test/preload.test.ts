import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDockBridge } from '../src/window.js';

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
        'listProvidersV2',
        'openProviderInstallDocs',
        'listMcpServers',
        'configureMcpServer',
        'actionMcpServer',
        'getMcpCatalog',
        'startMcpOAuth',
        'invokeMcpTool',
        'listProviderComponents',
        'manageProviderComponent',
        'invokeProviderComponent',
        'getSubagentGraph',
        'controlSubagent',
        'previewWorktree',
        'createWorktree',
        'listWorktrees',
        'cleanupWorktree',
        'selectAndUploadAttachments',
        'validateStructuredOutput',
        'createSession',
        'cancelSession',
        'onSessionEvent',
        'createInteractiveSession',
        'listInteractiveSessions',
        'readInteractiveSessionHistory',
        'reconnectInteractiveSession',
        'resumeInteractiveSession',
        'forkInteractiveSession',
        'deleteInteractiveSession',
        'sendSessionCommand',
        'respondApproval',
        'answerQuestions',
        'cancelInteractiveSession',
        'onInteractiveSessionEvent',
        'onInteractiveSessionStreamNotice',
        'onInteractionRequested',
        'onInteractionResolved',
        'inspectWorkspace',
        'setWorkspaceTrust',
        'readAudit',
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
    const command = { type: 'session.interrupt', sessionId, turnId };
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

  it('uses schema-checked narrow IPC for catalog restore, reconnect, continuations, and delete', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const session = {
      id: sessionId,
      provider: 'claude',
      transport: 'fake-interactive',
      cwd: '/tmp/project',
      status: 'completed',
      selection: {
        transport: 'fake-interactive',
        enabled: [],
        unavailableOptional: [],
        possibleEffects: [],
        effectsComplete: true,
      },
      executionId: '123e4567-e89b-42d3-a456-426614174001',
      acceptedWork: 'accepted',
      startedAt: '2026-08-31T00:00:00.000Z',
      completedAt: '2026-08-31T00:01:00.000Z',
      earliestSequence: 0,
    };
    invoke
      .mockResolvedValueOnce({ sessions: [session] })
      .mockResolvedValueOnce({ events: [] })
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(undefined);
    const api = await loadPreload();
    const bridge = api as unknown as AgentDockBridge;

    await expect(bridge.listInteractiveSessions({ limit: 25 })).resolves.toEqual({
      sessions: [session],
    });
    await expect(bridge.readInteractiveSessionHistory(sessionId, { limit: 25 })).resolves.toEqual({
      events: [],
    });
    await expect(bridge.reconnectInteractiveSession(sessionId)).resolves.toEqual(session);
    await expect(
      bridge.resumeInteractiveSession(sessionId, { prompt: 'continue' }),
    ).resolves.toEqual(session);
    await expect(bridge.forkInteractiveSession(sessionId, { prompt: 'branch' })).resolves.toEqual(
      session,
    );
    await expect(bridge.deleteInteractiveSession(sessionId)).resolves.toBeUndefined();

    expect(invoke.mock.calls).toEqual([
      ['daemon:list-interactive-sessions', { limit: 25 }],
      ['daemon:read-interactive-session-history', { sessionId, query: { limit: 25 } }],
      ['daemon:reconnect-interactive-session', sessionId],
      ['daemon:resume-interactive-session', { sessionId, input: { prompt: 'continue' } }],
      ['daemon:fork-interactive-session', { sessionId, input: { prompt: 'branch' } }],
      ['daemon:delete-interactive-session', sessionId],
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
        commandId: '123e4567-e89b-42d3-a456-426614174000',
        sessionId: '123e4567-e89b-42d3-a456-426614174001',
        turnId: '123e4567-e89b-42d3-a456-426614174002',
      }),
    ).rejects.toThrow(/must not provide a command id/);
    await expect(
      (api.cancelInteractiveSession as (id: string) => Promise<unknown>)('not-a-uuid'),
    ).rejects.toBeDefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects native approval/question commands on the generic command surface', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const turnId = '123e4567-e89b-42d3-a456-426614174001';
    const requestId = '123e4567-e89b-42d3-a456-426614174003';
    const api = await loadPreload();

    await expect(
      (api.sendSessionCommand as (input: unknown) => Promise<unknown>)({
        type: 'approval.respond',
        sessionId,
        turnId,
        requestId,
        decision: 'deny',
      }),
    ).rejects.toThrow(/opaque interaction handle/);
    await expect(
      (api.sendSessionCommand as (input: unknown) => Promise<unknown>)({
        type: 'question.respond',
        sessionId,
        turnId,
        requestId,
        answers: [],
      }),
    ).rejects.toThrow(/opaque interaction handle/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sends only opaque interaction handles and cannot expose or forward a responder lease', async () => {
    const interactionHandle = 'I'.repeat(43);
    const questionHandle = 'Q'.repeat(43);
    const optionHandle = 'O'.repeat(43);
    const responderLease = 'L'.repeat(43);
    invoke.mockResolvedValue({
      status: 'accepted',
      commandId: '123e4567-e89b-42d3-a456-426614174000',
      sessionId: '123e4567-e89b-42d3-a456-426614174001',
      turnId: '123e4567-e89b-42d3-a456-426614174002',
      responderLease,
    });
    const api = await loadPreload();
    expect(Object.keys(api).some((key) => /lease/i.test(key))).toBe(false);

    await expect(
      (api.respondApproval as (...args: unknown[]) => Promise<unknown>)(
        interactionHandle,
        'deny',
        responderLease,
      ),
    ).resolves.toEqual({ status: 'accepted' });
    await expect(
      (api.answerQuestions as (handle: string, answers: unknown[]) => Promise<unknown>)(
        interactionHandle,
        [
          {
            questionHandle,
            answer: { kind: 'options', optionHandles: [optionHandle] },
          },
        ],
      ),
    ).resolves.toEqual({ status: 'accepted' });

    expect(invoke.mock.calls).toEqual([
      ['daemon:respond-approval', { interactionHandle, decision: 'deny' }],
      [
        'daemon:answer-questions',
        {
          interactionHandle,
          answers: [
            {
              questionHandle,
              answer: { kind: 'options', optionHandles: [optionHandle] },
            },
          ],
        },
      ],
    ]);
  });

  it('replaces privileged interaction failures with a stable ID-free error', async () => {
    const nativeIds = [
      '123e4567-e89b-42d3-a456-426614174000',
      '123e4567-e89b-42d3-a456-426614174001',
      '123e4567-e89b-42d3-a456-426614174002',
    ];
    invoke.mockRejectedValue(
      new Error(`session not found: ${nativeIds[0]} turn ${nativeIds[1]} request ${nativeIds[2]}`),
    );
    const api = await loadPreload();

    const approvalError = await (
      api.respondApproval as (handle: string, decision: string) => Promise<unknown>
    )('I'.repeat(43), 'deny').catch((error: unknown) => error);
    const questionError = await (
      api.answerQuestions as (handle: string, answers: unknown[]) => Promise<unknown>
    )('I'.repeat(43), [
      {
        questionHandle: 'Q'.repeat(43),
        answer: { kind: 'text', text: 'answer' },
      },
    ]).catch((error: unknown) => error);

    expect(approvalError).toEqual(new Error('interaction response failed'));
    expect(questionError).toEqual(new Error('interaction response failed'));
    expect(`${approvalError}${questionError}`).not.toContain(nativeIds[0]);
    expect(`${approvalError}${questionError}`).not.toContain(nativeIds[1]);
    expect(`${approvalError}${questionError}`).not.toContain(nativeIds[2]);
  });

  it('rejects malformed opaque interaction answers before IPC', async () => {
    const api = await loadPreload();
    await expect(
      (api.respondApproval as (handle: string, decision: string) => Promise<unknown>)(
        'native-request-id',
        'deny',
      ),
    ).rejects.toThrow(/invalid approval response/);
    await expect(
      (api.answerQuestions as (handle: string, answers: unknown[]) => Promise<unknown>)(
        'I'.repeat(43),
        [
          {
            questionHandle: 'Q'.repeat(43),
            answer: { kind: 'text', text: 'answer' },
            questionId: '123e4567-e89b-42d3-a456-426614174000',
          },
        ],
      ),
    ).rejects.toThrow(/invalid question response/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects well-shaped interactive acknowledgements that do not match the request', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const turnId = '123e4567-e89b-42d3-a456-426614174001';
    const commandId = '123e4567-e89b-42d3-a456-426614174002';
    const otherId = '123e4567-e89b-42d3-a456-426614174003';
    const command = { type: 'session.interrupt', sessionId, turnId };
    invoke
      .mockResolvedValueOnce({ status: 'accepted', commandId, sessionId: otherId, turnId })
      .mockResolvedValueOnce({ status: 'cancelling', sessionId: otherId });
    const api = await loadPreload();

    await expect(
      (api.sendSessionCommand as (input: unknown) => Promise<unknown>)(command),
    ).rejects.toThrow(/does not match/);
    await expect(
      (api.cancelInteractiveSession as (id: string) => Promise<unknown>)(sessionId),
    ).rejects.toThrow(/does not match/);
  });

  it('uses fixed schema-checked IPC for v2 providers, workspace trust, and audit reads', async () => {
    const workspaceId = 'a'.repeat(64);
    const incarnation = 'b'.repeat(64);
    const provider = {
      id: 'claude',
      name: 'Claude Code',
      installed: true,
      authenticated: 'authenticated',
      transports: [],
      capabilities: [],
      sandbox: {
        providerId: 'claude',
        platform: 'win32',
        provider: { mechanism: 'provider_policy', state: 'provider_managed', evidence: [] },
        agentDock: { mechanism: 'agentdock_policy', state: 'not_requested', evidence: [] },
        os: { mechanism: 'os_sandbox', state: 'unavailable', evidence: [] },
        badge: 'none',
      },
    };
    const workspace = {
      schemaVersion: 1,
      workspaceId,
      incarnation,
      displayName: 'project',
      reusable: true,
      state: 'untrusted',
    };
    const trustedWorkspace = { ...workspace, state: 'trusted' };
    const audit = { schemaVersion: 1, entries: [] };
    invoke
      .mockResolvedValueOnce([provider])
      .mockResolvedValueOnce(workspace)
      .mockResolvedValueOnce(trustedWorkspace)
      .mockResolvedValueOnce(audit);
    const api = await loadPreload();

    await expect((api.listProvidersV2 as () => Promise<unknown>)()).resolves.toEqual([provider]);
    await expect(
      (api.inspectWorkspace as (cwd: string) => Promise<unknown>)('/tmp/project'),
    ).resolves.toEqual(workspace);
    await expect(
      (api.setWorkspaceTrust as (id: string, input: Record<string, unknown>) => Promise<unknown>)(
        workspaceId,
        { cwd: '/tmp/project', incarnation, state: 'trusted' },
      ),
    ).resolves.toEqual(trustedWorkspace);
    await expect(
      (api.readAudit as (input: Record<string, unknown>) => Promise<unknown>)({
        cursor: 'page_2',
        limit: 25,
        sessionId: '123e4567-e89b-42d3-a456-426614174000',
      }),
    ).resolves.toEqual(audit);

    expect(invoke.mock.calls).toEqual([
      ['daemon:list-providers-v2'],
      ['daemon:inspect-workspace', { cwd: '/tmp/project' }],
      [
        'daemon:set-workspace-trust',
        {
          workspaceId,
          update: { cwd: '/tmp/project', incarnation, state: 'trusted' },
        },
      ],
      [
        'daemon:read-audit',
        {
          cursor: 'page_2',
          limit: 25,
          sessionId: '123e4567-e89b-42d3-a456-426614174000',
        },
      ],
    ]);
  });

  it('rejects malformed v2 security inputs and secret-bearing responses at preload', async () => {
    const api = await loadPreload();

    await expect(
      (api.setWorkspaceTrust as (id: string, input: unknown) => Promise<unknown>)('native-id', {
        cwd: '/tmp/project',
        incarnation: 'b'.repeat(64),
        state: 'trusted',
      }),
    ).rejects.toThrow(/workspace id/);
    await expect(
      (api.readAudit as (input: unknown) => Promise<unknown>)({ limit: 101 }),
    ).rejects.toThrow(/audit limit/);
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValue([
      {
        id: 'claude',
        name: 'Claude Code',
        installed: true,
        authenticated: 'authenticated',
        transports: [],
        capabilities: [],
        sandbox: {
          providerId: 'claude',
          platform: 'win32',
          provider: { mechanism: 'provider_policy', state: 'provider_managed', evidence: [] },
          agentDock: { mechanism: 'agentdock_policy', state: 'not_requested', evidence: [] },
          os: { mechanism: 'os_sandbox', state: 'unavailable', evidence: [] },
          badge: 'none',
        },
        token: 'must-not-cross-preload',
      },
    ]);
    await expect((api.listProvidersV2 as () => Promise<unknown>)()).rejects.toBeDefined();
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
    listener?.(
      {},
      {
        sessionId,
        event: {
          type: 'approval.requested',
          sessionId,
          executionId: '123e4567-e89b-42d3-a456-426614174001',
          turnId: '123e4567-e89b-42d3-a456-426614174002',
          requestId: '123e4567-e89b-42d3-a456-426614174003',
          sequence: 3,
          timestamp: '2026-08-31T00:00:00.000Z',
          title: 'Delete file?',
          action: 'delete',
          target: 'safe summary',
          possibleEffects: ['filesystem_write', 'destructive'],
          effectsComplete: true,
          deadlineAt: '2026-08-31T00:01:00.000Z',
        },
      },
    );
    listener?.({}, { sessionId: '123e4567-e89b-42d3-a456-426614174009', event });
    listener?.({}, { sessionId, event: { ...event, token: 'must-not-cross-preload' } });
    listener?.({}, { sessionId, event: { type: 'session.completed' } });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(sessionId, event);
    dispose();
    expect(removeListener).toHaveBeenCalledWith('daemon:interactive-session-event', listener);
  });

  it('reconstructs opaque interaction requests without forwarding native correlation IDs', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const interactionHandle = 'I'.repeat(43);
    const questionInteractionHandle = 'J'.repeat(43);
    const questionHandle = 'Q'.repeat(43);
    const optionHandle = 'O'.repeat(43);
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = (
      api.onInteractionRequested as (
        cb: (sessionId: string, interaction: unknown) => void,
      ) => () => void
    )(callback);
    const listener = on.mock.calls.find(
      (call) => call[0] === 'daemon:interaction-requested',
    )?.[1] as ((ipcEvent: unknown, payload: unknown) => void) | undefined;

    listener?.(
      {},
      {
        sessionId,
        interaction: {
          kind: 'approval',
          interactionHandle,
          title: 'Delete file?',
          action: 'delete',
          target: 'workspace file',
          reason: 'requested by the agent',
          possibleEffects: ['filesystem_write', 'destructive'],
          effectsComplete: true,
          allowedDecisions: ['allow_once', 'deny'],
          deadlineAt: '2026-08-31T00:01:00.000Z',
          turnId: '123e4567-e89b-42d3-a456-426614174001',
          requestId: '123e4567-e89b-42d3-a456-426614174002',
        },
      },
    );
    listener?.(
      {},
      {
        sessionId,
        interaction: {
          kind: 'question',
          interactionHandle: questionInteractionHandle,
          questions: [
            {
              questionHandle,
              title: 'Mode',
              prompt: 'Choose a mode',
              options: [{ optionHandle, label: 'Safe' }],
              allowsFreeText: false,
              questionId: '123e4567-e89b-42d3-a456-426614174003',
            },
          ],
          deadlineAt: '2026-08-31T00:01:00.000Z',
          requestId: '123e4567-e89b-42d3-a456-426614174004',
        },
      },
    );

    expect(callback).toHaveBeenCalledWith(sessionId, {
      kind: 'approval',
      interactionHandle,
      title: 'Delete file?',
      action: 'delete',
      target: 'workspace file',
      reason: 'requested by the agent',
      possibleEffects: ['filesystem_write', 'destructive'],
      effectsComplete: true,
      allowedDecisions: ['allow_once', 'deny'],
      deadlineAt: '2026-08-31T00:01:00.000Z',
    });
    expect(callback).toHaveBeenCalledWith(sessionId, {
      kind: 'question',
      interactionHandle: questionInteractionHandle,
      questions: [
        {
          questionHandle,
          title: 'Mode',
          prompt: 'Choose a mode',
          options: [{ optionHandle, label: 'Safe' }],
          allowsFreeText: false,
        },
      ],
      deadlineAt: '2026-08-31T00:01:00.000Z',
    });
    expect(JSON.stringify(callback.mock.calls.map((call) => call[1]))).not.toMatch(
      /sessionId|turnId|requestId|questionId/,
    );
    dispose();
    expect(removeListener).toHaveBeenCalledWith('daemon:interaction-requested', listener);
  });

  it('reconstructs safe interaction resolution notices and drops native IDs', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const interactionHandle = 'I'.repeat(43);
    const api = await loadPreload();
    const callback = vi.fn();
    const dispose = (
      api.onInteractionResolved as (
        cb: (sessionId: string, resolution: unknown) => void,
      ) => () => void
    )(callback);
    const listener = on.mock.calls.find(
      (call) => call[0] === 'daemon:interaction-resolved',
    )?.[1] as ((ipcEvent: unknown, payload: unknown) => void) | undefined;

    listener?.(
      {},
      {
        sessionId,
        resolution: {
          interactionHandle,
          kind: 'question_cancelled',
          reason: 'timeout',
          questionId: '123e4567-e89b-42d3-a456-426614174001',
        },
      },
    );

    expect(callback).toHaveBeenCalledWith(sessionId, {
      interactionHandle,
      kind: 'question_cancelled',
      reason: 'timeout',
    });
    expect(JSON.stringify(callback.mock.calls.map((call) => call[1]))).not.toMatch(
      /sessionId|questionId/,
    );
    dispose();
    expect(removeListener).toHaveBeenCalledWith('daemon:interaction-resolved', listener);
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

  it('opens provider install docs by id and rejects an unknown provider before any IPC call (issue #73)', async () => {
    invoke.mockResolvedValueOnce(undefined);
    const api = await loadPreload();

    await expect(
      (api.openProviderInstallDocs as (provider: string) => Promise<void>)('codex'),
    ).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('shell:open-provider-install-docs', 'codex');

    invoke.mockClear();
    await expect(
      (api.openProviderInstallDocs as (provider: string) => Promise<void>)('not-a-real-provider'),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
