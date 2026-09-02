import readline from 'node:readline';

const scenario = process.env.FAKE_CODEX_APP_SERVER_SCENARIO ?? 'normal';
let threadId = 'native-thread-1';
let turnCounter = 0;
let initialized = false;
let initializeCount = 0;
const awaitingInteractions = new Map();

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message) {
  process.stderr.write(`fixture assertion failed (${Buffer.byteLength(message)} bytes)\n`);
  process.exitCode = 3;
  process.stdin.destroy();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function turn(id, status) {
  return {
    id,
    items: [],
    itemsView: { type: 'full' },
    status,
    error: null,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 1,
  };
}

function notify(method, params) {
  send({ method, params });
}

function interactionKey(id) {
  return `${typeof id}:${id}`;
}

function awaitInteraction(id, interaction) {
  awaitingInteractions.set(interactionKey(id), interaction);
}

function emitCompletedTurn(nativeTurnId, text = 'hello') {
  notify('turn/started', { threadId, turn: turn(nativeTurnId, 'inProgress') });
  notify('item/agentMessage/delta', {
    threadId,
    turnId: nativeTurnId,
    itemId: `message-${nativeTurnId}`,
    delta: text,
  });
  notify('item/completed', {
    threadId,
    turnId: nativeTurnId,
    item: {
      type: 'agentMessage',
      id: `message-${nativeTurnId}`,
      text,
      phase: null,
      memoryCitation: null,
    },
    completedAtMs: 2,
  });
  notify('turn/plan/updated', {
    threadId,
    turnId: nativeTurnId,
    explanation: 'Plan',
    plan: [{ step: 'Finish fixture proof', status: 'completed' }],
  });
  for (const item of [
    {
      type: 'commandExecution',
      id: `command-${nativeTurnId}`,
      command: 'redacted by adapter',
      cwd: '.',
      status: 'completed',
      exitCode: 0,
    },
    {
      type: 'fileChange',
      id: `file-${nativeTurnId}`,
      changes: [{ path: 'secret-path', kind: 'update', diff: 'secret-diff' }],
      status: 'completed',
    },
    {
      type: 'mcpToolCall',
      id: `mcp-${nativeTurnId}`,
      server: 'fixture',
      tool: 'lookup',
      status: 'completed',
      arguments: { token: 'must-not-surface' },
      readOnlyHint: true,
    },
  ]) {
    notify('item/started', { threadId, turnId: nativeTurnId, item, startedAtMs: 1 });
    notify('item/completed', { threadId, turnId: nativeTurnId, item, completedAtMs: 2 });
  }
  notify('item/reasoning/textDelta', {
    threadId,
    turnId: nativeTurnId,
    itemId: `reasoning-${nativeTurnId}`,
    delta: 'private chain of thought must not persist',
    contentIndex: 0,
  });
  notify('item/completed', {
    threadId,
    turnId: nativeTurnId,
    item: { type: 'reasoning', id: `reasoning-${nativeTurnId}`, summary: [], content: [] },
    completedAtMs: 2,
  });
  notify('thread/tokenUsage/updated', {
    threadId,
    turnId: nativeTurnId,
    tokenUsage: {
      total: { totalTokens: 8, inputTokens: 5, cachedInputTokens: 1, outputTokens: 3 },
      last: { totalTokens: 8, inputTokens: 5, cachedInputTokens: 1, outputTokens: 3 },
      modelContextWindow: 100,
    },
  });
  if (scenario === 'unknown-notification') {
    notify('future/stableNotification', { rawSecret: 'must-not-surface' });
  }
  notify('turn/completed', { threadId, turn: turn(nativeTurnId, 'completed') });
}

function beginTurn(message) {
  const nativeTurnId = `native-turn-${++turnCounter}`;
  send({ id: message.id, result: { turn: turn(nativeTurnId, 'inProgress') } });
  if (
    [
      'approval',
      'approval-resolved',
      'network-approval',
      'file-approval',
      'permissions-approval',
      'hidden-command',
      'unc-approval',
      'missing-item',
      'duplicate-item',
    ].includes(scenario) &&
    turnCounter === 1
  ) {
    notify('turn/started', { threadId, turn: turn(nativeTurnId, 'inProgress') });
    const request =
      scenario === 'file-approval'
        ? {
            method: 'item/fileChange/requestApproval',
            id: '1',
            params: {
              threadId,
              turnId: nativeTurnId,
              itemId: 'file-approval',
              startedAtMs: 1,
              grantRoot: process.cwd(),
            },
          }
        : scenario === 'permissions-approval'
          ? {
              method: 'item/permissions/requestApproval',
              id: '1',
              params: {
                threadId,
                turnId: nativeTurnId,
                itemId: 'permissions-approval',
                startedAtMs: 1,
                cwd: process.cwd(),
                reason: 'network',
                permissions: { network: { enabled: true }, fileSystem: null },
              },
            }
          : {
              method: 'item/commandExecution/requestApproval',
              id: '1',
              params: {
                threadId,
                turnId: nativeTurnId,
                ...(scenario === 'missing-item' ? {} : { itemId: 'command-approval' }),
                startedAtMs: 1,
                command:
                  scenario === 'hidden-command' ? `echo safe ${'x'.repeat(5_000)}` : 'echo safe',
                cwd: scenario === 'unc-approval' ? '\\\\127.0.0.1\\agent-dock-test' : '.',
                ...(scenario === 'network-approval'
                  ? { networkApprovalContext: { host: 'example.test:443', protocol: 'https' } }
                  : {}),
              },
            };
    awaitInteraction('1', {
      kind: scenario === 'permissions-approval' ? 'permissions' : 'approval',
      id: '1',
      nativeTurnId,
    });
    if (scenario === 'duplicate-item') request.params.approvalId = 'approval-first';
    send(request);
    if (scenario === 'duplicate-item') {
      send({
        method: 'item/commandExecution/requestApproval',
        id: 'second',
        params: {
          threadId,
          turnId: nativeTurnId,
          itemId: 'command-approval',
          approvalId: 'approval-second',
          startedAtMs: 1,
          command: 'echo safe',
          cwd: '.',
        },
      });
      awaitInteraction('second', { kind: 'approval', id: 'second', nativeTurnId });
    }
    if (scenario === 'approval-resolved') {
      notify('serverRequest/resolved', { threadId, requestId: '1' });
      notify('turn/completed', { threadId, turn: turn(nativeTurnId, 'completed') });
      awaitingInteractions.clear();
    }
    return;
  }
  if (scenario === 'mcp-form' && turnCounter === 1) {
    notify('turn/started', { threadId, turn: turn(nativeTurnId, 'inProgress') });
    awaitInteraction('mcp-1', { kind: 'mcp', id: 'mcp-1', nativeTurnId });
    send({
      method: 'mcpServer/elicitation/request',
      id: 'mcp-1',
      params: {
        threadId,
        turnId: nativeTurnId,
        serverName: 'fixture',
        mode: 'form',
        _meta: null,
        message: 'Choose value',
        requestedSchema: {
          type: 'object',
          properties: {
            choice: { type: 'boolean', title: 'Choice', enum: [false, true] },
          },
        },
      },
    });
    return;
  }
  if (scenario === 'question' && turnCounter === 1) {
    notify('turn/started', { threadId, turn: turn(nativeTurnId, 'inProgress') });
    awaitInteraction(91, { kind: 'question', id: 91, nativeTurnId });
    send({
      method: 'item/tool/requestUserInput',
      id: 91,
      params: {
        threadId,
        turnId: nativeTurnId,
        itemId: 'question-1',
        questions: [
          {
            id: 'native-question',
            header: 'Choose',
            question: 'Pick one',
            isOther: false,
            isSecret: false,
            options: [{ label: 'A', description: 'First' }],
          },
        ],
        isBlocking: true,
        autoResolutionMs: null,
      },
    });
    return;
  }
  if (scenario === 'secret-question' && turnCounter === 1) {
    notify('turn/started', { threadId, turn: turn(nativeTurnId, 'inProgress') });
    send({
      method: 'item/tool/requestUserInput',
      id: 92,
      params: {
        threadId,
        turnId: nativeTurnId,
        itemId: 'secret-question',
        questions: [
          {
            id: 'native-secret',
            header: 'Secret',
            question: 'Token?',
            isOther: true,
            isSecret: true,
            options: null,
          },
        ],
        isBlocking: true,
        autoResolutionMs: null,
      },
    });
    return;
  }
  if (scenario === 'unknown-request' && turnCounter === 1) {
    notify('turn/started', { threadId, turn: turn(nativeTurnId, 'inProgress') });
    send({
      method: 'account/chatgptAuthTokens/refresh',
      id: 93,
      params: { refreshToken: 'must-not-surface' },
    });
    return;
  }
  if (scenario === 'delta-disagreement' && turnCounter === 1) {
    notify('turn/started', { threadId, turn: turn(nativeTurnId, 'inProgress') });
    notify('item/agentMessage/delta', {
      threadId,
      turnId: nativeTurnId,
      itemId: 'message-disagree',
      delta: 'one',
    });
    notify('item/completed', {
      threadId,
      turnId: nativeTurnId,
      item: { type: 'agentMessage', id: 'message-disagree', text: 'two' },
      completedAtMs: 2,
    });
    return;
  }
  if (scenario === 'large-completed' && turnCounter === 1) {
    notify('turn/started', { threadId, turn: turn(nativeTurnId, 'inProgress') });
    notify('item/completed', {
      threadId,
      turnId: nativeTurnId,
      item: { type: 'agentMessage', id: 'large-message', text: 'x'.repeat(300 * 1024) },
      completedAtMs: 2,
    });
    notify('turn/completed', { threadId, turn: turn(nativeTurnId, 'completed') });
    return;
  }
  if (
    (scenario === 'active' || scenario === 'ignore-interrupt' || scenario === 'steer-mismatch') &&
    turnCounter === 1
  ) {
    notify('turn/started', { threadId, turn: turn(nativeTurnId, 'inProgress') });
    return;
  }
  if ((scenario === 'multimodal' || scenario === 'multimodal-invalid-output') && turnCounter === 1) {
    assert(Array.isArray(message.params.input), 'multimodal turn/start input was not an array');
    const image = message.params.input.find((entry) => entry.type === 'localImage');
    assert(!!image, 'multimodal turn/start missing a localImage input entry');
    assert(image.path === '/fake/staged/image.png', 'localImage path did not match the staged attachment');
    assert(
      typeof message.params.outputSchema === 'object' && message.params.outputSchema !== null,
      'multimodal turn/start missing outputSchema',
    );
    assert(
      message.params.outputSchema.required?.[0] === 'answer',
      'multimodal turn/start outputSchema did not match the negotiated schema',
    );
    notify('turn/started', { threadId, turn: turn(nativeTurnId, 'inProgress') });
    const text =
      scenario === 'multimodal-invalid-output' ? 'not valid json' : JSON.stringify({ answer: 42 });
    notify('item/completed', {
      threadId,
      turnId: nativeTurnId,
      item: { type: 'agentMessage', id: `message-${nativeTurnId}`, text },
      completedAtMs: 2,
    });
    notify('turn/completed', { threadId, turn: turn(nativeTurnId, 'completed') });
    return;
  }
  emitCompletedTurn(nativeTurnId, turnCounter === 1 ? 'hello' : 'follow-up');
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    assert(!Object.hasOwn(message, 'jsonrpc'), 'jsonrpc header is forbidden');
    if (!Object.hasOwn(message, 'method')) {
      const awaitingInteraction = awaitingInteractions.get(interactionKey(message.id));
      if (!awaitingInteraction) throw new Error('unknown interaction response');
      assert(
        typeof message.id === typeof awaitingInteraction.id &&
          message.id === awaitingInteraction.id,
        'interaction response id/type mismatch',
      );
      if (awaitingInteraction.kind === 'approval') {
        assert(message.result?.decision === 'accept', 'approval was not one-shot accept');
      } else if (awaitingInteraction.kind === 'permissions') {
        assert(message.result?.scope === 'turn', 'permission escaped turn scope');
        assert(message.result?.permissions?.network?.enabled === true, 'permission mismatch');
      } else if (awaitingInteraction.kind === 'mcp') {
        assert(message.result?.action === 'accept', 'MCP elicitation was not accepted');
        assert(message.result?.content?.choice === false, 'MCP content mismatch');
      } else {
        assert(
          message.result?.answers?.['native-question']?.answers?.[0] === 'A',
          'answer mismatch',
        );
      }
      const nativeTurnId = awaitingInteraction.nativeTurnId;
      awaitingInteractions.delete(interactionKey(message.id));
      if (awaitingInteractions.size === 0) {
        notify('turn/completed', { threadId, turn: turn(nativeTurnId, 'completed') });
      }
      return;
    }
    if (message.method === 'initialize') {
      initializeCount += 1;
      assert(initializeCount === 1, 'initialize repeated');
      assert(message.params?.capabilities === null, 'experimental capabilities were sent');
      assert(!Object.hasOwn(message.params ?? {}, 'experimentalApi'), 'experimentalApi was sent');
      if (scenario === 'malformed-initialize') process.stdout.write('{bad-init\n');
      else send({ id: message.id, result: { serverInfo: { name: 'fake', version: '0.147.0' } } });
      return;
    }
    if (message.method === 'initialized') {
      assert(initializeCount === 1 && !Object.hasOwn(message, 'id'), 'invalid initialized');
      initialized = true;
      return;
    }
    assert(initialized, 'request before initialized');
    if (message.method === 'account/read') {
      assert(message.params?.refreshToken === false, 'account/read must not refresh credentials');
      send({
        id: message.id,
        result: {
          account:
            scenario === 'account-missing'
              ? null
              : scenario === 'account-api-key'
                ? { type: 'apiKey' }
                : {
                    type: 'chatgpt',
                    email: process.env.FAKE_CODEX_ACCOUNT_EMAIL ?? 'fixture@example.test',
                    planType: 'plus',
                  },
          requiresOpenaiAuth: true,
        },
      });
      return;
    }
    if (message.method === 'model/list') {
      send({
        id: message.id,
        result: {
          data: [{ id: 'fake-model', displayName: 'Fake model', isDefault: true }],
          nextCursor: null,
        },
      });
      return;
    }
    if (message.method === 'modelProvider/capabilities/read') {
      assert(
        message.params && Object.keys(message.params).length === 0,
        'model provider capabilities params changed',
      );
      send({
        id: message.id,
        result: { imageGeneration: false, namespaceTools: true, webSearch: true },
      });
      return;
    }
    if (['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
      assert(message.params?.model === 'fake-model', 'thread model was not pinned');
      assert(message.params?.approvalPolicy === 'on-request', 'approval policy was not pinned');
      assert(message.params?.approvalsReviewer === 'user', 'approval reviewer was not pinned');
      assert(message.params?.sandbox === 'workspace-write', 'thread sandbox was not pinned');
      if (process.env.FAKE_CODEX_EXPECT_THREAD_METHOD) {
        assert(
          message.method === process.env.FAKE_CODEX_EXPECT_THREAD_METHOD,
          'unexpected thread lifecycle method',
        );
      }
      if (scenario === 'malformed') {
        process.stdout.write('{not-json\n');
        return;
      }
      if (scenario === 'oversized') {
        process.stdout.write(`${'x'.repeat(1024 * 1024 + 1)}\n`);
        return;
      }
      if (scenario === 'invalid-utf8') {
        process.stdout.write(Buffer.from([0xff, 0x0a]));
        return;
      }
      if (scenario === 'deep-json') {
        let nested = {};
        for (let depth = 0; depth < 20; depth += 1) nested = { nested };
        send({ id: message.id, result: nested });
        return;
      }
      if (scenario === 'unknown-response') {
        send({ id: 999_999, result: {} });
        return;
      }
      if (scenario === 'post-thread-invalid-response') {
        send({ id: message.id, result: { thread: {} } });
        return;
      }
      const responseThreadId =
        scenario === 'resume-id-mismatch'
          ? 'different-native-thread'
          : scenario === 'fork-id-mismatch'
            ? message.params.threadId
            : message.method === 'thread/resume'
              ? message.params.threadId
              : threadId;
      const result = {
        approvalPolicy: message.params.approvalPolicy,
        approvalsReviewer: message.params.approvalsReviewer,
        cwd: message.params.cwd,
        model: message.params.model,
        modelProvider: 'openai',
        sandbox: {
          type: 'workspaceWrite',
          networkAccess: false,
          writableRoots: [],
          excludeSlashTmp: false,
          excludeTmpdirEnvVar: false,
        },
        thread: { id: responseThreadId, cwd: message.params.cwd },
      };
      if (scenario === 'thread-scope-drift') {
        result.sandbox = { type: 'dangerFullAccess' };
      }
      if (scenario === 'thread-unc-drift') {
        result.cwd = '\\\\127.0.0.1\\agent-dock-test';
        result.thread.cwd = result.cwd;
      }
      threadId = responseThreadId;
      const response = { id: message.id, result };
      if (scenario === 'duplicate-response') {
        process.stdout.write(`${JSON.stringify(response)}\n${JSON.stringify(response)}\n`);
      } else {
        send(response);
      }
      return;
    }
    if (message.method === 'turn/start') {
      beginTurn(message);
      return;
    }
    if (message.method === 'turn/steer') {
      send({
        id: message.id,
        result: {
          turnId:
            scenario === 'steer-mismatch' ? 'different-native-turn' : message.params.expectedTurnId,
        },
      });
      return;
    }
    if (message.method === 'turn/interrupt') {
      if (scenario === 'ignore-interrupt') return;
      send({ id: message.id, result: {} });
      notify('turn/completed', {
        threadId,
        turn: turn(message.params.turnId, 'interrupted'),
      });
      return;
    }
    throw new Error(`unexpected method ${message.method}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'unknown');
  }
});
