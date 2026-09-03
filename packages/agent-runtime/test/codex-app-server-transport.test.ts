import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentCommandV2,
  AgentEventV2,
  CapabilitySelection,
  ProviderStatus,
} from '@agent-dock/shared';
import { CODEX_APP_SERVER_TRANSPORT } from '../src/providers/codex/app-server-support.js';
import { superviseInteractiveSession } from '../src/providers/common/session-supervisor.js';
import {
  CodexAppServerTransport,
  type CodexAppServerContinuation,
} from '../src/providers/codex/app-server/index.js';
import { FailableChannel } from '../src/providers/codex/app-server/channel.js';
import { CodexAppServerNormalizer } from '../src/providers/codex/app-server/normalizer.js';
import {
  CodexAppServerRpc,
  type IncomingRequestResponder,
} from '../src/providers/codex/app-server/rpc.js';
import { probeCodexAppServerScope } from '../src/providers/codex/app-server/scope-probe.js';
import type { ProviderContinuationEvidence } from '../src/types.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174200';
const TURN_ID = '123e4567-e89b-42d3-a456-426614174201';
const EXECUTION_ID = '123e4567-e89b-42d3-a456-426614174202';
const COMMAND_ID = '123e4567-e89b-42d3-a456-426614174203';
const FOLLOW_UP_TURN_ID = '123e4567-e89b-42d3-a456-426614174204';
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));

const SELECTION: CapabilitySelection = {
  transport: CODEX_APP_SERVER_TRANSPORT.id,
  enabled: [],
  unavailableOptional: [],
  possibleEffects: CODEX_APP_SERVER_TRANSPORT.possibleEffects,
  effectsComplete: false,
};

const live = new Set<CodexAppServerTransport>();

describe('Codex app-server launch scope probe', () => {
  it('reads exact non-secret account/model evidence without starting a thread', async () => {
    const evidence = await probeCodexAppServerScope({
      executable: process.execPath,
      executableArgs: [FIXTURE],
      processPlatform: 'linux',
      cwd: process.cwd(),
      providerStatus: {
        id: 'codex',
        name: 'Codex',
        installed: true,
        authenticated: 'authenticated',
        authSource: 'chatgpt',
        executablePath: process.execPath,
        version: '0.999.0',
        capabilities: {},
      },
    });

    expect(evidence).toEqual({
      accountFingerprint: createHash('sha256').update('fixture@example.test').digest('hex'),
      selectedModel: 'fake-model',
    });
  });
});

function transport(
  scenario = 'normal',
  continuation?: CodexAppServerContinuation,
  extraEnv: NodeJS.ProcessEnv = {},
  expectedContinuationEvidence?: ProviderContinuationEvidence,
  providerStatusOverrides: Partial<ProviderStatus> = {},
  beforeWorkDelivery?: () => Promise<void>,
  beforeProviderThreadStart?: (
    evidence: Readonly<ProviderContinuationEvidence> | undefined,
  ) => Promise<void>,
  selection: CapabilitySelection = SELECTION,
): CodexAppServerTransport {
  const instance = new CodexAppServerTransport({
    executable: process.execPath,
    executableArgs: [FIXTURE],
    processPlatform: 'linux',
    sessionId: SESSION_ID,
    executionId: EXECUTION_ID,
    turnId: TURN_ID,
    cwd: process.cwd(),
    prompt: 'hello fixture',
    transport: CODEX_APP_SERVER_TRANSPORT,
    selection,
    continuation,
    expectedContinuationEvidence,
    env: {
      ...process.env,
      ...extraEnv,
      FAKE_CODEX_APP_SERVER_SCENARIO: scenario,
    },
    providerStatus: {
      id: 'codex',
      name: 'Codex',
      installed: true,
      authenticated: 'authenticated',
      authSource: 'chatgpt',
      executablePath: process.execPath,
      version: '0.147.0',
      capabilities: {},
      ...providerStatusOverrides,
    },
    beforeWorkDelivery,
    beforeProviderThreadStart,
  });
  live.add(instance);
  return instance;
}

function multimodalTransport(scenario: 'multimodal' | 'multimodal-invalid-output'): CodexAppServerTransport {
  const instance = new CodexAppServerTransport({
    executable: process.execPath,
    executableArgs: [FIXTURE],
    processPlatform: 'linux',
    sessionId: SESSION_ID,
    executionId: EXECUTION_ID,
    turnId: TURN_ID,
    cwd: process.cwd(),
    prompt: 'hello fixture',
    transport: CODEX_APP_SERVER_TRANSPORT,
    selection: SELECTION,
    env: { ...process.env, FAKE_CODEX_APP_SERVER_SCENARIO: scenario },
    providerStatus: {
      id: 'codex',
      name: 'Codex',
      installed: true,
      authenticated: 'authenticated',
      authSource: 'chatgpt',
      executablePath: process.execPath,
      version: '0.147.0',
      capabilities: {},
    },
    attachments: [
      { attachmentId: 'a'.repeat(32), path: '/fake/staged/image.png', mimeType: 'image/png', byteLength: 4 },
    ],
    outputSchema: {
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'number' } },
    },
  });
  live.add(instance);
  return instance;
}

async function next(
  iterator: AsyncGenerator<unknown, void, void>,
): Promise<IteratorResult<unknown, void>> {
  return Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture event timeout')), 5_000);
      timer.unref?.();
    }),
  ]);
}

async function until(
  instance: CodexAppServerTransport,
  predicate: (event: AgentEventV2) => boolean,
): Promise<AgentEventV2[]> {
  const events: AgentEventV2[] = [];
  while (true) {
    const result = await next(instance.events);
    if (result.done) throw new Error('event stream ended early');
    const event = result.value as AgentEventV2;
    events.push(event);
    if (predicate(event)) return events;
  }
}

function serverRequest(
  id: string | number,
  method: string,
  params: unknown,
): { request: IncomingRequestResponder; replies: unknown[] } {
  const replies: unknown[] = [];
  return {
    replies,
    request: {
      id,
      method,
      params,
      respond: async (result) => {
        replies.push({ result });
      },
      reject: async (code, safeMessage) => {
        replies.push({ error: { code, message: safeMessage } });
      },
    },
  };
}

afterEach(async () => {
  await Promise.all([...live].map((instance) => instance.forceClose().catch(() => undefined)));
  live.clear();
});

describe('Codex app-server transport', () => {
  it('bounds retained event bytes and rejects unallowlisted notifications before dispatch', () => {
    const channel = new FailableChannel<string>(2, 8, (value) => Buffer.byteLength(value));
    expect(channel.push('12345678')).toBe(true);
    expect(channel.push('x')).toBe(false);

    const notifications: string[] = [];
    const fatals: Error[] = [];
    const rpc = new CodexAppServerRpc({
      write: async () => undefined,
      onNotification: (method) => notifications.push(method),
      onRequest: () => undefined,
      onFatal: (error) => fatals.push(error),
    });
    rpc.acceptStdout(Buffer.from('{"method":"item/plan/delta","params":{}}\n'));
    expect(notifications).toEqual([]);
    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toHaveProperty('code', 'forbidden_method');
  });

  it('rejects oversized plans and content deltas before retaining them', () => {
    const events: AgentEventV2[] = [];
    const normalizer = new CodexAppServerNormalizer((event) => events.push(event));
    normalizer.startSession('native-thread', CODEX_APP_SERVER_TRANSPORT.id, SELECTION);
    normalizer.expectTurn(TURN_ID);
    normalizer.bindTurnResponse('native-turn');
    normalizer.notification('turn/started', {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'inProgress' },
    });
    normalizer.notification('item/agentMessage/delta', {
      threadId: 'native-thread',
      turnId: 'native-turn',
      itemId: 'large-message',
      delta: 'x'.repeat(256 * 1024 + 1),
    });
    normalizer.notification('turn/plan/updated', {
      threadId: 'native-thread',
      turnId: 'native-turn',
      plan: [
        { step: 'a'.repeat(140 * 1024), status: 'pending' },
        { step: 'b'.repeat(140 * 1024), status: 'pending' },
      ],
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'extension.summary',
          extensionName: 'codex.agent_message',
          reason: 'truncated',
        }),
        expect.objectContaining({
          type: 'content.completed',
          block: expect.objectContaining({
            type: 'provider_extension',
            extensionName: 'codex.plan',
            reason: 'truncated',
            originalBytes: expect.any(Number),
          }),
        }),
      ]),
    );
    expect(events.some((event) => event.type === 'content.delta')).toBe(false);
  });

  it('summarizes a near-limit delta whose encoded event exceeds the content cap', () => {
    const events: AgentEventV2[] = [];
    const normalizer = new CodexAppServerNormalizer((event) => events.push(event));
    normalizer.startSession('native-thread', CODEX_APP_SERVER_TRANSPORT.id, SELECTION);
    normalizer.expectTurn(TURN_ID);
    normalizer.bindTurnResponse('native-turn');
    normalizer.notification('turn/started', {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'inProgress' },
    });
    normalizer.notification('item/agentMessage/delta', {
      threadId: 'native-thread',
      turnId: 'native-turn',
      itemId: 'near-limit-message',
      delta: 'x'.repeat(256 * 1024 - 32),
    });
    expect(events.some((event) => event.type === 'content.delta')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'extension.summary',
        extensionName: 'codex.agent_message',
        reason: 'truncated',
      }),
    );
  });

  it('does not let a delta after completion bypass the native item identity', () => {
    const normalizer = new CodexAppServerNormalizer(() => undefined);
    normalizer.startSession('native-thread', CODEX_APP_SERVER_TRANSPORT.id, SELECTION);
    normalizer.expectTurn(TURN_ID);
    normalizer.bindTurnResponse('native-turn');
    normalizer.notification('turn/started', {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'inProgress' },
    });
    normalizer.notification('item/agentMessage/delta', {
      threadId: 'native-thread',
      turnId: 'native-turn',
      itemId: 'message',
      delta: 'x',
    });
    normalizer.notification('item/completed', {
      threadId: 'native-thread',
      turnId: 'native-turn',
      item: { id: 'message', type: 'agentMessage', text: 'x' },
    });
    expect(() =>
      normalizer.notification('item/agentMessage/delta', {
        threadId: 'native-thread',
        turnId: 'native-turn',
        itemId: 'message',
        delta: 'y',
      }),
    ).toThrow('after completion');
  });

  it('sends a staged attachment as localImage and the negotiated outputSchema on the real turn/start request, emitting structured_data once the final message validates', async () => {
    const instance = multimodalTransport('multimodal');
    await instance.started;
    const events = await until(
      instance,
      (event) => event.type === 'session.status' && event.status === 'idle',
    );
    // The fixture's own assert() calls (see fake-codex-app-server.mjs) already fail the process
    // if `input`/`outputSchema` were wrong on the wire; reaching idle here proves they were right.
    const structured = events.find((event) => event.type === 'content.completed' && (event as { block: { type: string } }).block.type === 'structured_data');
    expect(structured).toBeDefined();
    expect((structured as { block: { data: unknown } }).block.data).toEqual({ answer: 42 });
    // The plain text is still emitted too -- structured_data is additive, never a replacement.
    expect(
      events.some(
        (event) => event.type === 'content.completed' && (event as { block: { type: string } }).block.type === 'text',
      ),
    ).toBe(true);
  });

  it('never emits structured_data for output that fails to parse as JSON, leaving only the inspectable text block', async () => {
    const instance = multimodalTransport('multimodal-invalid-output');
    await instance.started;
    const events = await until(
      instance,
      (event) => event.type === 'session.status' && event.status === 'idle',
    );
    expect(
      events.some(
        (event) => event.type === 'content.completed' && (event as { block: { type: string } }).block.type === 'structured_data',
      ),
    ).toBe(false);
    const text = events.find(
      (event) => event.type === 'content.completed' && (event as { block: { type: string } }).block.type === 'text',
    ) as { block: { text: string } } | undefined;
    expect(text?.block.text).toBe('not valid json');
  });

  it('maps a real subAgentActivity item into a stable subagent.status node, closing it out when its turn ends with no completed kind', () => {
    const events: AgentEventV2[] = [];
    const normalizer = new CodexAppServerNormalizer((event) => events.push(event));
    normalizer.startSession('native-thread', CODEX_APP_SERVER_TRANSPORT.id, SELECTION);
    normalizer.expectTurn(TURN_ID);
    normalizer.bindTurnResponse('native-turn');
    normalizer.notification('turn/started', {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'inProgress' },
    });
    const item = {
      type: 'subAgentActivity',
      id: 'subagent-item-1',
      agentThreadId: 'native-subagent-thread',
      agentPath: 'reviewer',
      kind: 'started',
    };
    normalizer.notification('item/started', { threadId: 'native-thread', turnId: 'native-turn', item });
    normalizer.notification('item/completed', {
      threadId: 'native-thread',
      turnId: 'native-turn',
      item,
    });
    const progress = { ...item, id: 'subagent-item-2', kind: 'interacted' };
    normalizer.notification('item/started', {
      threadId: 'native-thread',
      turnId: 'native-turn',
      item: progress,
    });
    normalizer.notification('item/completed', {
      threadId: 'native-thread',
      turnId: 'native-turn',
      item: progress,
    });
    normalizer.notification('turn/completed', {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'completed' },
    });

    const subagentEvents = events.filter((event) => event.type === 'subagent.status');
    expect(subagentEvents).toHaveLength(3);
    const [spawned, updated, closed] = subagentEvents as Extract<
      AgentEventV2,
      { type: 'subagent.status' }
    >[];
    expect(spawned).toMatchObject({ name: 'reviewer', status: 'spawning', nativeChildId: 'native-subagent-thread' });
    expect(updated).toMatchObject({ name: 'reviewer', status: 'running' });
    expect(closed).toMatchObject({ name: 'reviewer', status: 'completed' });
    // The same native thread id maps to the same AgentDock agentId across every sighting -- the
    // whole point of the id-stability requirement, verified across all three events.
    expect(spawned!.agentId).toBe(updated!.agentId);
    expect(updated!.agentId).toBe(closed!.agentId);
  });

  it('mirrors the parent turn outcome for a still-open child instead of always reporting success', () => {
    const events: AgentEventV2[] = [];
    const normalizer = new CodexAppServerNormalizer((event) => events.push(event));
    normalizer.startSession('native-thread', CODEX_APP_SERVER_TRANSPORT.id, SELECTION);
    normalizer.expectTurn(TURN_ID);
    normalizer.bindTurnResponse('native-turn');
    normalizer.notification('turn/started', {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'inProgress' },
    });
    const item = {
      type: 'subAgentActivity',
      id: 'subagent-item-1',
      agentThreadId: 'native-subagent-thread',
      agentPath: 'reviewer',
      kind: 'started',
    };
    normalizer.notification('item/started', { threadId: 'native-thread', turnId: 'native-turn', item });
    normalizer.notification('item/completed', {
      threadId: 'native-thread',
      turnId: 'native-turn',
      item,
    });
    normalizer.notification('turn/completed', {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'failed' },
    });

    const subagentEvents = events.filter((event) => event.type === 'subagent.status');
    expect(subagentEvents).toHaveLength(2);
    // The turn itself failed, so a child left open when it ends must not be reported as having
    // completed successfully -- that would misrepresent what actually happened.
    expect((subagentEvents[1] as { status: string }).status).toBe('failed');
  });

  it('treats an explicit interrupted kind as real evidence of cancellation, not the turn-end heuristic', () => {
    const events: AgentEventV2[] = [];
    const normalizer = new CodexAppServerNormalizer((event) => events.push(event));
    normalizer.startSession('native-thread', CODEX_APP_SERVER_TRANSPORT.id, SELECTION);
    normalizer.expectTurn(TURN_ID);
    normalizer.bindTurnResponse('native-turn');
    normalizer.notification('turn/started', {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'inProgress' },
    });
    const item = {
      type: 'subAgentActivity',
      id: 'subagent-item-1',
      agentThreadId: 'native-subagent-thread',
      agentPath: 'reviewer',
      kind: 'interrupted',
    };
    normalizer.notification('item/started', { threadId: 'native-thread', turnId: 'native-turn', item });
    normalizer.notification('item/completed', {
      threadId: 'native-thread',
      turnId: 'native-turn',
      item,
    });
    normalizer.notification('turn/completed', {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'completed' },
    });

    const subagentEvents = events.filter((event) => event.type === 'subagent.status');
    // Exactly one: only item/completed emits (item/started is a no-op for this item type, see
    // itemStarted()), reporting kind 'interrupted' -> 'cancelled'. The turn-end heuristic in
    // closeOpenSubagents() must not fire a second, redundant 'completed' event for a child that
    // already has a real, provider-confirmed terminal status.
    expect(subagentEvents).toHaveLength(1);
    expect((subagentEvents[0] as { status: string }).status).toBe('cancelled');
  });

  it('normalizes a real subAgentActivity sequence end to end through the fixture process', async () => {
    const instance = transport('subagent');
    await instance.started;
    const events = await until(
      instance,
      (event) => event.type === 'session.status' && event.status === 'idle',
    );
    const subagentEvents = events.filter(
      (event) => event.type === 'subagent.status',
    ) as Extract<AgentEventV2, { type: 'subagent.status' }>[];
    expect(subagentEvents.map((event) => event.status)).toEqual(['spawning', 'running', 'completed']);
    expect(new Set(subagentEvents.map((event) => event.agentId)).size).toBe(1);
    expect(subagentEvents.every((event) => event.nativeChildId === 'native-subagent-thread-1')).toBe(
      true,
    );
  });

  it.each([
    ['item/commandExecution/outputDelta', { delta: 'late' }],
    ['item/fileChange/outputDelta', { delta: 'late' }],
    ['item/fileChange/patchUpdated', {}],
    ['item/mcpToolCall/progress', { message: 'late' }],
    ['item/reasoning/summaryPartAdded', { summaryIndex: 0 }],
  ])('rejects %s after the tracked item completed', (method, extra) => {
    const normalizer = new CodexAppServerNormalizer(() => undefined);
    normalizer.startSession('native-thread', CODEX_APP_SERVER_TRANSPORT.id, SELECTION);
    normalizer.expectTurn(TURN_ID);
    normalizer.bindTurnResponse('native-turn');
    normalizer.notification('turn/started', {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'inProgress' },
    });
    normalizer.notification('item/started', {
      threadId: 'native-thread',
      turnId: 'native-turn',
      item: {
        id: 'completed-item',
        type: 'mcpToolCall',
        server: 'fixture',
        tool: 'read',
      },
    });
    normalizer.notification('item/completed', {
      threadId: 'native-thread',
      turnId: 'native-turn',
      item: {
        id: 'completed-item',
        type: 'mcpToolCall',
        server: 'fixture',
        tool: 'read',
        status: 'completed',
      },
    });

    expect(() =>
      normalizer.notification(method, {
        threadId: 'native-thread',
        turnId: 'native-turn',
        itemId: 'completed-item',
        ...extra,
      }),
    ).toThrow('after completion');
  });

  it('correlates omitted notifications and bounds retained native IDs', () => {
    const early = new CodexAppServerNormalizer(() => undefined);
    early.notification('thread/started', { thread: { id: 'early-thread' } });
    expect(() =>
      early.startSession('early-thread', CODEX_APP_SERVER_TRANSPORT.id, SELECTION),
    ).not.toThrow();

    const normalizer = new CodexAppServerNormalizer(() => undefined);
    normalizer.startSession('native-thread', CODEX_APP_SERVER_TRANSPORT.id, SELECTION);
    normalizer.expectTurn(TURN_ID);
    expect(() => normalizer.bindTurnResponse('t'.repeat(1_025))).toThrow('Invalid native turn id');
    normalizer.bindTurnResponse('native-turn');
    expect(() =>
      normalizer.notification('remoteControl/status/changed', {
        installationId: 'installation',
        serverName: 'codex',
        status: 'disabled',
      }),
    ).not.toThrow();
    expect(() =>
      normalizer.notification('remoteControl/status/changed', {
        installationId: 'installation',
        serverName: 'codex',
        status: 'unexpected',
      }),
    ).toThrow('Invalid remote-control status');
    expect(() =>
      normalizer.notification('warning', {
        message: 'fixture warning',
        threadId: 'native-thread',
      }),
    ).not.toThrow();
    expect(() =>
      normalizer.notification('mcpServer/startupStatus/updated', {
        name: 'fixture',
        status: 'ready',
        threadId: 'native-thread',
        error: null,
        failureReason: null,
      }),
    ).not.toThrow();
    expect(() =>
      normalizer.notification('account/rateLimits/updated', { rateLimits: {} }),
    ).not.toThrow();
    normalizer.notification('turn/started', {
      threadId: 'native-thread',
      turn: { id: 'native-turn', status: 'inProgress' },
    });

    expect(() =>
      normalizer.notification('thread/started', { thread: { id: 'other-thread' } }),
    ).toThrow('another thread');
    expect(() =>
      normalizer.notification('thread/status/changed', {
        threadId: 'other-thread',
        status: 'idle',
      }),
    ).toThrow('another thread');
    expect(() =>
      normalizer.notification('turn/diff/updated', {
        threadId: 'native-thread',
        turnId: 'other-turn',
        diff: '',
      }),
    ).toThrow('inactive turn');
    expect(() =>
      normalizer.notification('item/mcpToolCall/progress', {
        threadId: 'native-thread',
        turnId: 'native-turn',
        itemId: 'stale-item',
        message: 'stale',
      }),
    ).toThrow('unknown item');
    expect(() =>
      normalizer.notification('item/started', {
        threadId: 'native-thread',
        turnId: 'native-turn',
        item: {
          id: 'i'.repeat(1_025),
          type: 'mcpToolCall',
          server: 'fixture',
          tool: 'read',
        },
      }),
    ).toThrow('Invalid native item id');

    normalizer.notification('item/started', {
      threadId: 'native-thread',
      turnId: 'native-turn',
      item: { id: 'known-item', type: 'mcpToolCall', server: 'fixture', tool: 'read' },
    });
    expect(() =>
      normalizer.notification('item/mcpToolCall/progress', {
        threadId: 'native-thread',
        turnId: 'native-turn',
        itemId: 'i'.repeat(1_025),
        message: 'oversized',
      }),
    ).toThrow('Invalid native item id');
    expect(() =>
      normalizer.notification('item/mcpToolCall/progress', {
        threadId: 'native-thread',
        turnId: 'native-turn',
        itemId: 'known-item',
        message: 'ok',
      }),
    ).not.toThrow();
  });

  it('correlates concurrent client responses out of order and clears pending requests on shutdown', async () => {
    const writes: Buffer[] = [];
    const fatals: Error[] = [];
    const rpc = new CodexAppServerRpc({
      write: async (frame) => {
        writes.push(frame);
      },
      onNotification: () => undefined,
      onRequest: () => undefined,
      onFatal: (error) => fatals.push(error),
    });

    const first = rpc.request('model/list', {});
    const second = rpc.request('modelProvider/capabilities/read', {});
    expect(writes).toHaveLength(2);
    const firstId = (JSON.parse(writes[0]!.toString('utf8')) as { id: number }).id;
    const secondId = (JSON.parse(writes[1]!.toString('utf8')) as { id: number }).id;

    rpc.acceptStdout(Buffer.from(`${JSON.stringify({ id: secondId, result: { order: 2 } })}\n`));
    await expect(second).resolves.toEqual({ order: 2 });
    rpc.acceptStdout(Buffer.from(`${JSON.stringify({ id: firstId, result: { order: 1 } })}\n`));
    await expect(first).resolves.toEqual({ order: 1 });
    expect(fatals).toEqual([]);

    const pending = rpc.request('model/list', {});
    rpc.shutdown();
    await expect(pending).rejects.toThrow('closed');
  });

  it('handshakes once, normalizes stable events, redacts unsafe payloads, and reaps on close', async () => {
    const instance = transport();
    await instance.started;
    expect(await instance.accepted).toBe('accepted');
    expect(instance.providerSessionId).toBe('native-thread-1');
    expect(instance.continuationEvidence).toEqual({
      accountFingerprint: createHash('sha256').update('fixture@example.test').digest('hex'),
      selectedModel: 'fake-model',
    });
    expect(instance.runtimeMetadata).toMatchObject({
      cliVersion: '0.147.0',
      fixtureSet: 'codex-app-server-0.147.0-v1',
    });
    expect(instance.modelCatalog).toEqual([
      { id: 'fake-model', displayName: 'Fake model', isDefault: true },
    ]);
    expect(instance.modelProviderCapabilities).toEqual({
      imageGeneration: false,
      namespaceTools: true,
      webSearch: true,
    });

    const events = await until(
      instance,
      (event) => event.type === 'session.status' && event.status === 'idle',
    );
    expect(events[0]).toMatchObject({
      type: 'session.started',
      provider: 'codex',
      transport: CODEX_APP_SERVER_TRANSPORT.id,
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'turn.started',
        'content.delta',
        'content.completed',
        'tool.started',
        'tool.completed',
        'usage.tokens',
        'extension.summary',
        'turn.completed',
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'content.completed',
          block: expect.objectContaining({ type: 'plan' }),
        }),
        expect.objectContaining({
          type: 'extension.summary',
          extensionName: 'codex.reasoning',
          reason: 'redacted',
        }),
      ]),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('must-not-surface');
    expect(serialized).not.toContain('private chain of thought');
    expect(serialized).not.toContain('secret-diff');
    await instance.close();
    expect(instance.reaped).toBe(true);
  });

  it.each([
    ['malformed', 'invalid UTF-8 JSON'],
    ['invalid-utf8', 'invalid UTF-8 JSON'],
    ['oversized', 'exceeded 1 MiB'],
    ['deep-json', 'structural bounds'],
    ['duplicate-response', 'duplicate response id'],
  ])(
    'fails bounded framing/correlation for %s before the initial turn is delivered',
    async (scenario, message) => {
      const instance = transport(scenario);
      await expect(instance.started).rejects.toThrow(message);
      expect(await instance.accepted).toBe('not_accepted');
      expect(instance.workDeliveryState).toBe('not_delivered');
      expect(instance.reaped).toBe(true);
    },
  );

  it('rejects changed account evidence before any resume thread request', async () => {
    const fresh = transport('normal');
    await fresh.started;
    const issuedEvidence = fresh.continuationEvidence;
    expect(issuedEvidence).toBeDefined();
    await fresh.close();

    const instance = transport(
      'normal',
      { kind: 'resume', threadId: 'prior-thread' },
      { FAKE_CODEX_ACCOUNT_EMAIL: 'other@example.test' },
      issuedEvidence,
    );
    await expect(instance.started).rejects.toMatchObject({
      reasonCode: 'codex_continuation_scope_changed',
      deliveryState: 'not_delivered',
    });
    expect(instance.providerSessionId).toBeUndefined();
    expect(instance.workDeliveryState).toBe('not_delivered');
    expect(instance.reaped).toBe(true);
  });

  it('keeps fallback eligible after thread selection but before turn/start is written', async () => {
    const instance = transport('post-thread-invalid-response');
    await expect(instance.started).rejects.toThrow('Invalid thread id');
    expect(await instance.accepted).toBe('not_accepted');
    expect(instance.workDeliveryState).toBe('not_delivered');
    expect(instance.reaped).toBe(true);
  });

  it('revalidates daemon trust immediately before turn/start and reaps without delivery on denial', async () => {
    const beforeWorkDelivery = vi.fn(async () => {
      throw new Error('workspace trust changed');
    });
    const instance = transport('normal', undefined, {}, undefined, {}, beforeWorkDelivery);

    await expect(instance.started).rejects.toMatchObject({ deliveryState: 'not_delivered' });
    expect(beforeWorkDelivery).toHaveBeenCalledOnce();
    expect(await instance.accepted).toBe('not_accepted');
    expect(instance.workDeliveryState).toBe('not_delivered');
    expect(instance.reaped).toBe(true);
  });

  it('publishes same-process scope evidence once before any provider thread request', async () => {
    const order: string[] = [];
    const beforeProviderThreadStart = vi.fn(
      async (evidence: Readonly<ProviderContinuationEvidence> | undefined) => {
        order.push('scope');
        expect(evidence).toEqual({
          accountFingerprint: createHash('sha256').update('fixture@example.test').digest('hex'),
          selectedModel: 'fake-model',
        });
      },
    );
    const beforeWorkDelivery = vi.fn(async () => {
      order.push('work');
    });
    const instance = transport(
      'normal',
      undefined,
      {},
      undefined,
      {},
      beforeWorkDelivery,
      beforeProviderThreadStart,
    );

    await instance.started;
    expect(beforeProviderThreadStart).toHaveBeenCalledOnce();
    expect(beforeWorkDelivery).toHaveBeenCalledOnce();
    expect(order).toEqual(['scope', 'work']);
  });

  it('reaps without a thread request when the same-process scope gate denies startup', async () => {
    const beforeWorkDelivery = vi.fn(async () => undefined);
    const beforeProviderThreadStart = vi.fn(async () => {
      throw new Error('fallback scope planning denied startup');
    });
    const instance = transport(
      'normal',
      undefined,
      {},
      undefined,
      {},
      beforeWorkDelivery,
      beforeProviderThreadStart,
    );

    await expect(instance.started).rejects.toMatchObject({ deliveryState: 'not_delivered' });
    expect(beforeProviderThreadStart).toHaveBeenCalledOnce();
    expect(beforeWorkDelivery).not.toHaveBeenCalled();
    expect(instance.providerSessionId).toBeUndefined();
    expect(instance.reaped).toBe(true);
  });

  it('rejects effective thread scope drift before delivering the initial turn', async () => {
    const instance = transport('thread-scope-drift');
    await expect(instance.started).rejects.toThrow('effective sandbox changed');
    expect(await instance.accepted).toBe('not_accepted');
    expect(instance.workDeliveryState).toBe('not_delivered');
    expect(instance.reaped).toBe(true);
  });

  it.each([
    [
      'resume-id-mismatch',
      { kind: 'resume', threadId: 'prior-thread' } as const,
      'resume response belongs to another thread',
    ],
    [
      'fork-id-mismatch',
      { kind: 'fork', threadId: 'prior-thread' } as const,
      'fork response reused the source thread',
    ],
  ])('rejects %s before delivering the initial turn', async (scenario, continuation, message) => {
    const instance = transport(scenario, continuation);
    await expect(instance.started).rejects.toThrow(message);
    expect(await instance.accepted).toBe('not_accepted');
    expect(instance.workDeliveryState).toBe('not_delivered');
    expect(instance.reaped).toBe(true);
  });

  it('rejects provider-controlled UNC thread paths before delivering the initial turn', async () => {
    const instance = transport('thread-unc-drift');
    await expect(instance.started).rejects.toThrow('Invalid effective thread cwd');
    expect(await instance.accepted).toBe('not_accepted');
    expect(instance.workDeliveryState).toBe('not_delivered');
    expect(instance.reaped).toBe(true);
  });

  it.each(['account-api-key', 'account-missing'])(
    'rejects changed or missing authentication in %s before any thread request',
    async (scenario) => {
      const instance = transport(scenario);
      await expect(instance.started).rejects.toMatchObject({
        reasonCode: 'codex_auth_scope_changed',
        deliveryState: 'not_delivered',
      });
      expect(instance.providerSessionId).toBeUndefined();
      expect(instance.reaped).toBe(true);
    },
  );

  it('accepts a live API-key account only when detection pinned that auth source', async () => {
    const beforeProviderThreadStart = vi.fn(async () => undefined);
    const instance = transport(
      'account-api-key',
      undefined,
      {},
      undefined,
      { authSource: 'api_key' },
      undefined,
      beforeProviderThreadStart,
    );
    await instance.started;
    expect(instance.providerSessionId).toBe('native-thread-1');
    expect(instance.continuationEvidence).toBeUndefined();
    expect(beforeProviderThreadStart).toHaveBeenCalledWith(undefined);
  });

  it('fails before thread creation when selected continuation has no bindable identity', async () => {
    const selection: CapabilitySelection = {
      ...SELECTION,
      enabled: [
        {
          id: 'session.resume',
          constraints: { kind: 'continuation', native: true },
        },
      ],
    };
    const instance = transport(
      'account-api-key',
      undefined,
      {},
      undefined,
      { authSource: 'api_key' },
      undefined,
      undefined,
      selection,
    );
    await expect(instance.started).rejects.toMatchObject({
      reasonCode: 'codex_continuation_scope_unverified',
      deliveryState: 'not_delivered',
    });
    expect(instance.providerSessionId).toBeUndefined();
    expect(instance.reaped).toBe(true);
  });

  it('rejects a detected-account fingerprint change before any thread request', async () => {
    const detectedFingerprint = createHash('sha256').update('fixture@example.test').digest('hex');
    const instance = transport(
      'normal',
      undefined,
      { FAKE_CODEX_ACCOUNT_EMAIL: 'changed@example.test' },
      undefined,
      { accountFingerprint: detectedFingerprint },
    );
    await expect(instance.started).rejects.toMatchObject({
      reasonCode: 'codex_auth_scope_changed',
      deliveryState: 'not_delivered',
    });
    expect(instance.providerSessionId).toBeUndefined();
    expect(instance.reaped).toBe(true);
  });

  it('keeps fallback eligible when initialization fails before thread startup', async () => {
    const instance = transport('malformed-initialize');
    await expect(instance.started).rejects.toThrow('invalid UTF-8 JSON');
    expect(await instance.accepted).toBe('not_accepted');
    expect(instance.workDeliveryState).toBe('not_delivered');
    expect(instance.reaped).toBe(true);
  });

  it('fails an unknown response id without confusing it with a pending request', async () => {
    const instance = transport('unknown-response');
    await expect(instance.started).rejects.toThrow('unknown response id');
    expect(await instance.accepted).toBe('not_accepted');
    expect(instance.workDeliveryState).toBe('not_delivered');
  });

  it('fails closed for an unknown server notification without dispatching its payload', async () => {
    const instance = transport('unknown-notification');
    await instance.started;
    const seen: AgentEventV2[] = [];
    await expect(
      (async () => {
        while (true) {
          const result = await next(instance.events);
          if (result.done) return;
          seen.push(result.value as AgentEventV2);
        }
      })(),
    ).rejects.toThrow('Unsupported Codex server notification');
    expect(JSON.stringify(seen)).not.toContain('must-not-surface');
  });

  it('correlates a string server id separately and maps allow_session to one-shot native accept', async () => {
    const instance = transport('approval');
    await instance.started;
    const events = await until(instance, (event) => event.type === 'approval.requested');
    const approval = events.at(-1) as Extract<AgentEventV2, { type: 'approval.requested' }>;
    expect(approval.allowedDecisions).toEqual(['allow_once', 'deny']);
    await instance.send({
      type: 'approval.respond',
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      requestId: approval.requestId,
      decision: 'allow_session',
    });
    const completed = await until(
      instance,
      (event) => event.type === 'session.status' && event.status === 'idle',
    );
    expect(completed.some((event) => event.type === 'turn.completed')).toBe(true);
  });

  it('allows schema-valid approval callbacks sharing an item id when their approval ids differ', async () => {
    const instance = transport('duplicate-item');
    await instance.started;
    const firstEvents = await until(instance, (event) => event.type === 'approval.requested');
    const first = firstEvents.at(-1) as Extract<AgentEventV2, { type: 'approval.requested' }>;
    const secondResult = await next(instance.events);
    expect(secondResult.done).toBe(false);
    const second = secondResult.value as Extract<AgentEventV2, { type: 'approval.requested' }>;
    expect(second.type).toBe('approval.requested');
    expect(second.requestId).not.toBe(first.requestId);
    await instance.send({
      type: 'approval.respond',
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      requestId: first.requestId,
      decision: 'allow_once',
    });
    await instance.send({
      type: 'approval.respond',
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      requestId: second.requestId,
      decision: 'allow_once',
    });
    await until(instance, (event) => event.type === 'session.status' && event.status === 'idle');
  });

  it('fails closed before publishing approval text with bidi or control formatting', async () => {
    const instance = transport('active');
    await instance.started;
    await until(instance, (event) => event.type === 'turn.started');
    const request = serverRequest('spoofed-command', 'item/commandExecution/requestApproval', {
      threadId: 'native-thread-1',
      turnId: 'native-turn-1',
      itemId: 'spoofed-item',
      approvalId: 'spoofed-approval',
      command: 'echo harmless\u202Etxt.exe',
      cwd: process.cwd(),
    });
    await expect(
      (
        instance as unknown as {
          handleServerRequest(request: IncomingRequestResponder): Promise<void>;
        }
      ).handleServerRequest(request.request),
    ).rejects.toMatchObject({ code: 'interaction_invalid' });
    expect(request.replies).toEqual([]);
  });

  it('fails closed before publishing a canonical approval target with unsafe formatting', async () => {
    const unsafeTarget = mkdtempSync(join(process.cwd(), 'codex-approval-\u202E-'));
    try {
      const instance = transport('active');
      await instance.started;
      await until(instance, (event) => event.type === 'turn.started');
      const request = serverRequest('spoofed-path', 'item/fileChange/requestApproval', {
        threadId: 'native-thread-1',
        turnId: 'native-turn-1',
        itemId: 'spoofed-item',
        approvalId: 'spoofed-path-approval',
        grantRoot: unsafeTarget,
      });
      await expect(
        (
          instance as unknown as {
            handleServerRequest(request: IncomingRequestResponder): Promise<void>;
          }
        ).handleServerRequest(request.request),
      ).rejects.toMatchObject({ code: 'interaction_invalid' });
      expect(request.replies).toEqual([]);
    } finally {
      rmSync(unsafeTarget, { recursive: true, force: true });
    }
  });

  it.each([
    ['C0', '\u0007'],
    ['C1', '\u0085'],
  ])(
    'fails closed before publishing an approval target with unsafe %s formatting',
    async (_, unsafe) => {
      const instance = transport('active');
      await instance.started;
      await until(instance, (event) => event.type === 'turn.started');
      const request = serverRequest(
        `spoofed-${unsafe.codePointAt(0)}`,
        'item/fileChange/requestApproval',
        {
          threadId: 'native-thread-1',
          turnId: 'native-turn-1',
          itemId: 'spoofed-item',
          approvalId: 'spoofed-path-approval',
          grantRoot: join(process.cwd(), `codex-approval-${unsafe}`),
        },
      );
      await expect(
        (
          instance as unknown as {
            handleServerRequest(request: IncomingRequestResponder): Promise<void>;
          }
        ).handleServerRequest(request.request),
      ).rejects.toMatchObject({ code: 'interaction_invalid' });
      expect(request.replies).toEqual([]);
    },
  );

  it('never exposes an unsafe MCP property key through display fallbacks', async () => {
    const instance = transport('active');
    await instance.started;
    await until(instance, (event) => event.type === 'turn.started');
    const request = serverRequest('mcp-unsafe-property-key', 'mcpServer/elicitation/request', {
      threadId: 'native-thread-1',
      turnId: 'native-turn-1',
      serverName: 'fixture',
      mode: 'form',
      elicitationId: 'elicitation-unsafe-property-key',
      message: 'Complete form',
      requestedSchema: {
        type: 'object',
        properties: {
          ['secret\u202Etxt']: { type: 'string' },
        },
      },
    });
    await (
      instance as unknown as {
        handleServerRequest(request: IncomingRequestResponder): Promise<void>;
      }
    ).handleServerRequest(request.request);
    const events = await until(instance, (event) => event.type === 'question.requested');
    const question = events.at(-1) as Extract<AgentEventV2, { type: 'question.requested' }>;
    expect(question.questions).toHaveLength(1);
    expect(question.questions[0]?.title).toBe('secret txt');
    expect(question.questions[0]?.prompt).toBe('secret txt');
    expect(JSON.stringify(question)).not.toContain('\u202E');
  });

  it('cancels request-local MCP URL elicitations that lack a turn or have an unsafe target', async () => {
    const instance = transport('active');
    await instance.started;
    await until(instance, (event) => event.type === 'turn.started');
    const handleServerRequest = (
      instance as unknown as {
        handleServerRequest(request: IncomingRequestResponder): Promise<void>;
      }
    ).handleServerRequest.bind(instance);
    const missingTurn = serverRequest('mcp-null-turn', 'mcpServer/elicitation/request', {
      threadId: 'native-thread-1',
      turnId: null,
      serverName: 'fixture',
      mode: 'url',
      elicitationId: 'elicitation-null-turn',
      message: 'Open URL',
      url: 'https://example.test/',
    });
    await handleServerRequest(missingTurn.request);
    expect(missingTurn.replies).toEqual([
      { result: { action: 'cancel', content: null, _meta: null } },
    ]);
    const unsafe = serverRequest('mcp-credentials', 'mcpServer/elicitation/request', {
      threadId: 'native-thread-1',
      turnId: 'native-turn-1',
      serverName: 'fixture',
      mode: 'url',
      elicitationId: 'elicitation-credentials',
      message: 'Open URL',
      url: 'https://user:password@example.test/',
    });
    await handleServerRequest(unsafe.request);
    expect(unsafe.replies).toEqual([{ result: { action: 'cancel', content: null, _meta: null } }]);
  });

  it('binds MCP approval to the exact URL while persisting only its safe origin', async () => {
    const instance = transport('active');
    await instance.started;
    await until(instance, (event) => event.type === 'turn.started');
    const request = serverRequest('mcp-safe-url', 'mcpServer/elicitation/request', {
      threadId: 'native-thread-1',
      turnId: 'native-turn-1',
      serverName: 'fixture',
      mode: 'url',
      elicitationId: 'elicitation-safe-url',
      message: 'Open URL',
      url: 'https://example.test/path?mode=confirm',
    });
    await (
      instance as unknown as {
        handleServerRequest(request: IncomingRequestResponder): Promise<void>;
      }
    ).handleServerRequest(request.request);
    const events = await until(instance, (event) => event.type === 'approval.requested');
    const approval = events.at(-1) as Extract<AgentEventV2, { type: 'approval.requested' }>;
    expect(approval.target).toBe('https://example.test');
    expect(approval.permission?.safeTargetSummary).toBe(approval.target);
    expect(approval.permission?.targetFingerprint).toBe(
      createHash('sha256').update('https://example.test/path?mode=confirm').digest('hex'),
    );
    expect(JSON.stringify(approval)).not.toContain('mode=confirm');
    await instance.send({
      type: 'approval.respond',
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      requestId: approval.requestId,
      decision: 'allow_once',
    });
    expect(request.replies).toEqual([{ result: { action: 'accept', content: null, _meta: null } }]);
  });

  it('rejects opaque permission profiles and reconstructs only validated granted fields', async () => {
    const instance = transport('active');
    await instance.started;
    await until(instance, (event) => event.type === 'turn.started');
    const handleServerRequest = (
      instance as unknown as {
        handleServerRequest(request: IncomingRequestResponder): Promise<void>;
      }
    ).handleServerRequest.bind(instance);
    const opaque = serverRequest('permissions-opaque', 'item/permissions/requestApproval', {
      threadId: 'native-thread-1',
      turnId: 'native-turn-1',
      itemId: 'permissions-opaque',
      startedAtMs: 1,
      cwd: process.cwd(),
      permissions: { network: { enabled: true, undisplayed: 'must-not-surface' } },
    });
    await expect(handleServerRequest(opaque.request)).rejects.toThrow(
      'Unsupported network permissions field',
    );
    const valid = serverRequest('permissions-valid', 'item/permissions/requestApproval', {
      threadId: 'native-thread-1',
      turnId: 'native-turn-1',
      itemId: 'permissions-valid',
      startedAtMs: 1,
      cwd: process.cwd(),
      permissions: { network: { enabled: true } },
    });
    await handleServerRequest(valid.request);
    const events = await until(instance, (event) => event.type === 'approval.requested');
    const approval = events.at(-1) as Extract<AgentEventV2, { type: 'approval.requested' }>;
    expect(JSON.stringify(approval)).not.toContain('must-not-surface');
    await instance.send({
      type: 'approval.respond',
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      requestId: approval.requestId,
      decision: 'allow_once',
    });
    expect(valid.replies).toEqual([
      { result: { permissions: { network: { enabled: true } }, scope: 'turn' } },
    ]);
  });

  it.each([
    ['network-approval', 'network', 'https://example.test:443'],
    ['file-approval', 'filesystem', process.cwd()],
    ['permissions-approval', 'network', 'permissions:{"network":{"enabled":true}}'],
  ])(
    'normalizes %s with a canonical target and a provider one-turn grant',
    async (scenario, actionClass, target) => {
      const instance = transport(scenario);
      await instance.started;
      const events = await until(instance, (event) => event.type === 'approval.requested');
      const approval = events.at(-1) as Extract<AgentEventV2, { type: 'approval.requested' }>;
      expect(approval.permission?.actionClass).toBe(actionClass);
      expect(approval.target).toBe(target);
      expect(JSON.stringify(approval)).not.toContain('command-approval');
      await instance.send({
        type: 'approval.respond',
        commandId: COMMAND_ID,
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        requestId: approval.requestId,
        decision: 'allow_session',
      });
      await until(instance, (event) => event.type === 'session.status' && event.status === 'idle');
    },
  );

  it('maps an MCP form without exposing its native correlation id', async () => {
    const instance = transport('mcp-form');
    await instance.started;
    const events = await until(instance, (event) => event.type === 'question.requested');
    const question = events.at(-1) as Extract<AgentEventV2, { type: 'question.requested' }>;
    expect(JSON.stringify(question)).not.toContain('mcp-1');
    const optionId = question.questions[0]!.options?.[0]?.id;
    expect(optionId).toBeTruthy();
    await expect(
      instance.send({
        type: 'question.respond',
        commandId: COMMAND_ID,
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        requestId: question.requestId,
        answers: [
          {
            questionId: question.questions[0]!.id,
            value: ['123e4567-e89b-42d3-a456-426614174299'],
          },
        ],
      }),
    ).rejects.toThrow('did not match');
    await instance.send({
      type: 'question.respond',
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      requestId: question.requestId,
      answers: [{ questionId: question.questions[0]!.id, value: [optionId!] }],
    });
    await until(instance, (event) => event.type === 'session.status' && event.status === 'idle');
  });

  it('honors provider-side request resolution and makes a later UI response stale', async () => {
    const instance = transport('approval-resolved');
    await instance.started;
    const events = await until(instance, (event) => event.type === 'approval.resolved');
    const requested = events.find(
      (event): event is Extract<AgentEventV2, { type: 'approval.requested' }> =>
        event.type === 'approval.requested',
    );
    expect(events.at(-1)).toMatchObject({
      type: 'approval.resolved',
      decision: 'denied',
      actor: 'policy',
    });
    await expect(
      instance.send({
        type: 'approval.respond',
        commandId: COMMAND_ID,
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        requestId: requested!.requestId,
        decision: 'allow_once',
      }),
    ).rejects.toThrow('stale');
  });

  it.each([
    'secret-question',
    'question',
    'hidden-command',
    'unc-approval',
    'unknown-request',
    'delta-disagreement',
    'missing-item',
  ])('fails closed for %s without exposing native payloads', async (scenario) => {
    const instance = transport(scenario);
    await instance.started;
    const seen: AgentEventV2[] = [];
    await expect(
      (async () => {
        while (true) {
          const result = await next(instance.events);
          if (result.done) return;
          seen.push(result.value as AgentEventV2);
        }
      })(),
    ).rejects.toThrow();
    expect(JSON.stringify(seen)).not.toContain('must-not-surface');
    expect(JSON.stringify(seen)).not.toContain('Token?');
  });

  it('marks an oversized completed message as truncated with exact bytes and digest', async () => {
    const instance = transport('large-completed');
    await instance.started;
    const events = await until(
      instance,
      (event) => event.type === 'session.status' && event.status === 'idle',
    );
    const completed = events.find(
      (event) =>
        event.type === 'content.completed' &&
        event.block.type === 'provider_extension' &&
        event.block.representation === 'safe_summary' &&
        event.block.reason === 'truncated',
    ) as Extract<AgentEventV2, { type: 'content.completed' }> | undefined;
    expect(completed).toBeDefined();
    if (
      !completed ||
      completed.block.type !== 'provider_extension' ||
      completed.block.representation !== 'safe_summary'
    ) {
      throw new Error('missing block');
    }
    const encoded = Buffer.from(
      JSON.stringify({ type: 'text', id: completed.block.id, text: 'x'.repeat(300 * 1024) }),
    );
    expect(completed.block.originalBytes).toBe(encoded.byteLength);
    expect(completed.block.sha256).toBe(createHash('sha256').update(encoded).digest('hex'));
    expect(JSON.stringify(events)).not.toContain('x'.repeat(1_024));
  });

  it('maps follow-up, steer, and interrupt to the active native thread', async () => {
    const followUp = transport();
    await followUp.started;
    await until(followUp, (event) => event.type === 'session.status' && event.status === 'idle');
    const command: AgentCommandV2 = {
      type: 'input.follow_up',
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      turnId: FOLLOW_UP_TURN_ID,
      content: [{ type: 'text', id: '123e4567-e89b-42d3-a456-426614174205', text: 'next' }],
    };
    await followUp.send(command);
    const followEvents = await until(
      followUp,
      (event) => event.type === 'session.status' && event.status === 'idle',
    );
    expect(followEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'turn.started', turnId: FOLLOW_UP_TURN_ID }),
      ]),
    );

    const active = transport('active');
    await active.started;
    await until(active, (event) => event.type === 'turn.started');
    await active.send({
      type: 'input.steer',
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      content: [{ type: 'text', id: '123e4567-e89b-42d3-a456-426614174206', text: 'steer' }],
    });
    await active.interrupt();
    const interrupted = await until(
      active,
      (event) => event.type === 'session.status' && event.status === 'idle',
    );
    expect(interrupted.some((event) => event.type === 'turn.interrupted')).toBe(true);
  });

  it('rejects a steer response correlated to another native turn', async () => {
    const instance = transport('steer-mismatch');
    await instance.started;
    await until(instance, (event) => event.type === 'turn.started');
    await expect(
      instance.send({
        type: 'input.steer',
        commandId: COMMAND_ID,
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        content: [
          {
            type: 'text',
            id: '123e4567-e89b-42d3-a456-426614174207',
            text: 'steer elsewhere',
          },
        ],
      }),
    ).rejects.toThrow('another turn');
  });

  it.each([
    [{ kind: 'resume', threadId: 'prior-thread' } as const, 'thread/resume', 'prior-thread'],
    [
      { kind: 'fork', threadId: 'prior-thread', lastTurnId: 'last-turn' } as const,
      'thread/fork',
      'native-thread-1',
    ],
  ])('uses native continuation %s', async (continuation, expectedMethod, expectedThreadId) => {
    const instance = transport('normal', continuation, {
      FAKE_CODEX_EXPECT_THREAD_METHOD: expectedMethod,
    });
    await instance.started;
    expect(instance.providerSessionId).toBe(expectedThreadId);
  });

  it('supervises an interrupt timeout into one last terminal and a reaped child', async () => {
    const instance = transport('ignore-interrupt');
    const handle = await superviseInteractiveSession(
      instance,
      {
        sessionId: SESSION_ID,
        executionId: EXECUTION_ID,
        turnId: TURN_ID,
        cwd: process.cwd(),
        prompt: 'hello fixture',
        transport: CODEX_APP_SERVER_TRANSPORT,
        selection: SELECTION,
      },
      { commandTimeoutMs: 1_000, closeTimeoutMs: 2_000 },
    );
    const observed: AgentEventV2[] = [];
    while (true) {
      const result = await next(handle.events);
      if (result.done) throw new Error('session ended before active turn');
      const event = result.value as AgentEventV2;
      observed.push(event);
      if (event.type === 'turn.started') break;
    }
    await expect(handle.interrupt()).rejects.toThrow();
    for await (const event of handle.events) observed.push(event);
    const terminals = observed.filter((event) =>
      ['session.completed', 'session.failed', 'session.cancelled', 'session.interrupted'].includes(
        event.type,
      ),
    );
    expect(terminals).toHaveLength(1);
    expect(observed.at(-1)).toMatchObject({ type: 'session.failed' });
    expect(instance.reaped).toBe(true);
  });
});
