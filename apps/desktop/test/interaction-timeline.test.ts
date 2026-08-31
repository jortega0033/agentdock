import { describe, expect, it } from 'vitest';
import { RendererInteractionTimelineProjector } from '../src/components/activity/interaction-timeline.js';

const interactionHandle = 'opaque-interaction-handle';

describe('RendererInteractionTimelineProjector', () => {
  it('uses the opaque interaction handle for coalescing and never projects question capabilities', () => {
    const projector = new RendererInteractionTimelineProjector();
    const event = projector.projectInteraction({
      kind: 'question',
      interactionHandle,
      deadlineAt: '2026-08-31T00:00:00.000Z',
      questions: [
        {
          questionHandle: 'native-question-id-must-not-leak',
          title: 'Choose deployment',
          prompt: 'Where should this run?',
          options: [
            {
              optionHandle: 'native-option-id-must-not-leak',
              label: 'Staging',
              description: 'Safe preview environment',
            },
          ],
          allowsFreeText: false,
          preview: 'No production changes',
        },
      ],
    });

    expect(event).toEqual({
      type: 'question.requested',
      requestId: interactionHandle,
      deadlineAt: '2026-08-31T00:00:00.000Z',
      questions: [
        {
          title: 'Choose deployment',
          prompt: 'Where should this run?',
          options: [{ label: 'Staging', description: 'Safe preview environment' }],
          allowsFreeText: false,
          preview: 'No production changes',
        },
      ],
    });
    const displayedPayload = JSON.stringify(event);
    expect(displayedPayload).not.toContain('native-question-id-must-not-leak');
    expect(displayedPayload).not.toContain('native-option-id-must-not-leak');
  });

  it('projects approval settlement with the same opaque handle and settles it once', () => {
    const projector = new RendererInteractionTimelineProjector();
    projector.projectInteraction({
      kind: 'approval',
      interactionHandle,
      title: 'Run tests',
      action: 'pnpm test',
      target: 'workspace',
      possibleEffects: ['command'],
      effectsComplete: true,
      allowedDecisions: ['allow_once', 'deny'],
      deadlineAt: '2026-08-31T00:00:00.000Z',
    });

    expect(
      projector.projectResolution({
        kind: 'approval_resolved',
        interactionHandle,
        reason: 'allowed',
      }),
    ).toEqual({ type: 'approval.resolved', requestId: interactionHandle, decision: 'allowed' });
    expect(
      projector.projectResolution({
        kind: 'approval_resolved',
        interactionHandle,
        reason: 'allowed',
      }),
    ).toBeUndefined();
  });

  it('retains original interaction kind for resolution and terminal cancellation', () => {
    const projector = new RendererInteractionTimelineProjector();
    projector.projectInteraction({
      kind: 'question',
      interactionHandle: 'question-handle',
      deadlineAt: '2026-08-31T00:00:00.000Z',
      questions: [],
    });
    projector.projectInteraction({
      kind: 'approval',
      interactionHandle: 'approval-handle',
      title: 'Delete files',
      action: 'rm',
      target: 'workspace',
      possibleEffects: ['destructive'],
      effectsComplete: true,
      allowedDecisions: ['deny'],
      deadlineAt: '2026-08-31T00:00:00.000Z',
    });
    projector.projectInteraction({
      kind: 'question',
      interactionHandle: 'cleared-question-handle',
      deadlineAt: '2026-08-31T00:00:00.000Z',
      questions: [],
    });

    expect(
      projector.projectResolution({
        kind: 'question_resolved',
        interactionHandle: 'question-handle',
      }),
    ).toEqual({ type: 'question.resolved', requestId: 'question-handle' });
    expect(
      projector.projectResolution({
        kind: 'session_terminal',
        interactionHandle: 'approval-handle',
        reason: 'interrupted',
      }),
    ).toEqual({
      type: 'approval.cancelled',
      requestId: 'approval-handle',
      reason: 'session_terminal:interrupted',
    });
    expect(
      projector.projectResolution({
        kind: 'session_cleared',
        interactionHandle: 'cleared-question-handle',
        reason: 'shutdown',
      }),
    ).toEqual({
      type: 'question.cancelled',
      requestId: 'cleared-question-handle',
      reason: 'session_cleared:shutdown',
    });
  });

  it('keeps explicit question cancellation reason and ignores unknown handles', () => {
    const projector = new RendererInteractionTimelineProjector();
    projector.projectInteraction({
      kind: 'question',
      interactionHandle,
      deadlineAt: '2026-08-31T00:00:00.000Z',
      questions: [],
    });

    expect(
      projector.projectResolution({
        kind: 'question_cancelled',
        interactionHandle,
        reason: 'timeout',
      }),
    ).toEqual({ type: 'question.cancelled', requestId: interactionHandle, reason: 'timeout' });
    expect(
      projector.projectResolution({
        kind: 'session_cleared',
        interactionHandle: 'unknown-handle',
        reason: 'shutdown',
      }),
    ).toBeUndefined();
  });

  it('forgets opaque handles when a new session resets the projector', () => {
    const projector = new RendererInteractionTimelineProjector();
    projector.projectInteraction({
      kind: 'approval',
      interactionHandle,
      title: 'Run tests',
      action: 'pnpm test',
      target: 'workspace',
      possibleEffects: ['command'],
      effectsComplete: true,
      allowedDecisions: ['allow_once', 'deny'],
      deadlineAt: '2026-08-31T00:00:00.000Z',
    });

    projector.reset();

    expect(
      projector.projectResolution({
        interactionHandle,
        kind: 'approval_resolved',
        reason: 'allowed',
      }),
    ).toBeUndefined();
  });
});
