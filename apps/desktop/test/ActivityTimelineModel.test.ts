import { describe, expect, it } from 'vitest';
import type { AgentEventEnvelope, AgentEventV2Envelope } from '@agent-dock/shared';
import {
  MAX_ACTIVITY_TEXT_LENGTH,
  MAX_ACTIVITY_VALUE_ITEMS,
  projectActivityTimeline,
  toSafeActivityValue,
} from '../src/components/activity/model.js';

const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const executionId = '123e4567-e89b-42d3-a456-426614174001';
const turnId = '123e4567-e89b-42d3-a456-426614174002';
const contentBlockId = '123e4567-e89b-42d3-a456-426614174003';
const toolCallId = '123e4567-e89b-42d3-a456-426614174004';
const requestId = '123e4567-e89b-42d3-a456-426614174005';
const timestamp = '2026-08-31T00:00:00.000Z';

function meta(sequence: number) {
  return { sessionId, executionId, turnId, sequence, timestamp };
}

describe('projectActivityTimeline', () => {
  it('coalesces deltas by content ID and replaces the streaming value once completed', () => {
    const events: AgentEventV2Envelope[] = [
      { ...meta(0), type: 'content.delta', contentBlockId, delta: 'hello ' },
      { ...meta(1), type: 'content.delta', contentBlockId, delta: 'world' },
      {
        ...meta(2),
        type: 'content.completed',
        block: { type: 'text', id: contentBlockId, text: 'hello world!' },
      },
    ];

    const { items } = projectActivityTimeline(events);
    expect(items).toHaveLength(1);
    expect(items[0]!).toMatchObject({
      id: `content:${sessionId}:${executionId}:${contentBlockId}`,
      state: 'completed',
      body: 'hello world!',
    });
    expect(items[0]!.eventTypes).toEqual(['content.delta', 'content.completed']);
  });

  it('clears draft-only state when completed content replaces a stream', () => {
    const imageId = '123e4567-e89b-42d3-a456-426614174006';
    const { items } = projectActivityTimeline([
      {
        ...meta(0),
        type: 'content.delta',
        contentBlockId,
        delta: 'x'.repeat(MAX_ACTIVITY_TEXT_LENGTH + 50),
      },
      {
        ...meta(1),
        type: 'content.completed',
        block: { type: 'text', id: contentBlockId, text: 'final' },
      },
      { ...meta(2), type: 'content.delta', contentBlockId: imageId, delta: 'draft alt text' },
      {
        ...meta(3),
        type: 'content.completed',
        block: {
          type: 'image',
          id: imageId,
          attachmentId: '123e4567-e89b-42d3-a456-426614174007',
          name: 'preview.png',
          mimeType: 'image/png',
          byteLength: 128,
        },
      },
    ]);

    expect(items[0]).toMatchObject({ body: 'final', truncated: false });
    expect(items[1]).not.toHaveProperty('body');
  });

  it('keeps started tool-activity blocks in progress', () => {
    const { items } = projectActivityTimeline([
      {
        ...meta(0),
        type: 'content.completed',
        block: {
          type: 'tool_activity',
          id: contentBlockId,
          toolCallId,
          toolName: 'shell',
          status: 'started',
          possibleEffects: ['command'],
          effectsComplete: true,
        },
      },
    ]);

    expect(items[0]).toMatchObject({ state: 'running', inProgress: true });
  });

  it('correlates tool, approval, and question lifecycles into stable records', () => {
    const events: AgentEventV2Envelope[] = [
      {
        ...meta(0),
        type: 'tool.started',
        toolCallId,
        contentBlockId,
        toolName: 'shell',
        possibleEffects: ['command'],
        effectsComplete: true,
      },
      {
        ...meta(1),
        type: 'tool.completed',
        toolCallId,
        contentBlockId,
        toolName: 'shell',
        status: 'completed',
        summary: 'done',
      },
      {
        ...meta(2),
        type: 'approval.requested',
        requestId,
        title: 'Run shell',
        action: 'npm test',
        target: 'workspace',
        possibleEffects: ['command'],
        effectsComplete: true,
        deadlineAt: timestamp,
      },
      { ...meta(3), type: 'approval.resolved', requestId, decision: 'allowed', actor: 'user' },
      {
        ...meta(4),
        type: 'question.requested',
        requestId,
        questions: [{ id: requestId, title: 'Pick', prompt: 'Which?', allowsFreeText: true }],
        deadlineAt: timestamp,
      },
      { ...meta(5), type: 'question.cancelled', requestId, reason: 'cancel' },
    ];

    const { items } = projectActivityTimeline(events);
    expect(items).toHaveLength(3);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `tool:${sessionId}:${executionId}:${toolCallId}`,
          category: 'tool',
          state: 'completed',
          body: 'done',
        }),
        expect.objectContaining({
          id: `approval:${sessionId}:${executionId}:${requestId}`,
          category: 'approval',
          state: 'completed',
        }),
        expect.objectContaining({
          id: `question:${sessionId}:${executionId}:${requestId}`,
          category: 'question',
          state: 'cancelled',
        }),
      ]),
    );
    expect(
      items.find((item) => item.id === `tool:${sessionId}:${executionId}:${toolCallId}`)?.data,
    ).toMatchObject({
      possibleEffects: ['command'],
      effectsComplete: true,
      status: 'completed',
      summary: 'done',
    });
    expect(
      items.find((item) => item.id === `approval:${sessionId}:${executionId}:${requestId}`)?.data,
    ).toMatchObject({
      title: 'Run shell',
      action: 'npm test',
      target: 'workspace',
      deadlineAt: timestamp,
      decision: 'allowed',
      actor: 'user',
    });
    expect(
      items.find((item) => item.id === `question:${sessionId}:${executionId}:${requestId}`)?.data,
    ).toMatchObject({
      questions: [expect.objectContaining({ title: 'Pick', prompt: 'Which?' })],
      reason: 'cancel',
    });
  });

  it('settles synthetic approval cancellation without displaying its opaque handle', () => {
    const { items } = projectActivityTimeline([
      {
        type: 'approval.requested',
        requestId: 'opaque-handle',
        title: 'Delete files',
        action: 'remove files',
      },
      {
        type: 'approval.cancelled',
        requestId: 'opaque-handle',
        reason: 'session_terminal:failed',
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      category: 'approval',
      state: 'cancelled',
      title: 'Approval cancelled',
      data: { reason: 'session_terminal:failed' },
    });
    expect(items[0]?.data).not.toHaveProperty('requestId');
  });

  it('renders v1 events and unknown future events without provider-specific branches', () => {
    const v1: AgentEventEnvelope[] = [
      { type: 'assistant.message', text: 'legacy answer', sequence: 0, timestamp },
      {
        type: 'tool.started',
        toolName: 'legacy-tool',
        toolCallId: 'legacy-call',
        input: { query: 'safe' },
        sequence: 1,
        timestamp,
      },
      {
        type: 'tool.completed',
        toolCallId: 'legacy-call',
        result: { ok: true },
        sequence: 2,
        timestamp,
      },
    ];
    const { items } = projectActivityTimeline([
      ...v1,
      { type: 'provider.future', sequence: 3, timestamp, html: '<img src=x>' },
    ]);

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'content',
          title: 'Assistant message',
          body: 'legacy answer',
        }),
        expect.objectContaining({
          category: 'tool',
          state: 'completed',
          title: 'Tool: legacy-tool',
          id: 'legacy-tool:legacy:v1:legacy-call',
        }),
        expect.objectContaining({
          category: 'unknown',
          title: 'provider future',
          truncated: false,
        }),
      ]),
    );
    expect(items.find((item) => item.category === 'unknown')?.data).toMatchObject({
      html: '<img src=x>',
    });
  });

  it('distinguishes a v2 status update from session lifecycle and marks starts in progress', () => {
    const events: AgentEventV2Envelope[] = [
      {
        ...meta(0),
        type: 'session.started',
        provider: 'codex',
        transport: 'app-server',
        selection: {
          transport: 'app-server',
          enabled: [],
          unavailableOptional: [],
          possibleEffects: [],
          effectsComplete: true,
        },
      },
      { ...meta(1), type: 'session.status', status: 'active' },
      { ...meta(2), type: 'turn.started' },
    ];

    const { items } = projectActivityTimeline(events);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'session', state: 'running', inProgress: true }),
        expect.objectContaining({ category: 'status', state: 'running', inProgress: true }),
        expect.objectContaining({ category: 'turn', state: 'running', inProgress: true }),
      ]),
    );
  });

  it('bounds untrusted generic values and streamed output', () => {
    const huge = 'x'.repeat(MAX_ACTIVITY_TEXT_LENGTH * 250);
    const { items } = projectActivityTimeline([
      { ...meta(0), type: 'content.delta', contentBlockId, delta: huge },
    ]);
    expect(items[0]!.body).toHaveLength(MAX_ACTIVITY_TEXT_LENGTH);
    expect(items[0]!.body).toContain('(truncated)');
    expect(items[0]!.truncated).toBe(true);

    const value = toSafeActivityValue({
      nested: { tooDeep: { again: { again: { again: { cut: 'yes' } } } } },
      list: Array.from({ length: 40 }, (_, index) => index),
    });
    expect(value).toMatchObject({ list: expect.any(Array) });
    expect((value as { list: unknown[] }).list).toHaveLength(32);

    const wideTree = (depth: number): unknown =>
      depth === 0
        ? 'leaf'
        : Object.fromEntries(
            Array.from({ length: 32 }, (_, index) => [`item-${index}`, wideTree(depth - 1)]),
          );
    const boundedTree = JSON.stringify(toSafeActivityValue(wideTree(3)));
    expect(boundedTree).toContain('[additional values omitted]');
    expect(boundedTree.length).toBeLessThan(25_000);

    const wideEvent = Object.fromEntries([
      ['type', 'vendor.wide'],
      ...Array.from({ length: 10_000 }, (_, index) => [`field-${index}`, index]),
    ]);
    const projected = projectActivityTimeline([wideEvent]).items[0]!;
    expect(projected.truncated).toBe(true);
    expect(Object.keys(projected.data as Record<string, unknown>)).toHaveLength(
      MAX_ACTIVITY_VALUE_ITEMS,
    );
  });
});
