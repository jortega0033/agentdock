import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentEventV2, CapabilitySelection } from '@agent-dock/shared';
import type { Options, PermissionResult, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  ClaudeAgentSdkTransport,
  type ClaudeAgentSdkFactory,
  type ClaudeAgentSdkQuery,
} from '../src/providers/claude/sdk/index.js';
import { resolveClaudeSdkConfigDir } from '../src/providers/claude/sdk-options.js';

const testConfigRoot = mkdtempSync(join(tmpdir(), 'agent-dock-claude-sdk-test-'));

afterAll(() => rmSync(testConfigRoot, { recursive: true, force: true }));

class FakeQuery implements ClaudeAgentSdkQuery {
  readonly inputs: SDKUserMessage[] = [];
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(() => this.end());
  private readonly values: unknown[] = [];
  private readonly waiters: Array<(value: IteratorResult<unknown, void>) => void> = [];
  private ended = false;

  constructor(prompt: string | AsyncIterable<SDKUserMessage>) {
    if (typeof prompt === 'string') throw new Error('expected streaming input');
    void this.consumeInput(prompt);
  }

  push(message: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.values.push(message);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown, void> {
    return {
      next: async () => {
        if (this.values.length > 0) return { value: this.values.shift(), done: false };
        if (this.ended) return { value: undefined, done: true };
        return new Promise<IteratorResult<unknown, void>>((resolveValue) => {
          this.waiters.push(resolveValue);
        });
      },
    };
  }

  private async consumeInput(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const message of prompt) this.inputs.push(message);
  }
}

interface FakeHarness {
  factory: ClaudeAgentSdkFactory;
  query(): FakeQuery;
  options(): Options;
  startup: ReturnType<typeof vi.fn>;
}

function launchFakeManagedProcess(options: Options | undefined): void {
  options?.spawnClaudeCodeProcess?.({
    command: 'fake-claude',
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
}

function fakeHarness(): FakeHarness {
  let queryValue: FakeQuery | undefined;
  let optionsValue: Options | undefined;
  const startup = vi.fn(async (parameters?: { options?: Options }) => {
    optionsValue = parameters?.options;
    launchFakeManagedProcess(optionsValue);
    return {
      query(prompt: string | AsyncIterable<SDKUserMessage>) {
        queryValue = new FakeQuery(prompt);
        return queryValue;
      },
      close: vi.fn(),
    };
  });
  return {
    startup,
    factory: {
      query(parameters) {
        optionsValue = parameters.options;
        queryValue = new FakeQuery(parameters.prompt);
        return queryValue;
      },
      startup,
    },
    query: () => {
      if (!queryValue) throw new Error('query not started');
      return queryValue;
    },
    options: () => {
      if (!optionsValue) throw new Error('options not captured');
      return optionsValue;
    },
  };
}

const selection: CapabilitySelection = {
  transport: 'claude-agent-sdk',
  enabled: [],
  unavailableOptional: [],
  possibleEffects: ['read', 'filesystem_write'],
  effectsComplete: true,
};

function createTransport(harness: FakeHarness, overrides: Record<string, unknown> = {}) {
  const cwd = resolve('.');
  const sessionId = randomUUID();
  const sdkOptionsOverride = (overrides.sdkOptions ?? {}) as Partial<Options>;
  const { sdkOptions: _sdkOptions, ...transportOverrides } = overrides;
  return new ClaudeAgentSdkTransport({
    sessionId,
    cwd,
    prompt: 'hello',
    executionId: randomUUID(),
    turnId: randomUUID(),
    selection,
    executable: resolve('claude-sdk.exe'),
    daemonConfigRoot: testConfigRoot,
    providerStatus: {
      id: 'claude',
      name: 'Claude',
      installed: true,
      authenticated: 'authenticated',
      authSource: 'api_key',
      capabilities: {},
      version: '2.1.251',
    },
    sdkOptions: {
      cwd,
      env: { CLAUDE_CONFIG_DIR: resolveClaudeSdkConfigDir(testConfigRoot, sessionId) },
      model: 'claude-test',
      tools: ['Read', 'AskUserQuestion'],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      skills: [],
      plugins: [],
      ...sdkOptionsOverride,
    },
    managedProcessSpawner: () => ({
      process: {} as never,
      forceClose: vi.fn(async () => undefined),
      reaped: Promise.resolve(),
    }),
    factory: harness.factory,
    ...transportOverrides,
  });
}

function initMessage(sessionId = randomUUID(), tools: string[] = ['Read', 'AskUserQuestion']) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: resolve('.'),
    model: 'claude-test',
    claude_code_version: '2.1.251',
    permissionMode: 'default',
    apiKeySource: 'ANTHROPIC_API_KEY',
    tools,
    mcp_servers: [],
    skills: [],
    plugins: [],
  };
}

async function nextType(
  transport: ClaudeAgentSdkTransport,
  type: AgentEventV2['type'],
): Promise<AgentEventV2> {
  while (true) {
    const next = await transport.events.next();
    if (next.done) throw new Error(`stream ended before ${type}`);
    const event = next.value as AgentEventV2;
    if (event.type === type) return event;
  }
}

describe('ClaudeAgentSdkTransport', () => {
  it('warms inertly, accepts at query, and normalizes streaming text and result usage', async () => {
    const harness = fakeHarness();
    const beforeThread = vi.fn(async () => undefined);
    const beforeDelivery = vi.fn(async () => undefined);
    const transport = createTransport(harness, {
      beforeProviderThreadStart: beforeThread,
      beforeWorkDelivery: beforeDelivery,
    });

    await vi.waitFor(() => expect(harness.startup).toHaveBeenCalledOnce());
    expect(await transport.accepted).toBe('accepted');
    expect(transport.workDeliveryState).toBe('delivered');
    expect(beforeThread).toHaveBeenCalledBefore(beforeDelivery);
    expect(harness.options().pathToClaudeCodeExecutable).toBe(resolve('claude-sdk.exe'));
    expect(harness.options().includePartialMessages).toBe(true);
    await vi.waitFor(() => expect(harness.query().inputs).toHaveLength(1));

    const providerSessionId = randomUUID();
    harness.query().push(initMessage(providerSessionId));
    await transport.started;
    expect(transport.providerSessionId).toBe(providerSessionId);
    const session = (await nextType(transport, 'session.started')) as Extract<
      AgentEventV2,
      { type: 'session.started' }
    >;
    expect(session.selection).toEqual(selection);
    const turn = (await nextType(transport, 'turn.started')) as Extract<
      AgentEventV2,
      { type: 'turn.started' }
    >;
    const messageId = randomUUID();
    harness.query().push({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { id: messageId } },
    });
    harness.query().push({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
    });
    harness.query().push({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } },
    });
    harness.query().push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: messageId, content: [{ type: 'text', text: 'hi' }] },
    });
    harness.query().push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 1,
      },
      modelUsage: {
        'claude-test': {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 1,
        },
      },
      total_cost_usd: 0.01,
    });

    const delta = (await nextType(transport, 'content.delta')) as Extract<
      AgentEventV2,
      { type: 'content.delta' }
    >;
    expect(delta).toMatchObject({ turnId: turn.turnId, delta: 'hi' });
    const tokens = (await nextType(transport, 'usage.tokens')) as Extract<
      AgentEventV2,
      { type: 'usage.tokens' }
    >;
    expect(tokens).toMatchObject({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 });
    const cost = (await nextType(transport, 'usage.cost')) as Extract<
      AgentEventV2,
      { type: 'usage.cost' }
    >;
    expect(cost).toMatchObject({ cost: 0.01, currency: 'USD', estimated: true });
    await nextType(transport, 'turn.completed');

    const followUpTurnId = randomUUID();
    await transport.send({
      type: 'input.follow_up',
      commandId: randomUUID(),
      sessionId: randomUUID(),
      turnId: followUpTurnId,
      content: [{ type: 'text', id: randomUUID(), text: 'next' }],
    });
    harness.query().push(initMessage(providerSessionId));
    harness.query().push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {
        'claude-test': {
          inputTokens: 15,
          outputTokens: 4,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 1,
        },
      },
      total_cost_usd: 0.02,
    });
    const secondTokens = (await nextType(transport, 'usage.tokens')) as Extract<
      AgentEventV2,
      { type: 'usage.tokens' }
    >;
    expect(secondTokens).toMatchObject({
      turnId: followUpTurnId,
      inputTokens: 5,
      outputTokens: 2,
      cachedInputTokens: 2,
    });
    const secondCost = (await nextType(transport, 'usage.cost')) as Extract<
      AgentEventV2,
      { type: 'usage.cost' }
    >;
    expect(secondCost.cost).toBeCloseTo(0.01);
    await transport.close();
    expect(transport.reaped).toBe(true);
  });

  it.each([
    ['permission mode', { permissionMode: 'bypassPermissions' }],
    ['agent', { agents: ['unapproved-agent'] }],
    ['Claude executable version', { claude_code_version: '2.1.252' }],
  ] as const)('rejects %s init drift before publishing session.started', async (_name, drift) => {
    const harness = fakeHarness();
    const transport = createTransport(harness);
    await vi.waitFor(() => expect(harness.startup).toHaveBeenCalledOnce());
    await transport.accepted;

    const started = transport.started.catch((error: unknown) => error);
    const firstEvent = transport.events.next().catch((error: unknown) => error);
    harness.query().push({ ...initMessage(), ...drift });

    await expect(started).resolves.toMatchObject({ reasonCode: 'claude_sdk_scope_changed' });
    await expect(firstEvent).resolves.toMatchObject({ code: 'claude_sdk_scope_changed' });
    await transport.forceClose();
  });

  it('settles approval and AskUserQuestion callbacks exactly once', async () => {
    const harness = fakeHarness();
    const transport = createTransport(harness);
    await vi.waitFor(() => expect(harness.startup).toHaveBeenCalledOnce());
    expect(await transport.accepted).toBe('accepted');
    harness.query().push(initMessage());
    await transport.started;
    const sdkOptions = harness.options();
    const approvalController = new AbortController();
    let approvalSettles = 0;
    const approval = sdkOptions
      .canUseTool?.(
        'Read',
        { file_path: resolve('package.json') },
        {
          signal: approvalController.signal,
          toolUseID: 'native-read-1',
          requestId: 'native-request-1',
          title: 'Read package',
        },
      )
      .then((result) => {
        approvalSettles += 1;
        return result;
      });
    const approvalEvent = (await nextType(transport, 'approval.requested')) as Extract<
      AgentEventV2,
      { type: 'approval.requested' }
    >;
    await transport.send({
      type: 'approval.respond',
      commandId: randomUUID(),
      sessionId: randomUUID(),
      turnId: approvalEvent.turnId,
      requestId: approvalEvent.requestId,
      decision: 'allow_once',
    });
    expect(await approval).toEqual({ behavior: 'allow' });
    approvalController.abort();
    await Promise.resolve();
    expect(approvalSettles).toBe(1);

    const questionController = new AbortController();
    const question = sdkOptions.canUseTool?.(
      'AskUserQuestion',
      {
        questions: [
          {
            header: 'Choice',
            question: 'Pick one?',
            options: [
              { label: 'A', description: 'First' },
              { label: 'B', description: 'Second' },
            ],
            multiSelect: false,
          },
        ],
      },
      {
        signal: questionController.signal,
        toolUseID: 'native-question-1',
        requestId: 'native-request-2',
      },
    );
    const questionEvent = (await nextType(transport, 'question.requested')) as Extract<
      AgentEventV2,
      { type: 'question.requested' }
    >;
    const first = questionEvent.questions[0]!;
    await transport.send({
      type: 'question.respond',
      commandId: randomUUID(),
      sessionId: randomUUID(),
      turnId: questionEvent.turnId,
      requestId: questionEvent.requestId,
      answers: [{ questionId: first.id, value: first.options![1]!.id }],
    });
    expect(await question).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Pick one?': 'B' } },
    });
    await transport.close();
  });

  it('rejects workspace escapes before publishing a permission request', async () => {
    const harness = fakeHarness();
    const transport = createTransport(harness);
    await vi.waitFor(() => expect(harness.startup).toHaveBeenCalledOnce());
    expect(await transport.accepted).toBe('accepted');
    harness.query().push(initMessage());
    await transport.started;
    const result = await harness.options().canUseTool?.(
      'Read',
      { file_path: resolve('..', 'outside.txt') },
      {
        signal: new AbortController().signal,
        toolUseID: 'native-read-escape',
        requestId: 'native-request-escape',
      },
    );
    expect(result).toMatchObject({ behavior: 'deny' } satisfies Partial<PermissionResult>);
    await transport.close();
  });

  it('enforces the configured exact tool allowlist and preserves distinct canonical targets', async () => {
    const harness = fakeHarness();
    const transport = createTransport(harness);
    await vi.waitFor(() => expect(harness.startup).toHaveBeenCalledOnce());
    await transport.accepted;
    harness.query().push(initMessage());
    await transport.started;
    await nextType(transport, 'turn.started');
    const sdkOptions = harness.options();
    const callback = (toolUseID: string) => ({
      signal: new AbortController().signal,
      toolUseID,
      requestId: `request-${toolUseID}`,
    });

    await expect(
      sdkOptions.canUseTool?.('Edit', { file_path: resolve('README.md') }, callback('edit')),
    ).resolves.toMatchObject({ behavior: 'deny' });
    await expect(
      sdkOptions.canUseTool?.('Bash', { command: 'echo unsafe' }, callback('bash')),
    ).resolves.toMatchObject({ behavior: 'deny' });

    const firstPermission = sdkOptions.canUseTool?.(
      'Read',
      { file_path: resolve('package.json') },
      callback('read-package'),
    );
    const secondPermission = sdkOptions.canUseTool?.(
      'Read',
      { file_path: resolve('packages/agent-runtime/src/index.ts') },
      callback('read-index'),
    );
    const first = (await nextType(transport, 'approval.requested')) as Extract<
      AgentEventV2,
      { type: 'approval.requested' }
    >;
    const second = (await nextType(transport, 'approval.requested')) as Extract<
      AgentEventV2,
      { type: 'approval.requested' }
    >;
    expect(first.target).not.toBe(second.target);
    expect(new Set([first.target, second.target])).toEqual(
      new Set([
        realpathSync.native('package.json'),
        realpathSync.native('packages/agent-runtime/src/index.ts'),
      ]),
    );
    for (const event of [first, second]) {
      await transport.send({
        type: 'approval.respond',
        commandId: randomUUID(),
        sessionId: randomUUID(),
        turnId: event.turnId,
        requestId: event.requestId,
        decision: 'allow_session',
      });
    }
    await expect(firstPermission).resolves.toEqual({ behavior: 'allow' });
    await expect(secondPermission).resolves.toEqual({ behavior: 'allow' });
    await transport.close();
  });

  it('fails safely when Claude aborts a daemon-owned published interaction', async () => {
    const harness = fakeHarness();
    const transport = createTransport(harness, { interactionOwner: 'daemon' });
    await vi.waitFor(() => expect(harness.startup).toHaveBeenCalledOnce());
    await transport.accepted;
    harness.query().push(initMessage());
    await transport.started;
    await nextType(transport, 'turn.started');
    const controller = new AbortController();
    let settleCount = 0;
    const permission = harness
      .options()
      .canUseTool?.(
        'Read',
        { file_path: resolve('package.json') },
        {
          signal: controller.signal,
          toolUseID: 'daemon-abort-read',
          requestId: 'daemon-abort-native',
        },
      )
      .then((result) => {
        settleCount += 1;
        return result;
      });
    const request = (await nextType(transport, 'approval.requested')) as Extract<
      AgentEventV2,
      { type: 'approval.requested' }
    >;
    const failure = transport.events.next();
    controller.abort();
    await expect(permission).resolves.toMatchObject({ behavior: 'deny' });
    expect(settleCount).toBe(1);
    await expect(failure).rejects.toMatchObject({ code: 'claude_sdk_interaction_cancelled' });
    await expect(
      transport.send({
        type: 'approval.respond',
        commandId: randomUUID(),
        sessionId: randomUUID(),
        turnId: request.turnId,
        requestId: request.requestId,
        decision: 'allow_once',
      }),
    ).rejects.toThrow('stale');
    await transport.close();
  });

  it('does not treat iterator completion or a rejected managed proof as reaped', async () => {
    const harness = fakeHarness();
    const forceClose = vi.fn(async () => undefined);
    const transport = createTransport(harness, {
      managedProcessSpawner: () => ({
        process: {} as never,
        forceClose,
        reaped: Promise.reject(new Error('not reaped')),
      }),
    });
    await vi.waitFor(() => expect(harness.startup).toHaveBeenCalledOnce());
    await transport.accepted;
    harness.query().push(initMessage());
    await transport.started;
    harness.query().end();
    await expect(transport.close()).rejects.toMatchObject({ code: 'claude_sdk_close_timeout' });
    expect(transport.reaped).toBe(false);
    await expect(transport.forceClose()).rejects.toMatchObject({
      code: 'claude_sdk_force_close_failed',
    });
    expect(forceClose).toHaveBeenCalledOnce();
    expect(transport.reaped).toBe(false);
  });

  it('keeps resume/fork native and fails closed after the query boundary', async () => {
    const harness = fakeHarness();
    const source = randomUUID();
    const transport = createTransport(harness, {
      continuation: { kind: 'fork', providerSessionId: source },
    });
    await vi.waitFor(() => expect(harness.startup).toHaveBeenCalledOnce());
    expect(harness.options()).toMatchObject({ resume: source, forkSession: true });
    expect(await transport.accepted).toBe('accepted');
    harness.query().end();
    await expect(transport.started).rejects.toMatchObject({ deliveryState: 'ambiguous' });
    await transport.forceClose();
  });

  it('does not accept work until the SDK pulls the initial streaming input', async () => {
    let queryValue: FakeQuery | undefined;
    const factory: ClaudeAgentSdkFactory = {
      query: () => {
        throw new Error('warm query expected');
      },
      startup: async (parameters) => {
        launchFakeManagedProcess(parameters?.options);
        return {
          query: () => {
            queryValue = new FakeQuery(
              (async function* neverRead(): AsyncGenerator<SDKUserMessage, void, void> {
                for (const value of [] as SDKUserMessage[]) yield value;
              })(),
            );
            return queryValue;
          },
          close: vi.fn(),
        };
      },
    };
    const harness = fakeHarness();
    harness.factory = factory;
    const transport = createTransport(harness);
    await vi.waitFor(() => expect(queryValue).toBeDefined());
    queryValue!.end();
    await expect(transport.accepted).resolves.toBe('not_accepted');
    expect(transport.workDeliveryState).toBe('not_delivered');
    await expect(transport.started).rejects.toMatchObject({ deliveryState: 'not_delivered' });
    await transport.forceClose();
  });

  it('marks the initial prompt delivered when the SDK pulls once and disconnects immediately', async () => {
    let queryValue: FakeQuery | undefined;
    const factory: ClaudeAgentSdkFactory = {
      query: () => {
        throw new Error('warm query expected');
      },
      startup: async (parameters) => {
        launchFakeManagedProcess(parameters?.options);
        return {
          query: (prompt) => {
            if (typeof prompt === 'string') throw new Error('streaming prompt expected');
            queryValue = new FakeQuery(
              (async function* emptyInput(): AsyncGenerator<SDKUserMessage, void, void> {
                for (const value of [] as SDKUserMessage[]) yield value;
              })(),
            );
            void prompt[Symbol.asyncIterator]()
              .next()
              .then(() => queryValue!.end());
            return queryValue;
          },
          close: vi.fn(),
        };
      },
    };
    const harness = fakeHarness();
    harness.factory = factory;
    const transport = createTransport(harness);
    await expect(transport.accepted).resolves.toBe('accepted');
    expect(transport.workDeliveryState).toBe('delivered');
    await expect(transport.started).rejects.toMatchObject({ deliveryState: 'ambiguous' });
    await transport.forceClose();
    expect(transport.reaped).toBe(true);
  });

  it('treats an unused required spawn hook as a zero-process launch', async () => {
    let queryValue: FakeQuery | undefined;
    const factory: ClaudeAgentSdkFactory = {
      query: () => {
        throw new Error('warm query expected');
      },
      startup: async () => ({
        query: (prompt) => {
          queryValue = new FakeQuery(prompt);
          return queryValue;
        },
        close: vi.fn(),
      }),
    };
    const harness = fakeHarness();
    harness.factory = factory;
    const transport = createTransport(harness);
    await transport.accepted;
    await vi.waitFor(() => expect(queryValue).toBeDefined());
    queryValue!.push(initMessage());
    await transport.started;
    await transport.close();
    expect(transport.reaped).toBe(true);
  });
});
