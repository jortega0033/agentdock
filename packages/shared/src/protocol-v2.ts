import { z } from 'zod';
import { PROVIDER_IDS } from './provider.js';
import {
  boundedJsonSchema,
  capabilityRequestSchema,
  capabilitySelectionSchema,
  contentJsonSchema,
  effectSchema,
  utf8ByteLength,
  validateJsonBounds,
  type CapabilityRequest,
  type CapabilitySelection,
  type Effect,
} from './capabilities-v2.js';
import { approvalDecisionV2Schema, permissionActionV2Schema } from './policy-v2.js';

const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_ITEMS = 1_024;
const MAX_PAGE_SIZE = 100;

export const sessionIdSchema = z.string().uuid();
export const turnIdSchema = z.string().uuid();
export const commandIdSchema = z.string().uuid();
export const requestIdSchema = z.string().uuid();
export const contentBlockIdSchema = z.string().uuid();
export const toolCallIdSchema = z.string().uuid();
export const executionIdSchema = z.string().uuid();
export const subagentIdSchema = z.string().uuid();

export type SessionId = string;
export type TurnId = string;
export type CommandId = string;
export type RequestId = string;
export type ContentBlockId = string;
export type ToolCallId = string;
export type ExecutionId = string;
export type SubagentId = string;

const nonemptyWireStringSchema = z
  .string()
  .min(1)
  .refine((value) => utf8ByteLength(value) <= 256, {
    message: 'must be at most 256 UTF-8 bytes',
  });
const contentTextSchema = z.string().refine((value) => utf8ByteLength(value) <= MAX_CONTENT_BYTES, {
  message: `must be at most ${MAX_CONTENT_BYTES} UTF-8 bytes`,
});
const utf8ByteLimitedStringSchema = (maximum: number) =>
  z.string().refine((value) => utf8ByteLength(value) <= maximum, {
    message: `must be at most ${maximum} UTF-8 bytes`,
  });
const uniqueEffectsSchema = z
  .array(effectSchema)
  .max(6)
  .superRefine((effects, ctx) => {
    if (new Set(effects).size !== effects.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate effects are not allowed' });
  });

function addBoundsIssue(
  value: unknown,
  ctx: z.RefinementCtx,
  maxBytes: number,
  maxStringBytes: number,
): void {
  const issue = validateJsonBounds(value, {
    maxBytes,
    maxDepth: MAX_JSON_DEPTH,
    maxItems: MAX_JSON_ITEMS,
    maxStringBytes,
  });
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
}

export const textContentBlockSchema = z
  .object({
    type: z.literal('text'),
    id: contentBlockIdSchema,
    text: contentTextSchema,
  })
  .strict();

export const imageContentBlockSchema = z
  .object({
    type: z.literal('image'),
    id: contentBlockIdSchema,
    attachmentId: z.string().uuid(),
    name: nonemptyWireStringSchema,
    mimeType: nonemptyWireStringSchema,
    byteLength: z.number().int().finite().nonnegative().max(MAX_ATTACHMENT_BYTES),
    alt: z.string().max(512).optional(),
  })
  .strict();

export const fileContentBlockSchema = z
  .object({
    type: z.literal('file'),
    id: contentBlockIdSchema,
    attachmentId: z.string().uuid(),
    name: nonemptyWireStringSchema,
    mimeType: nonemptyWireStringSchema,
    byteLength: z.number().int().finite().nonnegative().max(MAX_ATTACHMENT_BYTES),
  })
  .strict();

export const structuredDataContentBlockSchema = z
  .object({
    type: z.literal('structured_data'),
    id: contentBlockIdSchema,
    data: contentJsonSchema,
  })
  .strict();

export const toolActivityContentBlockSchema = z
  .object({
    type: z.literal('tool_activity'),
    id: contentBlockIdSchema,
    toolCallId: toolCallIdSchema,
    toolName: nonemptyWireStringSchema,
    status: z.enum(['started', 'completed', 'failed']),
    possibleEffects: uniqueEffectsSchema,
    effectsComplete: z.boolean(),
    inputSummary: z.string().max(4_096).optional(),
    resultSummary: z.string().max(4_096).optional(),
  })
  .strict();

export const planStepV2Schema = z
  .object({
    id: z.string().uuid(),
    text: contentTextSchema,
    status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
  })
  .strict();

export const planContentBlockSchema = z
  .object({
    type: z.literal('plan'),
    id: contentBlockIdSchema,
    title: z.string().max(512).optional(),
    steps: z.array(planStepV2Schema).max(100),
  })
  .strict();

const extensionSummaryReasonSchema = z.enum([
  'display_disallowed',
  'persistence_disallowed',
  'redacted',
  'truncated',
  'unsupported',
  'capability_drift',
]);

const providerExtensionBlockBase = {
  type: z.literal('provider_extension'),
  id: contentBlockIdSchema,
  extensionName: nonemptyWireStringSchema,
  extensionVersion: nonemptyWireStringSchema.optional(),
  safeSummary: z.string().max(512),
};

export const providerExtensionDataContentBlockSchema = z
  .object({
    ...providerExtensionBlockBase,
    representation: z.literal('bounded_data'),
    data: boundedJsonSchema,
    safeToPersist: z.boolean(),
  })
  .strict();

export const providerExtensionSummaryContentBlockSchema = z
  .object({
    ...providerExtensionBlockBase,
    representation: z.literal('safe_summary'),
    reason: extensionSummaryReasonSchema,
    originalBytes: z.number().int().finite().nonnegative().optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export const providerExtensionContentBlockSchema = z.union([
  providerExtensionDataContentBlockSchema,
  providerExtensionSummaryContentBlockSchema,
]);

const contentBlockUnionSchema = z.union([
  textContentBlockSchema,
  imageContentBlockSchema,
  fileContentBlockSchema,
  structuredDataContentBlockSchema,
  toolActivityContentBlockSchema,
  planContentBlockSchema,
  providerExtensionContentBlockSchema,
]);

export const contentBlockV2Schema = contentBlockUnionSchema.superRefine((block, ctx) => {
  addBoundsIssue(block, ctx, MAX_CONTENT_BYTES, MAX_CONTENT_BYTES);
});

export const inputContentBlockV2Schema = z.union([
  textContentBlockSchema,
  imageContentBlockSchema,
  fileContentBlockSchema,
  structuredDataContentBlockSchema,
]);

export type TextContentBlock = z.infer<typeof textContentBlockSchema>;
export type ImageContentBlock = z.infer<typeof imageContentBlockSchema>;
export type FileContentBlock = z.infer<typeof fileContentBlockSchema>;
export type StructuredDataContentBlock = z.infer<typeof structuredDataContentBlockSchema>;
export type ToolActivityContentBlock = z.infer<typeof toolActivityContentBlockSchema>;
export type PlanStepV2 = z.infer<typeof planStepV2Schema>;
export type PlanContentBlock = z.infer<typeof planContentBlockSchema>;
export type ProviderExtensionContentBlock = z.infer<typeof providerExtensionContentBlockSchema>;
export type ContentBlockV2 = z.infer<typeof contentBlockV2Schema>;
export type InputContentBlockV2 = z.infer<typeof inputContentBlockV2Schema>;

const commandBase = {
  commandId: commandIdSchema,
  sessionId: sessionIdSchema,
};

export const inputCommandV2Schema = z.union([
  z
    .object({
      ...commandBase,
      type: z.literal('input.follow_up'),
      turnId: turnIdSchema,
      content: z.array(inputContentBlockV2Schema).min(1),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal('input.steer'),
      turnId: turnIdSchema,
      content: z.array(inputContentBlockV2Schema).min(1),
    })
    .strict(),
]);

export const interruptCommandV2Schema = z
  .object({
    ...commandBase,
    type: z.literal('session.interrupt'),
    turnId: turnIdSchema,
  })
  .strict();

export const approvalResponseCommandV2Schema = z
  .object({
    ...commandBase,
    type: z.literal('approval.respond'),
    turnId: turnIdSchema,
    requestId: requestIdSchema,
    decision: approvalDecisionV2Schema,
  })
  .strict();

export const questionAnswerV2Schema = z
  .object({
    questionId: z.string().uuid(),
    value: z.union([
      utf8ByteLimitedStringSchema(16 * 1024),
      z.array(utf8ByteLimitedStringSchema(2 * 1024)).max(10),
    ]),
  })
  .strict();

export const questionResponseCommandV2Schema = z
  .object({
    ...commandBase,
    type: z.literal('question.respond'),
    turnId: turnIdSchema,
    requestId: requestIdSchema,
    answers: z.array(questionAnswerV2Schema).max(3),
  })
  .strict()
  .superRefine((command, ctx) => addBoundsIssue(command, ctx, 32 * 1024, 16 * 1024));

const agentCommandUnionSchema = z.union([
  inputCommandV2Schema,
  interruptCommandV2Schema,
  approvalResponseCommandV2Schema,
  questionResponseCommandV2Schema,
]);

export const agentCommandV2Schema = agentCommandUnionSchema.superRefine((command, ctx) => {
  addBoundsIssue(command, ctx, MAX_COMMAND_BYTES, MAX_CONTENT_BYTES);
});

export type InputCommandV2 = z.infer<typeof inputCommandV2Schema>;
export type InterruptCommandV2 = z.infer<typeof interruptCommandV2Schema>;
export type ApprovalResponseCommandV2 = z.infer<typeof approvalResponseCommandV2Schema>;
export type QuestionAnswerV2 = z.infer<typeof questionAnswerV2Schema>;
export type QuestionResponseCommandV2 = z.infer<typeof questionResponseCommandV2Schema>;
export type AgentCommandV2 = z.infer<typeof agentCommandV2Schema>;

export const providerSessionIdV2Schema = z
  .string()
  .min(1)
  .refine((value) => utf8ByteLength(value) <= 1_024, {
    message: 'provider session id must be at most 1024 UTF-8 bytes',
  })
  .refine(
    (value) =>
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }),
    {
      message: 'provider session id must not contain control characters',
    },
  );

export const sessionContinuationV2Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('resume'),
      providerSessionId: providerSessionIdV2Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('fork'),
      providerSessionId: providerSessionIdV2Schema,
    })
    .strict(),
]);

export type SessionContinuationV2 = z.infer<typeof sessionContinuationV2Schema>;

/**
 * User-controlled input for a daemon-owned continuation. The parent session route parameter,
 * rather than this body, selects the persisted provider-native session/thread identifier.
 */
export const sessionContinuationInputV2Schema = z
  .object({
    prompt: z.string().min(1, 'prompt is required').max(200_000, 'prompt is too long'),
    capabilities: capabilityRequestSchema.optional(),
    allowDirtyWorkspaceShare: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    addBoundsIssue(input, ctx, MAX_COMMAND_BYTES, MAX_COMMAND_BYTES);
  });

export type SessionContinuationInputV2 = z.infer<typeof sessionContinuationInputV2Schema>;

export interface CreateSessionV2Request {
  provider: (typeof PROVIDER_IDS)[number];
  cwd: string;
  prompt: string;
  capabilities?: CapabilityRequest;
  /** Explicit consent to add a read-only session to an already-shared dirty Git worktree. */
  allowDirtyWorkspaceShare?: boolean;
  /**
   * @deprecated Use the daemon-owned `POST /v2/sessions/:sessionId/resume` or `/fork` routes.
   * Kept parse-compatible until consumers have migrated; new callers must not supply native IDs.
   */
  continuation?: SessionContinuationV2;
}

export const createSessionV2RequestSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS),
    cwd: z.string().min(1, 'cwd is required'),
    prompt: z.string().min(1, 'prompt is required').max(200_000, 'prompt is too long'),
    capabilities: capabilityRequestSchema.optional(),
    allowDirtyWorkspaceShare: z.boolean().optional(),
    continuation: sessionContinuationV2Schema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    addBoundsIssue(request, ctx, MAX_COMMAND_BYTES, MAX_COMMAND_BYTES);
  });

/** Opaque pagination cursor issued by the daemon; callers must not derive or inspect it. */
export const opaqueCursorV2Schema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
export const pageLimitV2Schema = z.number().int().min(1).max(MAX_PAGE_SIZE);

export const sessionListV2QuerySchema = z
  .object({
    cursor: opaqueCursorV2Schema.optional(),
    limit: pageLimitV2Schema.optional(),
  })
  .strict();

export type SessionListV2Query = z.infer<typeof sessionListV2QuerySchema>;

export const sessionEventHistoryV2QuerySchema = z
  .object({
    cursor: opaqueCursorV2Schema.optional(),
    limit: pageLimitV2Schema.optional(),
  })
  .strict();

export type SessionEventHistoryV2Query = z.infer<typeof sessionEventHistoryV2QuerySchema>;

export const sessionStatusV2Schema = z.enum([
  'starting',
  'active',
  'idle',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

const providerRuntimeVersionV2Schema = nonemptyWireStringSchema.refine(
  (value) => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value),
  { message: 'runtime version metadata must contain only safe version characters' },
);
const providerFallbackReasonV2Schema = nonemptyWireStringSchema.refine(
  (value) => /^[a-z0-9][a-z0-9._-]*$/.test(value),
  { message: 'fallback reason must be a safe reason code' },
);

export const providerRuntimeMetadataV2Schema = z
  .object({
    cliVersion: providerRuntimeVersionV2Schema.optional(),
    schemaVersion: providerRuntimeVersionV2Schema.optional(),
    fixtureSet: providerRuntimeVersionV2Schema.optional(),
    requestedTransportMode: z.enum(['auto', 'app-server', 'exec', 'sdk', 'cli']).optional(),
    fallbackReason: providerFallbackReasonV2Schema.optional(),
  })
  .strict();

export type ProviderRuntimeMetadataV2 = z.infer<typeof providerRuntimeMetadataV2Schema>;

export interface AgentSessionV2 {
  id: SessionId;
  provider: (typeof PROVIDER_IDS)[number];
  transport: string;
  cwd: string;
  /** Launch-time Git branch label, or `detached` when HEAD was detached. */
  branch?: string;
  status: z.infer<typeof sessionStatusV2Schema>;
  selection: CapabilitySelection;
  executionId: ExecutionId;
  rootExecutionId?: ExecutionId;
  parentSessionId?: SessionId;
  parentExecutionId?: ExecutionId;
  continuationKind?: 'fresh' | 'resume' | 'fork';
  currentTurnId?: TurnId;
  acceptedWork: 'not_accepted' | 'accepted' | 'unknown';
  startedAt: string;
  completedAt?: string;
  terminalReason?: string;
  error?: string;
  /** Opaque provider-native thread/session id; bounded and never used as a process id. */
  providerSessionId?: string;
  /** Bounded, non-secret provider transport facts. Native payloads and credentials are forbidden. */
  runtimeMetadata?: ProviderRuntimeMetadataV2;
  earliestSequence: number;
}

export const agentSessionV2Schema = z
  .object({
    id: sessionIdSchema,
    provider: z.enum(PROVIDER_IDS),
    transport: nonemptyWireStringSchema,
    cwd: z.string().min(1),
    branch: z.string().min(1).max(1024).optional(),
    status: sessionStatusV2Schema,
    selection: capabilitySelectionSchema,
    executionId: executionIdSchema,
    rootExecutionId: executionIdSchema.optional(),
    parentSessionId: sessionIdSchema.optional(),
    parentExecutionId: executionIdSchema.optional(),
    continuationKind: z.enum(['fresh', 'resume', 'fork']).optional(),
    currentTurnId: turnIdSchema.optional(),
    acceptedWork: z.enum(['not_accepted', 'accepted', 'unknown']),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).optional(),
    terminalReason: nonemptyWireStringSchema.optional(),
    error: z.string().optional(),
    providerSessionId: providerSessionIdV2Schema.optional(),
    runtimeMetadata: providerRuntimeMetadataV2Schema.optional(),
    earliestSequence: z.number().int().finite().nonnegative(),
  })
  .strict();

export const sessionListV2PageSchema = z
  .object({
    sessions: z.array(agentSessionV2Schema).max(MAX_PAGE_SIZE),
    nextCursor: opaqueCursorV2Schema.optional(),
  })
  .strict();

export type SessionListV2Page = z.infer<typeof sessionListV2PageSchema>;

export interface CancelSessionV2Response {
  status: 'cancelling';
  sessionId: SessionId;
}

export const cancelSessionV2ResponseSchema = z
  .object({
    status: z.literal('cancelling'),
    sessionId: sessionIdSchema,
  })
  .strict();

export interface CommandAcknowledgementV2 {
  status: 'accepted';
  commandId: CommandId;
  sessionId: SessionId;
  turnId: TurnId;
}

export const commandAcknowledgementV2Schema = z
  .object({
    status: z.literal('accepted'),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    turnId: turnIdSchema,
  })
  .strict();

export interface StreamErrorV2 {
  type: 'stream.error';
  code: 'stream_overflow';
  lastSequence?: number;
}

export const streamErrorV2Schema = z
  .object({
    type: z.literal('stream.error'),
    code: z.literal('stream_overflow'),
    lastSequence: z.number().int().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

export const questionOptionV2Schema = z
  .object({
    id: z.string().uuid(),
    label: z.string().max(512),
    description: utf8ByteLimitedStringSchema(2 * 1024).optional(),
  })
  .strict();

export const questionV2Schema = z
  .object({
    id: z.string().uuid(),
    title: z.string().max(512),
    prompt: utf8ByteLimitedStringSchema(4 * 1024),
    options: z.array(questionOptionV2Schema).max(10).optional(),
    allowsFreeText: z.boolean(),
    preview: utf8ByteLimitedStringSchema(8 * 1024).optional(),
  })
  .strict();

const eventMetaShape = {
  sessionId: sessionIdSchema,
  executionId: executionIdSchema,
  parentExecutionId: executionIdSchema.optional(),
  sequence: z.number().int().finite().nonnegative(),
  timestamp: z.string().datetime({ offset: true }),
};
const turnEventShape = { ...eventMetaShape, turnId: turnIdSchema };

const sessionStartedEventSchema = z
  .object({
    ...eventMetaShape,
    type: z.literal('session.started'),
    provider: z.enum(PROVIDER_IDS),
    transport: nonemptyWireStringSchema,
    selection: capabilitySelectionSchema,
  })
  .strict();
const sessionStatusEventSchema = z
  .object({
    ...eventMetaShape,
    type: z.literal('session.status'),
    status: z.enum(['starting', 'active', 'idle']),
  })
  .strict();
const sessionCompletedEventSchema = z
  .object({ ...eventMetaShape, type: z.literal('session.completed') })
  .strict();
const sessionFailedEventSchema = z
  .object({
    ...eventMetaShape,
    type: z.literal('session.failed'),
    code: nonemptyWireStringSchema.optional(),
    message: contentTextSchema,
  })
  .strict();
const sessionCancelledEventSchema = z
  .object({
    ...eventMetaShape,
    type: z.literal('session.cancelled'),
    reason: z.string().max(4_096).optional(),
  })
  .strict();
const sessionInterruptedEventSchema = z
  .object({
    ...eventMetaShape,
    type: z.literal('session.interrupted'),
    reason: z.string().max(4_096).optional(),
  })
  .strict();
const turnStartedEventSchema = z
  .object({ ...turnEventShape, type: z.literal('turn.started') })
  .strict();
const turnCompletedEventSchema = z
  .object({ ...turnEventShape, type: z.literal('turn.completed') })
  .strict();
const turnFailedEventSchema = z
  .object({
    ...turnEventShape,
    type: z.literal('turn.failed'),
    code: nonemptyWireStringSchema.optional(),
    message: contentTextSchema,
  })
  .strict();
const turnInterruptedEventSchema = z
  .object({
    ...turnEventShape,
    type: z.literal('turn.interrupted'),
    reason: z.string().max(4_096).optional(),
  })
  .strict();
const contentDeltaEventSchema = z
  .object({
    ...turnEventShape,
    type: z.literal('content.delta'),
    contentBlockId: contentBlockIdSchema,
    delta: contentTextSchema,
  })
  .strict();
const contentCompletedEventSchema = z
  .object({
    ...turnEventShape,
    type: z.literal('content.completed'),
    block: contentBlockV2Schema,
  })
  .strict();
const toolStartedEventSchema = z
  .object({
    ...turnEventShape,
    type: z.literal('tool.started'),
    toolCallId: toolCallIdSchema,
    contentBlockId: contentBlockIdSchema,
    toolName: nonemptyWireStringSchema,
    possibleEffects: uniqueEffectsSchema,
    effectsComplete: z.boolean(),
  })
  .strict();
const toolCompletedEventSchema = z
  .object({
    ...turnEventShape,
    type: z.literal('tool.completed'),
    toolCallId: toolCallIdSchema,
    contentBlockId: contentBlockIdSchema,
    toolName: nonemptyWireStringSchema,
    status: z.enum(['completed', 'failed']),
    summary: z.string().max(4_096).optional(),
  })
  .strict();
// Bounded, provider-neutral child-agent lifecycle event (issue #58). One event type carries every
// phase -- spawn, progress update, blocked, and terminal -- distinguished by `status`, mirroring
// SubagentNodeV2's own status enum rather than inventing four separate wire event types for what
// is really one node's state transitions. `agentId` is a stable AgentDock id the emitting adapter
// generates once per native child identity and reuses for every subsequent event about that same
// child, the same idiom already used for `toolCallId` on tool.started/tool.completed.
const subagentStatusEventSchema = z
  .object({
    ...turnEventShape,
    type: z.literal('subagent.status'),
    agentId: subagentIdSchema,
    parentAgentId: subagentIdSchema.optional(),
    nativeChildId: z.string().min(1).max(1_024).optional(),
    name: z.string().min(1).max(256),
    role: z.string().max(256).optional(),
    model: z.string().max(256).optional(),
    status: z.enum(['spawning', 'running', 'blocked', 'completed', 'failed', 'cancelled']),
    toolSummary: z.string().max(1_024).optional(),
    permissionSummary: z.string().max(1_024).optional(),
    controls: z.object({ steer: z.boolean(), interrupt: z.boolean(), cancel: z.boolean() }).strict(),
  })
  .strict();
const approvalRequestedEventSchema = z
  .object({
    ...turnEventShape,
    type: z.literal('approval.requested'),
    requestId: requestIdSchema,
    toolCallId: toolCallIdSchema.optional(),
    title: z.string().max(512),
    action: utf8ByteLimitedStringSchema(4 * 1024),
    target: utf8ByteLimitedStringSchema(4 * 1024),
    reason: utf8ByteLimitedStringSchema(4 * 1024).optional(),
    possibleEffects: uniqueEffectsSchema,
    effectsComplete: z.boolean(),
    permission: permissionActionV2Schema.optional(),
    allowedDecisions: z.array(approvalDecisionV2Schema).min(1).max(3).optional(),
    deadlineAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((event, ctx) => addBoundsIssue(event, ctx, 32 * 1024, 4_096));
const approvalResolvedEventSchema = z
  .object({
    ...turnEventShape,
    type: z.literal('approval.resolved'),
    requestId: requestIdSchema,
    decision: z.enum(['allowed', 'denied']),
    actor: z.enum(['user', 'policy', 'timeout', 'disconnect', 'shutdown']),
  })
  .strict();
const questionRequestedEventSchema = z
  .object({
    ...turnEventShape,
    type: z.literal('question.requested'),
    requestId: requestIdSchema,
    questions: z.array(questionV2Schema).min(1).max(3),
    deadlineAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((event, ctx) => addBoundsIssue(event, ctx, 32 * 1024, 16 * 1024));
const questionResolvedEventSchema = z
  .object({
    ...turnEventShape,
    type: z.literal('question.resolved'),
    requestId: requestIdSchema,
    answers: z.array(questionAnswerV2Schema).max(3),
  })
  .strict()
  .superRefine((event, ctx) => addBoundsIssue(event, ctx, 32 * 1024, 16 * 1024));
const questionCancelledEventSchema = z
  .object({
    ...turnEventShape,
    type: z.literal('question.cancelled'),
    requestId: requestIdSchema,
    reason: z.enum([
      'timeout',
      'disconnect',
      'overflow',
      'interrupt',
      'cancel',
      'shutdown',
      'trust_revoked',
      'provider_cancelled',
    ]),
  })
  .strict();
const usageTokensEventSchema = z
  .object({
    ...eventMetaShape,
    type: z.literal('usage.tokens'),
    turnId: turnIdSchema.optional(),
    scope: z.enum(['turn', 'session']),
    inputTokens: z.number().int().finite().nonnegative().optional(),
    outputTokens: z.number().int().finite().nonnegative().optional(),
    cachedInputTokens: z.number().int().finite().nonnegative().optional(),
  })
  .strict();
const usageCostEventSchema = z
  .object({
    ...eventMetaShape,
    type: z.literal('usage.cost'),
    turnId: turnIdSchema.optional(),
    scope: z.enum(['turn', 'session']),
    cost: z.number().finite().nonnegative(),
    currency: nonemptyWireStringSchema,
    estimated: z.boolean(),
  })
  .strict();
const errorEventSchema = z
  .object({
    ...eventMetaShape,
    type: z.literal('error'),
    turnId: turnIdSchema.optional(),
    code: nonemptyWireStringSchema.optional(),
    message: contentTextSchema,
    recoverable: z.boolean(),
  })
  .strict();
const extensionSummaryEventSchema = z
  .object({
    ...eventMetaShape,
    type: z.literal('extension.summary'),
    turnId: turnIdSchema.optional(),
    extensionName: nonemptyWireStringSchema,
    extensionVersion: nonemptyWireStringSchema.optional(),
    summary: z.string().max(512),
    reason: extensionSummaryReasonSchema,
  })
  .strict();

const agentEventV2EnvelopeUnionSchema = z.union([
  sessionStartedEventSchema,
  sessionStatusEventSchema,
  sessionCompletedEventSchema,
  sessionFailedEventSchema,
  sessionCancelledEventSchema,
  sessionInterruptedEventSchema,
  turnStartedEventSchema,
  turnCompletedEventSchema,
  turnFailedEventSchema,
  turnInterruptedEventSchema,
  contentDeltaEventSchema,
  contentCompletedEventSchema,
  toolStartedEventSchema,
  toolCompletedEventSchema,
  subagentStatusEventSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  questionRequestedEventSchema,
  questionResolvedEventSchema,
  questionCancelledEventSchema,
  usageTokensEventSchema,
  usageCostEventSchema,
  errorEventSchema,
  extensionSummaryEventSchema,
]);

export const agentEventV2EnvelopeSchema = agentEventV2EnvelopeUnionSchema.superRefine(
  (event, ctx) => {
    addBoundsIssue(event, ctx, MAX_COMMAND_BYTES, MAX_CONTENT_BYTES);
  },
);

export const sessionEventHistoryV2PageSchema = z
  .object({
    events: z.array(agentEventV2EnvelopeSchema).max(MAX_PAGE_SIZE),
    nextCursor: opaqueCursorV2Schema.optional(),
  })
  .strict();

/** Wire items accepted on a v2 SSE stream. Stream errors are connection-local control frames. */
export const agentEventOrStreamErrorV2Schema = z.union([
  agentEventV2EnvelopeSchema,
  streamErrorV2Schema,
]);

export interface AgentEventV2Meta {
  sessionId: SessionId;
  executionId: ExecutionId;
  parentExecutionId?: ExecutionId;
  sequence: number;
  timestamp: string;
}

export type AgentEventV2Envelope = z.infer<typeof agentEventV2EnvelopeSchema>;
export type AgentEventOrStreamErrorV2 = z.infer<typeof agentEventOrStreamErrorV2Schema>;
export type SessionEventHistoryV2Page = z.infer<typeof sessionEventHistoryV2PageSchema>;
type WithoutEventMeta<T> = T extends AgentEventV2Meta ? Omit<T, keyof AgentEventV2Meta> : never;
export type AgentEventV2 = WithoutEventMeta<AgentEventV2Envelope>;

export const AGENT_EVENT_V2_TYPES = [
  'session.started',
  'session.status',
  'session.completed',
  'session.failed',
  'session.cancelled',
  'session.interrupted',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'content.delta',
  'content.completed',
  'tool.started',
  'tool.completed',
  'subagent.status',
  'approval.requested',
  'approval.resolved',
  'question.requested',
  'question.resolved',
  'question.cancelled',
  'usage.tokens',
  'usage.cost',
  'error',
  'extension.summary',
] as const;

export type AgentEventV2Type = (typeof AGENT_EVENT_V2_TYPES)[number];
export type QuestionOptionV2 = z.infer<typeof questionOptionV2Schema>;
export type QuestionV2 = z.infer<typeof questionV2Schema>;
export type ApprovalRisk = Effect | 'unknown';
