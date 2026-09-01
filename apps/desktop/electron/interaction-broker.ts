import { randomBytes, randomUUID } from 'node:crypto';
import {
  agentCommandV2Schema,
  agentEventV2EnvelopeSchema,
  sessionIdSchema,
  utf8ByteLength,
  type AgentCommandV2,
  type AgentEventV2Envelope,
  type ApprovalDecisionV2,
  type Effect,
} from '@agent-dock/shared';

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_ANSWER_BYTES = 32 * 1024;
const MAX_TEXT_ANSWER_BYTES = 16 * 1024;
const MAX_QUESTIONS = 3;
const MAX_OPTIONS = 10;

type ApprovalRequestedEvent = Extract<AgentEventV2Envelope, { type: 'approval.requested' }>;
type QuestionRequestedEvent = Extract<AgentEventV2Envelope, { type: 'question.requested' }>;
type QuestionCancelledEvent = Extract<AgentEventV2Envelope, { type: 'question.cancelled' }>;

export interface RendererApprovalInteraction {
  kind: 'approval';
  interactionHandle: string;
  title: string;
  action: string;
  target: string;
  reason?: string;
  possibleEffects: Effect[];
  effectsComplete: boolean;
  allowedDecisions: ApprovalDecisionV2[];
  deadlineAt: string;
}

export interface RendererQuestionOption {
  optionHandle: string;
  label: string;
  description?: string;
}

export interface RendererQuestion {
  questionHandle: string;
  title: string;
  prompt: string;
  options?: RendererQuestionOption[];
  allowsFreeText: boolean;
  preview?: string;
}

export interface RendererQuestionInteraction {
  kind: 'question';
  interactionHandle: string;
  questions: RendererQuestion[];
  deadlineAt: string;
}

export type RendererInteraction = RendererApprovalInteraction | RendererQuestionInteraction;

export type RendererInteractionResolution =
  | {
      interactionHandle: string;
      kind: 'approval_resolved';
      reason: 'allowed' | 'denied';
    }
  | { interactionHandle: string; kind: 'question_resolved' }
  | {
      interactionHandle: string;
      kind: 'question_cancelled';
      reason: QuestionCancelledEvent['reason'];
    }
  | {
      interactionHandle: string;
      kind: 'session_terminal';
      reason: 'completed' | 'failed' | 'cancelled' | 'interrupted';
    }
  | {
      interactionHandle: string;
      kind: 'session_cleared';
      reason: 'stream_disconnected' | 'shutdown';
    };

export interface RendererApprovalResponse {
  interactionHandle: string;
  decision: ApprovalDecisionV2;
}

export type RendererQuestionAnswer =
  { kind: 'text'; text: string } | { kind: 'options'; optionHandles: string[] };

export interface RendererQuestionResponse {
  interactionHandle: string;
  answers: Array<{ questionHandle: string; answer: RendererQuestionAnswer }>;
}

export type InteractionBrokerErrorCode =
  'invalid_event' | 'invalid_response' | 'unknown_handle' | 'kind_mismatch';

export class InteractionBrokerError extends Error {
  constructor(readonly code: InteractionBrokerErrorCode) {
    super(code);
    this.name = 'InteractionBrokerError';
  }
}

interface PendingBase {
  sessionId: string;
  turnId: string;
  requestId: string;
  issuedHandles: string[];
  responded: boolean;
}

interface PendingApproval extends PendingBase {
  kind: 'approval';
  allowedDecisions: Set<ApprovalDecisionV2>;
}

interface PendingQuestionRecord {
  questionId: string;
  allowsFreeText: boolean;
  optionIds: Map<string, string>;
}

interface PendingQuestion extends PendingBase {
  kind: 'question';
  questions: Map<string, PendingQuestionRecord>;
}

type PendingInteraction = PendingApproval | PendingQuestion;

const APPROVAL_DECISIONS = new Set<ApprovalDecisionV2>(['allow_once', 'allow_session', 'deny']);

export class InteractionBroker {
  readonly #pending = new Map<string, PendingInteraction>();
  readonly #activeHandles = new Set<string>();

  publish(event: unknown): RendererInteraction {
    const parsed = agentEventV2EnvelopeSchema.safeParse(event);
    if (
      !parsed.success ||
      (parsed.data.type !== 'approval.requested' && parsed.data.type !== 'question.requested')
    ) {
      throw new InteractionBrokerError('invalid_event');
    }
    return parsed.data.type === 'approval.requested'
      ? this.#publishApproval(parsed.data)
      : this.#publishQuestions(parsed.data);
  }

  resolveApproval(input: unknown): AgentCommandV2 {
    const response = parseApprovalResponse(input);
    const pending = this.#pending.get(response.interactionHandle);
    if (!pending) throw new InteractionBrokerError('unknown_handle');
    if (pending.kind !== 'approval') throw new InteractionBrokerError('kind_mismatch');
    if (pending.responded) throw new InteractionBrokerError('unknown_handle');
    if (!pending.allowedDecisions.has(response.decision)) {
      throw new InteractionBrokerError('invalid_response');
    }

    const command = parseCommand({
      type: 'approval.respond',
      commandId: randomUUID(),
      sessionId: pending.sessionId,
      turnId: pending.turnId,
      requestId: pending.requestId,
      decision: response.decision,
    });
    pending.responded = true;
    return command;
  }

  resolveQuestions(input: unknown): AgentCommandV2 {
    const response = parseQuestionResponse(input);
    const pending = this.#pending.get(response.interactionHandle);
    if (!pending) throw new InteractionBrokerError('unknown_handle');
    if (pending.kind !== 'question') throw new InteractionBrokerError('kind_mismatch');
    if (pending.responded) throw new InteractionBrokerError('unknown_handle');
    if (response.answers.length !== pending.questions.size) {
      throw new InteractionBrokerError('invalid_response');
    }

    const answers = response.answers.map(({ questionHandle, answer }) => {
      const question = pending.questions.get(questionHandle);
      if (!question) throw new InteractionBrokerError('invalid_response');
      if (answer.kind === 'text') {
        if (!question.allowsFreeText) throw new InteractionBrokerError('invalid_response');
        return { questionId: question.questionId, value: answer.text };
      }
      if (question.optionIds.size === 0) throw new InteractionBrokerError('invalid_response');
      const values = answer.optionHandles.map((optionHandle) => {
        const optionId = question.optionIds.get(optionHandle);
        if (!optionId) throw new InteractionBrokerError('invalid_response');
        return optionId;
      });
      return { questionId: question.questionId, value: values };
    });

    const command = parseCommand({
      type: 'question.respond',
      commandId: randomUUID(),
      sessionId: pending.sessionId,
      turnId: pending.turnId,
      requestId: pending.requestId,
      answers,
    });
    pending.responded = true;
    return command;
  }

  consumeResolution(event: unknown): RendererInteractionResolution[] {
    const parsed = agentEventV2EnvelopeSchema.safeParse(event);
    if (!parsed.success) throw new InteractionBrokerError('invalid_event');
    const resolved = parsed.data;
    switch (resolved.type) {
      case 'approval.resolved':
        return this.#invalidateMatching(
          (pending) =>
            pending.kind === 'approval' &&
            pending.sessionId === resolved.sessionId &&
            pending.turnId === resolved.turnId &&
            pending.requestId === resolved.requestId,
          (interactionHandle) => ({
            interactionHandle,
            kind: 'approval_resolved',
            reason: resolved.decision,
          }),
        );
      case 'question.resolved':
        return this.#invalidateMatching(
          (pending) =>
            pending.kind === 'question' &&
            pending.sessionId === resolved.sessionId &&
            pending.turnId === resolved.turnId &&
            pending.requestId === resolved.requestId,
          (interactionHandle) => ({ interactionHandle, kind: 'question_resolved' }),
        );
      case 'question.cancelled':
        return this.#invalidateMatching(
          (pending) =>
            pending.kind === 'question' &&
            pending.sessionId === resolved.sessionId &&
            pending.turnId === resolved.turnId &&
            pending.requestId === resolved.requestId,
          (interactionHandle) => ({
            interactionHandle,
            kind: 'question_cancelled',
            reason: resolved.reason,
          }),
        );
      case 'session.completed':
      case 'session.failed':
      case 'session.cancelled':
      case 'session.interrupted':
        return this.#invalidateMatching(
          (pending) => pending.sessionId === resolved.sessionId,
          (interactionHandle) => ({
            interactionHandle,
            kind: 'session_terminal',
            reason: terminalReason(resolved.type),
          }),
        );
      default:
        throw new InteractionBrokerError('invalid_event');
    }
  }

  clearSession(
    sessionId: string,
    reason: 'stream_disconnected' | 'shutdown',
  ): RendererInteractionResolution[] {
    if (!sessionIdSchema.safeParse(sessionId).success) {
      throw new InteractionBrokerError('invalid_event');
    }
    return this.#invalidateMatching(
      (pending) => pending.sessionId === sessionId,
      (interactionHandle) => ({ interactionHandle, kind: 'session_cleared', reason }),
    );
  }

  #publishApproval(event: ApprovalRequestedEvent): RendererApprovalInteraction {
    const interactionHandle = this.#newHandle();
    const allowedDecisions = event.allowedDecisions ?? ['allow_once', 'deny'];
    const pending: PendingApproval = {
      kind: 'approval',
      sessionId: event.sessionId,
      turnId: event.turnId,
      requestId: event.requestId,
      issuedHandles: [interactionHandle],
      responded: false,
      allowedDecisions: new Set(allowedDecisions),
    };
    this.#pending.set(interactionHandle, pending);
    return {
      kind: 'approval',
      interactionHandle,
      title: event.title,
      action: event.action,
      target: event.target,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      possibleEffects: [...event.possibleEffects],
      effectsComplete: event.effectsComplete,
      allowedDecisions: [...allowedDecisions],
      deadlineAt: event.deadlineAt,
    };
  }

  #publishQuestions(event: QuestionRequestedEvent): RendererQuestionInteraction {
    for (const question of event.questions) {
      if (!question.allowsFreeText && (!question.options || question.options.length === 0)) {
        throw new InteractionBrokerError('invalid_event');
      }
    }

    const interactionHandle = this.#newHandle();
    const issuedHandles = [interactionHandle];
    const pendingQuestions = new Map<string, PendingQuestionRecord>();
    const questions = event.questions.map((question): RendererQuestion => {
      const questionHandle = this.#newHandle();
      issuedHandles.push(questionHandle);
      const optionIds = new Map<string, string>();
      const options = question.options?.map((option): RendererQuestionOption => {
        const optionHandle = this.#newHandle();
        issuedHandles.push(optionHandle);
        optionIds.set(optionHandle, option.id);
        return {
          optionHandle,
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        };
      });
      pendingQuestions.set(questionHandle, {
        questionId: question.id,
        allowsFreeText: question.allowsFreeText,
        optionIds,
      });
      return {
        questionHandle,
        title: question.title,
        prompt: question.prompt,
        ...(options === undefined ? {} : { options }),
        allowsFreeText: question.allowsFreeText,
        ...(question.preview === undefined ? {} : { preview: question.preview }),
      };
    });
    const pending: PendingQuestion = {
      kind: 'question',
      sessionId: event.sessionId,
      turnId: event.turnId,
      requestId: event.requestId,
      issuedHandles,
      responded: false,
      questions: pendingQuestions,
    };
    this.#pending.set(interactionHandle, pending);
    return { kind: 'question', interactionHandle, questions, deadlineAt: event.deadlineAt };
  }

  #newHandle(): string {
    let handle: string;
    do {
      handle = randomBytes(32).toString('base64url');
    } while (this.#activeHandles.has(handle));
    this.#activeHandles.add(handle);
    return handle;
  }

  #consume(interactionHandle: string, pending: PendingInteraction): void {
    this.#pending.delete(interactionHandle);
    for (const handle of pending.issuedHandles) this.#activeHandles.delete(handle);
  }

  #invalidateMatching(
    matches: (pending: PendingInteraction) => boolean,
    resolution: (interactionHandle: string) => RendererInteractionResolution,
  ): RendererInteractionResolution[] {
    const resolved: RendererInteractionResolution[] = [];
    for (const [interactionHandle, pending] of this.#pending) {
      if (!matches(pending)) continue;
      this.#consume(interactionHandle, pending);
      resolved.push(resolution(interactionHandle));
    }
    return resolved;
  }
}

function terminalReason(
  type: 'session.completed' | 'session.failed' | 'session.cancelled' | 'session.interrupted',
): 'completed' | 'failed' | 'cancelled' | 'interrupted' {
  switch (type) {
    case 'session.completed':
      return 'completed';
    case 'session.failed':
      return 'failed';
    case 'session.cancelled':
      return 'cancelled';
    case 'session.interrupted':
      return 'interrupted';
  }
}

function parseApprovalResponse(value: unknown): RendererApprovalResponse {
  if (!isRecordWithKeys(value, ['interactionHandle', 'decision'])) {
    throw new InteractionBrokerError('invalid_response');
  }
  if (!isHandle(value.interactionHandle) || !APPROVAL_DECISIONS.has(value.decision as never)) {
    throw new InteractionBrokerError('invalid_response');
  }
  return {
    interactionHandle: value.interactionHandle,
    decision: value.decision as ApprovalDecisionV2,
  };
}

function parseQuestionResponse(value: unknown): RendererQuestionResponse {
  if (!isRecordWithKeys(value, ['interactionHandle', 'answers'])) {
    throw new InteractionBrokerError('invalid_response');
  }
  if (!isHandle(value.interactionHandle) || !Array.isArray(value.answers)) {
    throw new InteractionBrokerError('invalid_response');
  }
  if (value.answers.length < 1 || value.answers.length > MAX_QUESTIONS) {
    throw new InteractionBrokerError('invalid_response');
  }

  const seenQuestions = new Set<string>();
  const answers = value.answers.map((entry) => {
    if (!isRecordWithKeys(entry, ['questionHandle', 'answer']) || !isHandle(entry.questionHandle)) {
      throw new InteractionBrokerError('invalid_response');
    }
    if (seenQuestions.has(entry.questionHandle))
      throw new InteractionBrokerError('invalid_response');
    seenQuestions.add(entry.questionHandle);
    return { questionHandle: entry.questionHandle, answer: parseQuestionAnswer(entry.answer) };
  });
  if (utf8ByteLength(JSON.stringify(answers)) > MAX_ANSWER_BYTES) {
    throw new InteractionBrokerError('invalid_response');
  }
  return { interactionHandle: value.interactionHandle, answers };
}

function parseQuestionAnswer(value: unknown): RendererQuestionAnswer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InteractionBrokerError('invalid_response');
  }
  const answer = value as Record<string, unknown>;
  if (answer.kind === 'text' && isRecordWithKeys(answer, ['kind', 'text'])) {
    if (typeof answer.text !== 'string' || utf8ByteLength(answer.text) > MAX_TEXT_ANSWER_BYTES) {
      throw new InteractionBrokerError('invalid_response');
    }
    return { kind: 'text', text: answer.text };
  }
  if (answer.kind === 'options' && isRecordWithKeys(answer, ['kind', 'optionHandles'])) {
    if (
      !Array.isArray(answer.optionHandles) ||
      answer.optionHandles.length < 1 ||
      answer.optionHandles.length > MAX_OPTIONS ||
      !answer.optionHandles.every(isHandle) ||
      new Set(answer.optionHandles).size !== answer.optionHandles.length
    ) {
      throw new InteractionBrokerError('invalid_response');
    }
    return { kind: 'options', optionHandles: [...answer.optionHandles] };
  }
  throw new InteractionBrokerError('invalid_response');
}

function parseCommand(value: unknown): AgentCommandV2 {
  const parsed = agentCommandV2Schema.safeParse(value);
  if (!parsed.success) throw new InteractionBrokerError('invalid_response');
  return parsed.data;
}

function isHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE_PATTERN.test(value);
}

function isRecordWithKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}
