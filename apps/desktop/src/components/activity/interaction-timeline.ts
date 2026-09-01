import type {
  RendererInteraction,
  RendererInteractionResolution,
} from '../../../electron/interaction-broker.js';
import type { TimelineEventInput } from './types.js';

type InteractionKind = RendererInteraction['kind'];

function timelineEvent(record: Readonly<Record<string, unknown>>): TimelineEventInput {
  return record;
}

/**
 * Projects renderer-facing interactions into timeline events without reintroducing the native
 * request, question, or option identifiers which the interaction broker intentionally hides.
 *
 * The opaque interaction handle becomes the timeline request ID only so a later resolution can
 * replace its requested item. It is not a provider/native request ID.
 */
export class RendererInteractionTimelineProjector {
  readonly #kindsByHandle = new Map<string, InteractionKind>();

  reset(): void {
    this.#kindsByHandle.clear();
  }

  projectInteraction(interaction: RendererInteraction): TimelineEventInput {
    this.#kindsByHandle.set(interaction.interactionHandle, interaction.kind);

    if (interaction.kind === 'approval') {
      return timelineEvent({
        type: 'approval.requested',
        requestId: interaction.interactionHandle,
        title: interaction.title,
        action: interaction.action,
        target: interaction.target,
        ...(interaction.reason === undefined ? {} : { reason: interaction.reason }),
        possibleEffects: interaction.possibleEffects,
        effectsComplete: interaction.effectsComplete,
        allowedDecisions: interaction.allowedDecisions,
        deadlineAt: interaction.deadlineAt,
      });
    }

    return timelineEvent({
      type: 'question.requested',
      requestId: interaction.interactionHandle,
      deadlineAt: interaction.deadlineAt,
      // Deliberately project display values only. questionHandle and optionHandle are UI
      // capabilities, not timeline content, and must never cross this boundary.
      questions: interaction.questions.map((question) => ({
        title: question.title,
        prompt: question.prompt,
        ...(question.options === undefined
          ? {}
          : {
              options: question.options.map((option) => ({
                label: option.label,
                ...(option.description === undefined ? {} : { description: option.description }),
              })),
            }),
        allowsFreeText: question.allowsFreeText,
        ...(question.preview === undefined ? {} : { preview: question.preview }),
      })),
    });
  }

  /**
   * Returns undefined for an unknown or already-settled opaque handle. This avoids synthesizing
   * a timeline item from an uncorrelated renderer resolution.
   */
  projectResolution(resolution: RendererInteractionResolution): TimelineEventInput | undefined {
    const interactionKind = this.#kindsByHandle.get(resolution.interactionHandle);
    if (!interactionKind) return undefined;
    this.#kindsByHandle.delete(resolution.interactionHandle);

    if (resolution.kind === 'approval_resolved') {
      return timelineEvent({
        type: 'approval.resolved',
        requestId: resolution.interactionHandle,
        decision: resolution.reason,
      });
    }

    if (resolution.kind === 'question_resolved') {
      return timelineEvent({ type: 'question.resolved', requestId: resolution.interactionHandle });
    }

    if (resolution.kind === 'question_cancelled') {
      return timelineEvent({
        type: 'question.cancelled',
        requestId: resolution.interactionHandle,
        reason: resolution.reason,
      });
    }

    const reason =
      resolution.kind === 'session_terminal'
        ? `session_terminal:${resolution.reason}`
        : `session_cleared:${resolution.reason}`;
    return timelineEvent({
      type: `${interactionKind}.cancelled`,
      requestId: resolution.interactionHandle,
      reason,
    });
  }
}
