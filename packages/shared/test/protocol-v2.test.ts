import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_V2_TYPES,
  agentCommandV2Schema,
  agentEventV2EnvelopeSchema,
  agentSessionV2Schema,
  cancelSessionV2ResponseSchema,
  contentBlockV2Schema,
  createSessionV2RequestSchema,
  questionV2Schema,
} from '../src/protocol-v2.js';

const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const turnId = '123e4567-e89b-42d3-a456-426614174001';
const commandId = '123e4567-e89b-42d3-a456-426614174002';
const requestId = '123e4567-e89b-42d3-a456-426614174003';
const contentBlockId = '123e4567-e89b-42d3-a456-426614174004';
const toolCallId = '123e4567-e89b-42d3-a456-426614174005';
const executionId = '123e4567-e89b-42d3-a456-426614174006';
const questionId = '123e4567-e89b-42d3-a456-426614174007';
const optionId = '123e4567-e89b-42d3-a456-426614174008';
const timestamp = '2026-08-30T12:00:00.000Z';
const selection = {
  transport: 'cli',
  enabled: [{ id: 'session.cancel', constraints: { kind: 'acknowledgement', timeoutMs: 30_000 } }],
  unavailableOptional: [],
  possibleEffects: [],
  effectsComplete: true,
};
const meta = { sessionId, executionId, sequence: 0, timestamp };
const turnMeta = { ...meta, turnId };
const textBlock = { type: 'text', id: contentBlockId, text: 'hello' } as const;

describe('protocol v2 content and interaction schemas', () => {
  it('round-trips every normalized content-block kind with stable IDs', () => {
    const blocks = [
      textBlock,
      {
        type: 'image',
        id: contentBlockId,
        attachmentId: requestId,
        name: 'image.png',
        mimeType: 'image/png',
        byteLength: 12,
        alt: 'preview',
      },
      {
        type: 'file',
        id: contentBlockId,
        attachmentId: requestId,
        name: 'notes.txt',
        mimeType: 'text/plain',
        byteLength: 12,
      },
      { type: 'structured_data', id: contentBlockId, data: { ok: true } },
      {
        type: 'tool_activity',
        id: contentBlockId,
        toolCallId,
        toolName: 'read_file',
        status: 'completed',
        possibleEffects: ['read'],
        effectsComplete: true,
        resultSummary: 'read one file',
      },
      {
        type: 'plan',
        id: contentBlockId,
        title: 'Plan',
        steps: [{ id: optionId, text: 'Do it', status: 'pending' }],
      },
      {
        type: 'provider_extension',
        id: contentBlockId,
        extensionName: 'future.item',
        representation: 'bounded_data',
        data: { value: 1 },
        safeSummary: 'future item',
        safeToPersist: false,
      },
      {
        type: 'provider_extension',
        id: contentBlockId,
        extensionName: 'future.item',
        representation: 'safe_summary',
        safeSummary: 'redacted item',
        reason: 'display_disallowed',
      },
    ];
    for (const block of blocks) {
      const result = contentBlockV2Schema.safeParse(block);
      expect(result.success, `${block.type}: ${result.success ? '' : result.error.message}`).toBe(
        true,
      );
    }
  });

  it('structurally forbids raw extension data in the safe-summary representation', () => {
    expect(
      contentBlockV2Schema.safeParse({
        type: 'provider_extension',
        id: contentBlockId,
        extensionName: 'future.item',
        representation: 'safe_summary',
        safeSummary: 'redacted',
        reason: 'persistence_disallowed',
        data: { secret: true },
      }).success,
    ).toBe(false);
  });

  it('rejects provider extension views larger than the 64 KiB opaque-view limit', () => {
    expect(
      contentBlockV2Schema.safeParse({
        type: 'provider_extension',
        id: contentBlockId,
        extensionName: 'future.item',
        representation: 'bounded_data',
        data: Array.from({ length: 300 }, () => 'x'.repeat(250)),
        safeSummary: 'oversized extension',
        safeToPersist: false,
      }).success,
    ).toBe(false);
  });

  it('applies question KiB limits to UTF-8 bytes rather than JavaScript characters', () => {
    expect(
      questionV2Schema.safeParse({
        id: questionId,
        title: 'Question',
        prompt: '€'.repeat(1_366),
        allowsFreeText: true,
      }).success,
    ).toBe(false);
  });

  it('caps complete question responses and resolution events at 32 KiB', () => {
    const answers = Array.from({ length: 3 }, () => ({
      questionId,
      value: 'x'.repeat(12 * 1024),
    }));
    expect(
      agentCommandV2Schema.safeParse({
        type: 'question.respond',
        commandId,
        sessionId,
        turnId,
        requestId,
        answers,
      }).success,
    ).toBe(false);
    expect(
      agentEventV2EnvelopeSchema.safeParse({
        ...turnMeta,
        type: 'question.resolved',
        requestId,
        answers,
      }).success,
    ).toBe(false);
  });

  it('accepts every command with the complete UUID correlation tuple', () => {
    const commands = [
      { type: 'input.follow_up', commandId, sessionId, turnId, content: [textBlock] },
      { type: 'input.steer', commandId, sessionId, turnId, content: [textBlock] },
      { type: 'session.interrupt', commandId, sessionId, turnId },
      { type: 'approval.respond', commandId, sessionId, turnId, requestId, decision: 'allow_once' },
      {
        type: 'question.respond',
        commandId,
        sessionId,
        turnId,
        requestId,
        answers: [{ questionId, value: 'answer' }],
      },
    ];
    for (const command of commands) {
      const result = agentCommandV2Schema.safeParse(command);
      expect(result.success, `${command.type}: ${result.success ? '' : result.error.message}`).toBe(
        true,
      );
    }
  });

  it('rejects broad approval grants and missing or malformed correlation IDs', () => {
    expect(
      agentCommandV2Schema.safeParse({
        type: 'approval.respond',
        commandId,
        sessionId,
        turnId,
        requestId,
        decision: 'allow',
      }).success,
    ).toBe(false);
    expect(
      agentCommandV2Schema.safeParse({
        type: 'approval.respond',
        commandId,
        sessionId,
        turnId,
        decision: 'deny',
      }).success,
    ).toBe(false);
    expect(
      agentCommandV2Schema.safeParse({
        type: 'session.interrupt',
        commandId: 'not-a-uuid',
        sessionId,
        turnId,
      }).success,
    ).toBe(false);
  });

  it('enforces whole-request bounds before dispatch', () => {
    expect(
      createSessionV2RequestSchema.safeParse({
        provider: 'claude',
        cwd: '/tmp',
        prompt: 'x'.repeat(200_001),
      }).success,
    ).toBe(false);
    expect(
      createSessionV2RequestSchema.safeParse({
        provider: 'claude',
        cwd: '/tmp',
        prompt: 'hi',
        capabilities: {
          required: Array.from({ length: 1_025 }, (_, index) => ({
            id: `ext.example.feature_${index}`,
          })),
          optional: [],
          allowExperimental: false,
        },
      }).success,
    ).toBe(false);
  });

  it('accepts only the strict public resume/fork continuation union', () => {
    for (const kind of ['resume', 'fork'] as const) {
      expect(
        createSessionV2RequestSchema.safeParse({
          provider: 'codex',
          cwd: '/tmp',
          prompt: 'continue',
          continuation: { kind, providerSessionId: 'native-thread-1' },
        }).success,
      ).toBe(true);
    }
    expect(
      createSessionV2RequestSchema.safeParse({
        provider: 'codex',
        cwd: '/tmp',
        prompt: 'continue',
        continuation: {
          kind: 'fork',
          providerSessionId: 'native-thread-1',
          lastTurnId: 'must-not-be-public',
        },
      }).success,
    ).toBe(false);
    expect(
      createSessionV2RequestSchema.safeParse({
        provider: 'codex',
        cwd: '/tmp',
        prompt: 'continue',
        continuation: { kind: 'resume', providerSessionId: 'bad\nthread' },
      }).success,
    ).toBe(false);
  });

  it('validates session snapshots and cancellation acknowledgements', () => {
    expect(
      agentSessionV2Schema.safeParse({
        id: sessionId,
        provider: 'claude',
        transport: 'cli',
        cwd: '/tmp',
        status: 'active',
        selection,
        executionId,
        currentTurnId: turnId,
        acceptedWork: 'accepted',
        startedAt: timestamp,
        providerSessionId: 'thread_123',
        runtimeMetadata: {
          cliVersion: '0.147.0',
          schemaVersion: 'schema-0.147.0',
          fixtureSet: 'codex-app-server-0.147.0-v1',
          requestedTransportMode: 'auto',
          fallbackReason: 'app_server_handshake_failed',
        },
        earliestSequence: 0,
      }).success,
    ).toBe(true);
    expect(
      agentSessionV2Schema.safeParse({
        id: sessionId,
        provider: 'codex',
        transport: 'legacy-one-shot',
        cwd: '/tmp',
        status: 'active',
        selection,
        executionId,
        acceptedWork: 'unknown',
        startedAt: timestamp,
        runtimeMetadata: { fallbackReason: 'prompt: secret value' },
        earliestSequence: 0,
      }).success,
    ).toBe(false);
    expect(
      agentSessionV2Schema.safeParse({
        id: sessionId,
        provider: 'codex',
        transport: 'codex-app-server',
        cwd: '/tmp',
        status: 'active',
        selection,
        executionId,
        acceptedWork: 'accepted',
        startedAt: timestamp,
        providerSessionId: `thread-${'x'.repeat(1_025)}`,
        earliestSequence: 0,
      }).success,
    ).toBe(false);
    expect(
      cancelSessionV2ResponseSchema.safeParse({ status: 'cancelling', sessionId }).success,
    ).toBe(true);
    expect(cancelSessionV2ResponseSchema.safeParse({ status: 'cancelling' }).success).toBe(false);
  });
});

describe('protocol v2 event envelope schema', () => {
  it('accepts every normalized event kind', () => {
    const events = [
      { ...meta, type: 'session.started', provider: 'claude', transport: 'cli', selection },
      { ...meta, type: 'session.status', status: 'active' },
      { ...meta, type: 'session.completed' },
      { ...meta, type: 'session.failed', code: 'failed', message: 'failed' },
      { ...meta, type: 'session.cancelled', reason: 'user' },
      { ...meta, type: 'session.interrupted', reason: 'restart' },
      { ...turnMeta, type: 'turn.started' },
      { ...turnMeta, type: 'turn.completed' },
      { ...turnMeta, type: 'turn.failed', code: 'failed', message: 'failed' },
      { ...turnMeta, type: 'turn.interrupted', reason: 'user' },
      { ...turnMeta, type: 'content.delta', contentBlockId, delta: 'hi' },
      { ...turnMeta, type: 'content.completed', block: textBlock },
      {
        ...turnMeta,
        type: 'tool.started',
        toolCallId,
        contentBlockId,
        toolName: 'read_file',
        possibleEffects: ['read'],
        effectsComplete: true,
      },
      {
        ...turnMeta,
        type: 'tool.completed',
        toolCallId,
        contentBlockId,
        toolName: 'read_file',
        status: 'completed',
        summary: 'done',
      },
      {
        ...turnMeta,
        type: 'approval.requested',
        requestId,
        title: 'Run?',
        action: 'run',
        target: 'target',
        possibleEffects: ['command'],
        effectsComplete: true,
        deadlineAt: timestamp,
      },
      { ...turnMeta, type: 'approval.resolved', requestId, decision: 'denied', actor: 'user' },
      {
        ...turnMeta,
        type: 'question.requested',
        requestId,
        deadlineAt: timestamp,
        questions: [
          {
            id: questionId,
            title: 'Question',
            prompt: 'Choose',
            options: [{ id: optionId, label: 'A' }],
            allowsFreeText: false,
          },
        ],
      },
      { ...turnMeta, type: 'question.resolved', requestId, answers: [{ questionId, value: 'A' }] },
      { ...turnMeta, type: 'question.cancelled', requestId, reason: 'timeout' },
      { ...meta, turnId, type: 'usage.tokens', scope: 'turn', inputTokens: 1, outputTokens: 2 },
      {
        ...meta,
        type: 'usage.cost',
        scope: 'session',
        cost: 0.25,
        currency: 'USD',
        estimated: false,
      },
      { ...meta, turnId, type: 'error', code: 'oops', message: 'oops', recoverable: true },
      {
        ...meta,
        type: 'extension.summary',
        extensionName: 'provider.future',
        summary: 'unsupported item',
        reason: 'unsupported',
      },
    ];
    expect(events.map((event) => event.type)).toEqual(AGENT_EVENT_V2_TYPES);
    for (const event of events) {
      const result = agentEventV2EnvelopeSchema.safeParse(event);
      expect(result.success, `${event.type}: ${result.success ? '' : result.error.message}`).toBe(
        true,
      );
    }
  });

  it('rejects provider-native event names and incomplete turn correlation', () => {
    expect(agentEventV2EnvelopeSchema.safeParse({ ...meta, type: 'thread.started' }).success).toBe(
      false,
    );
    expect(
      agentEventV2EnvelopeSchema.safeParse({
        ...meta,
        type: 'content.completed',
        block: textBlock,
      }).success,
    ).toBe(false);
    expect(
      agentEventV2EnvelopeSchema.safeParse({
        ...turnMeta,
        sessionId: 'wrong',
        type: 'turn.started',
      }).success,
    ).toBe(false);
  });
});
