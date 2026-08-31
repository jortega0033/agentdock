import { describe, expect, it } from 'vitest';
import type { AgentEventV2Envelope } from '@agent-dock/shared';
import {
  InteractionBroker,
  InteractionBrokerError,
  type RendererQuestionInteraction,
} from '../electron/interaction-broker.js';

const sessionId = '00000000-0000-4000-8000-000000000001';
const executionId = '00000000-0000-4000-8000-000000000002';
const turnId = '00000000-0000-4000-8000-000000000003';
const requestId = '00000000-0000-4000-8000-000000000004';
const toolCallId = '00000000-0000-4000-8000-000000000005';
const questionIds = [
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000012',
  '00000000-0000-4000-8000-000000000013',
] as const;
const optionIds = [
  '00000000-0000-4000-8000-000000000020',
  '00000000-0000-4000-8000-000000000021',
] as const;
const timestamp = '2026-08-31T09:00:00.000Z';

const meta = { sessionId, executionId, turnId, sequence: 1, timestamp };

function approvalEvent(): AgentEventV2Envelope {
  return {
    ...meta,
    type: 'approval.requested',
    requestId,
    toolCallId,
    title: 'Write file?',
    action: 'write',
    target: 'workspace file',
    possibleEffects: ['filesystem_write'],
    effectsComplete: true,
    allowedDecisions: ['allow_once', 'allow_session', 'deny'],
    deadlineAt: timestamp,
  };
}

function questionEvent(count = 2): AgentEventV2Envelope {
  const questions = [
    {
      id: questionIds[0],
      title: 'Mode',
      prompt: 'Choose a mode',
      options: [
        { id: optionIds[0], label: 'Safe' },
        { id: optionIds[1], label: 'Fast', description: 'Use faster mode' },
      ],
      allowsFreeText: false,
    },
    {
      id: questionIds[1],
      title: 'Details',
      prompt: 'Add details',
      allowsFreeText: true,
      preview: 'Optional context',
    },
    {
      id: questionIds[2],
      title: 'Confirm',
      prompt: 'Confirm',
      allowsFreeText: true,
    },
    {
      id: questionIds[3],
      title: 'Extra',
      prompt: 'Extra question',
      allowsFreeText: true,
    },
  ].slice(0, count);
  return {
    ...meta,
    type: 'question.requested',
    requestId,
    questions,
    deadlineAt: timestamp,
  };
}

function expectBrokerError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('expected broker error');
  } catch (error) {
    expect(error).toBeInstanceOf(InteractionBrokerError);
    expect((error as InteractionBrokerError).code).toBe(code);
  }
}

describe('interaction broker', () => {
  it('maps an approval through one opaque handle and creates correlation only in main', () => {
    const broker = new InteractionBroker();
    const interaction = broker.publish(approvalEvent());
    expect(interaction.kind).toBe('approval');
    if (interaction.kind !== 'approval') throw new Error('expected approval');
    expect(interaction.interactionHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rendererJson = JSON.stringify(interaction);
    for (const privateId of [sessionId, executionId, turnId, requestId, toolCallId]) {
      expect(rendererJson).not.toContain(privateId);
    }

    const command = broker.resolveApproval({
      interactionHandle: interaction.interactionHandle,
      decision: 'allow_session',
    });
    expect(command).toMatchObject({
      type: 'approval.respond',
      sessionId,
      turnId,
      requestId,
      decision: 'allow_session',
    });
    expect(command.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expectBrokerError(
      () =>
        broker.resolveApproval({
          interactionHandle: interaction.interactionHandle,
          decision: 'deny',
        }),
      'unknown_handle',
    );
  });

  it('retains non-resolvable correlation until daemon resolution emits a safe notice', () => {
    const broker = new InteractionBroker();
    const approval = broker.publish(approvalEvent());
    if (approval.kind !== 'approval') throw new Error('expected approval');
    const approvalResponse = {
      interactionHandle: approval.interactionHandle,
      decision: 'deny' as const,
    };

    expect(broker.resolveApproval(approvalResponse).type).toBe('approval.respond');
    expectBrokerError(() => broker.resolveApproval(approvalResponse), 'unknown_handle');
    expect(
      broker.consumeResolution({
        ...meta,
        type: 'approval.resolved',
        requestId,
        decision: 'denied',
        actor: 'user',
      }),
    ).toEqual([
      {
        interactionHandle: approval.interactionHandle,
        kind: 'approval_resolved',
        reason: 'denied',
      },
    ]);

    const questions = broker.publish(questionEvent(1)) as RendererQuestionInteraction;
    const questionResponse = {
      interactionHandle: questions.interactionHandle,
      answers: [
        {
          questionHandle: questions.questions[0]!.questionHandle,
          answer: {
            kind: 'options' as const,
            optionHandles: [questions.questions[0]!.options![0]!.optionHandle],
          },
        },
      ],
    };
    expect(broker.resolveQuestions(questionResponse).type).toBe('question.respond');
    expectBrokerError(() => broker.resolveQuestions(questionResponse), 'unknown_handle');
    expect(
      broker.consumeResolution({
        ...meta,
        type: 'question.resolved',
        requestId,
        answers: [{ questionId: questionIds[0], value: [optionIds[0]] }],
      }),
    ).toEqual([
      {
        interactionHandle: questions.interactionHandle,
        kind: 'question_resolved',
      },
    ]);
  });

  it('rejects renderer-supplied correlation fields without consuming the handle', () => {
    const broker = new InteractionBroker();
    const interaction = broker.publish(approvalEvent());
    const responderLease = 'L'.repeat(43);
    if (interaction.kind !== 'approval') throw new Error('expected approval');
    expectBrokerError(
      () =>
        broker.resolveApproval({
          interactionHandle: interaction.interactionHandle,
          decision: 'deny',
          sessionId,
          responderLease,
        }),
      'invalid_response',
    );
    const command = broker.resolveApproval({
      interactionHandle: interaction.interactionHandle,
      decision: 'deny',
    });
    expect(command).toMatchObject({
      type: 'approval.respond',
      decision: 'deny',
      sessionId,
      turnId,
      requestId,
    });
    expect(JSON.stringify(interaction)).not.toContain(responderLease);
    expect(JSON.stringify(command)).not.toContain(responderLease);
  });

  it('maps opaque question and option handles back to private daemon IDs exactly once', () => {
    const broker = new InteractionBroker();
    const interaction = broker.publish(questionEvent()) as RendererQuestionInteraction;
    expect(interaction.kind).toBe('question');
    expect(new Set(interaction.questions.map((question) => question.questionHandle)).size).toBe(2);
    const rendererJson = JSON.stringify(interaction);
    for (const privateId of [
      sessionId,
      executionId,
      turnId,
      requestId,
      ...questionIds,
      ...optionIds,
    ]) {
      expect(rendererJson).not.toContain(privateId);
    }
    const optionHandle = interaction.questions[0]?.options?.[1]?.optionHandle;
    expect(optionHandle).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expectBrokerError(
      () =>
        broker.resolveApproval({
          interactionHandle: interaction.interactionHandle,
          decision: 'deny',
        }),
      'kind_mismatch',
    );

    const response = {
      interactionHandle: interaction.interactionHandle,
      answers: [
        {
          questionHandle: interaction.questions[0]!.questionHandle,
          answer: { kind: 'options', optionHandles: [optionHandle] },
        },
        {
          questionHandle: interaction.questions[1]!.questionHandle,
          answer: { kind: 'text', text: 'Use defaults' },
        },
      ],
    };
    const command = broker.resolveQuestions(response);
    expect(command).toMatchObject({
      type: 'question.respond',
      sessionId,
      turnId,
      requestId,
      answers: [
        { questionId: questionIds[0], value: [optionIds[1]] },
        { questionId: questionIds[1], value: 'Use defaults' },
      ],
    });
    expectBrokerError(() => broker.resolveQuestions(response), 'unknown_handle');
  });

  it('invalidates only the matching kind when a daemon resolution wins the race', () => {
    const broker = new InteractionBroker();
    const approval = broker.publish(approvalEvent());
    const questions = broker.publish(questionEvent()) as RendererQuestionInteraction;
    if (approval.kind !== 'approval') throw new Error('expected approval');

    const resolution = broker.consumeResolution({
      ...meta,
      type: 'approval.resolved',
      requestId,
      decision: 'denied',
      actor: 'user',
    });
    expect(resolution).toEqual([
      {
        interactionHandle: approval.interactionHandle,
        kind: 'approval_resolved',
        reason: 'denied',
      },
    ]);
    expect(JSON.stringify(resolution)).not.toContain(sessionId);
    expect(JSON.stringify(resolution)).not.toContain(requestId);
    expectBrokerError(
      () =>
        broker.resolveApproval({
          interactionHandle: approval.interactionHandle,
          decision: 'deny',
        }),
      'unknown_handle',
    );

    expect(
      broker.resolveQuestions({
        interactionHandle: questions.interactionHandle,
        answers: [
          {
            questionHandle: questions.questions[0]!.questionHandle,
            answer: {
              kind: 'options',
              optionHandles: [questions.questions[0]!.options![0]!.optionHandle],
            },
          },
          {
            questionHandle: questions.questions[1]!.questionHandle,
            answer: { kind: 'text', text: 'still pending' },
          },
        ],
      }).type,
    ).toBe('question.respond');
    expect(
      broker.consumeResolution({
        ...meta,
        type: 'approval.resolved',
        requestId,
        decision: 'denied',
        actor: 'user',
      }),
    ).toEqual([]);
  });

  it('drops pending questions on cancellation or session teardown and rejects late answers', () => {
    const broker = new InteractionBroker();
    const cancelled = broker.publish(questionEvent()) as RendererQuestionInteraction;
    expect(
      broker.consumeResolution({
        ...meta,
        type: 'question.cancelled',
        requestId,
        reason: 'timeout',
      }),
    ).toEqual([
      {
        interactionHandle: cancelled.interactionHandle,
        kind: 'question_cancelled',
        reason: 'timeout',
      },
    ]);
    expectBrokerError(
      () =>
        broker.resolveQuestions({
          interactionHandle: cancelled.interactionHandle,
          answers: [
            {
              questionHandle: cancelled.questions[0]!.questionHandle,
              answer: {
                kind: 'options',
                optionHandles: [cancelled.questions[0]!.options![0]!.optionHandle],
              },
            },
            {
              questionHandle: cancelled.questions[1]!.questionHandle,
              answer: { kind: 'text', text: 'late' },
            },
          ],
        }),
      'unknown_handle',
    );

    const approval = broker.publish(approvalEvent());
    if (approval.kind !== 'approval') throw new Error('expected approval');
    expect(broker.clearSession(sessionId, 'shutdown')).toEqual([
      {
        interactionHandle: approval.interactionHandle,
        kind: 'session_cleared',
        reason: 'shutdown',
      },
    ]);
    expectBrokerError(
      () =>
        broker.resolveApproval({
          interactionHandle: approval.interactionHandle,
          decision: 'deny',
        }),
      'unknown_handle',
    );
  });

  it('consumes question resolutions without returning answers or correlation IDs', () => {
    const broker = new InteractionBroker();
    const questions = broker.publish(questionEvent()) as RendererQuestionInteraction;
    const resolution = broker.consumeResolution({
      ...meta,
      type: 'question.resolved',
      requestId,
      answers: [
        { questionId: questionIds[0], value: 'DO_NOT_RETURN_ANSWER' },
        { questionId: questionIds[1], value: 'DO_NOT_RETURN_ANSWER' },
      ],
    });
    expect(resolution).toEqual([
      { interactionHandle: questions.interactionHandle, kind: 'question_resolved' },
    ]);
    expect(JSON.stringify(resolution)).not.toContain('DO_NOT_RETURN_ANSWER');
    expect(JSON.stringify(resolution)).not.toContain(questionIds[0]);
    expectBrokerError(
      () =>
        broker.resolveQuestions({
          interactionHandle: questions.interactionHandle,
          answers: [
            {
              questionHandle: questions.questions[0]!.questionHandle,
              answer: {
                kind: 'options',
                optionHandles: [questions.questions[0]!.options![0]!.optionHandle],
              },
            },
            {
              questionHandle: questions.questions[1]!.questionHandle,
              answer: { kind: 'text', text: 'late' },
            },
          ],
        }),
      'unknown_handle',
    );
  });

  it('invalidates every session interaction on a terminal envelope without returning its content', () => {
    const broker = new InteractionBroker();
    const approval = broker.publish(approvalEvent());
    const questions = broker.publish(questionEvent()) as RendererQuestionInteraction;
    const resolution = broker.consumeResolution({
      sessionId,
      executionId,
      sequence: 2,
      timestamp,
      type: 'session.failed',
      code: 'provider_failure',
      message: 'DO_NOT_RETURN_TERMINAL_CONTENT',
    });
    expect(resolution).toEqual([
      {
        interactionHandle: approval.interactionHandle,
        kind: 'session_terminal',
        reason: 'failed',
      },
      {
        interactionHandle: questions.interactionHandle,
        kind: 'session_terminal',
        reason: 'failed',
      },
    ]);
    expect(JSON.stringify(resolution)).not.toContain('DO_NOT_RETURN_TERMINAL_CONTENT');
    expect(JSON.stringify(resolution)).not.toContain(sessionId);
    expectBrokerError(
      () =>
        broker.resolveApproval({
          interactionHandle: approval.interactionHandle,
          decision: 'deny',
        }),
      'unknown_handle',
    );
    expectBrokerError(
      () =>
        broker.resolveQuestions({
          interactionHandle: questions.interactionHandle,
          answers: [
            {
              questionHandle: questions.questions[0]!.questionHandle,
              answer: {
                kind: 'options',
                optionHandles: [questions.questions[0]!.options![0]!.optionHandle],
              },
            },
            {
              questionHandle: questions.questions[1]!.questionHandle,
              answer: { kind: 'text', text: 'late' },
            },
          ],
        }),
      'unknown_handle',
    );
  });

  it('enforces question count, option count, exact answers, and the 32 KiB answer bound', () => {
    const broker = new InteractionBroker();
    expectBrokerError(() => broker.publish(questionEvent(4)), 'invalid_event');

    const tooManyOptions = questionEvent(1);
    if (tooManyOptions.type !== 'question.requested') throw new Error('expected questions');
    tooManyOptions.questions[0]!.options = Array.from({ length: 11 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      label: `Option ${index}`,
    }));
    expectBrokerError(() => broker.publish(tooManyOptions), 'invalid_event');

    const answerLimitEvent = questionEvent(3);
    if (answerLimitEvent.type !== 'question.requested') throw new Error('expected questions');
    answerLimitEvent.questions[0]!.allowsFreeText = true;
    const interaction = broker.publish(answerLimitEvent) as RendererQuestionInteraction;
    expectBrokerError(
      () =>
        broker.resolveQuestions({
          interactionHandle: interaction.interactionHandle,
          answers: interaction.questions.map((question) => ({
            questionHandle: question.questionHandle,
            answer: { kind: 'text', text: 'x'.repeat(11_000) },
          })),
        }),
      'invalid_response',
    );
    expectBrokerError(
      () =>
        broker.resolveQuestions({
          interactionHandle: interaction.interactionHandle,
          answers: [
            {
              questionHandle: interaction.questions[0]!.questionHandle,
              answer: {
                kind: 'options',
                optionHandles: [interaction.questions[0]!.options![0]!.optionHandle],
              },
            },
          ],
        }),
      'invalid_response',
    );
    expect(
      broker.resolveQuestions({
        interactionHandle: interaction.interactionHandle,
        answers: [
          {
            questionHandle: interaction.questions[0]!.questionHandle,
            answer: {
              kind: 'options',
              optionHandles: [interaction.questions[0]!.options![0]!.optionHandle],
            },
          },
          {
            questionHandle: interaction.questions[1]!.questionHandle,
            answer: { kind: 'text', text: 'ok' },
          },
          {
            questionHandle: interaction.questions[2]!.questionHandle,
            answer: { kind: 'text', text: 'ok' },
          },
        ],
      }).type,
    ).toBe('question.respond');
  });
});
