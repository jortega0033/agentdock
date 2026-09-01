import { z } from 'zod';
import { providerIdSchema } from './schemas.js';

const opaqueId = z.string().uuid();
export const subagentNodeV2Schema = z
  .object({
    id: opaqueId,
    sessionId: opaqueId,
    parentId: opaqueId.optional(),
    nativeChildId: z.string().min(1).max(1_024).optional(),
    provider: providerIdSchema,
    role: z.string().max(256).optional(),
    name: z.string().min(1).max(256),
    status: z.enum(['spawning', 'running', 'blocked', 'completed', 'failed', 'cancelled']),
    model: z.string().max(256).optional(),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    toolSummary: z.string().max(1_024).optional(),
    permissionSummary: z.string().max(1_024).optional(),
    workspace: z
      .object({
        kind: z.enum(['shared', 'worktree', 'unknown']),
        displayName: z.string().max(256),
        worktreeId: opaqueId.optional(),
      })
      .strict(),
    controls: z
      .object({ steer: z.boolean(), interrupt: z.boolean(), cancel: z.boolean() })
      .strict(),
  })
  .strict();
export type SubagentNodeV2 = z.infer<typeof subagentNodeV2Schema>;
export const subagentGraphV2Schema = z
  .object({ sessionId: opaqueId, nodes: z.array(subagentNodeV2Schema).max(10_000) })
  .strict();
export type SubagentGraphV2 = z.infer<typeof subagentGraphV2Schema>;
export const subagentControlRequestV2Schema = z
  .object({
    sessionId: opaqueId,
    agentId: opaqueId,
    action: z.enum(['steer', 'interrupt', 'cancel']),
    message: z.string().min(1).max(200_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'steer' && !value.message)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'steer requires a message' });
  });
export type SubagentControlRequestV2 = z.infer<typeof subagentControlRequestV2Schema>;
export const subagentControlResultV2Schema = z
  .object({
    sessionId: opaqueId,
    agentId: opaqueId,
    status: z.enum(['accepted', 'unsupported', 'not_found']),
    safeSummary: z.string().max(1_024).optional(),
  })
  .strict();

export const worktreePreviewRequestV2Schema = z
  .object({
    cwd: z.string().min(1).max(32_768),
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/),
    ref: z
      .string()
      .min(1)
      .max(1_024)
      .refine(
        (value) =>
          !value.startsWith('-') &&
          [...value].every((character) => {
            const code = character.charCodeAt(0);
            return code >= 32 && code !== 127;
          }),
        'ref must not start with a dash or contain control characters',
      )
      .optional(),
  })
  .strict();
export type WorktreePreviewRequestV2 = z.infer<typeof worktreePreviewRequestV2Schema>;
export const worktreePreviewV2Schema = z
  .object({
    workspaceId: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/),
    name: z.string(),
    displayTarget: z.string().max(256),
    includeFiles: z.array(z.string().max(1_024)).max(10_000),
    ignoredFiles: z.array(z.string().max(1_024)).max(10_000),
    secretRisk: z.boolean(),
    requiresConfirmation: z.boolean(),
  })
  .strict();
export type WorktreePreviewV2 = z.infer<typeof worktreePreviewV2Schema>;
export const worktreeCreateRequestV2Schema = worktreePreviewRequestV2Schema
  .extend({ confirmIncludeCopy: z.literal(true) })
  .strict();
export type WorktreeCreateRequestV2 = z.infer<typeof worktreeCreateRequestV2Schema>;
export const ownedWorktreeV2Schema = z
  .object({
    id: opaqueId,
    workspaceId: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/),
    name: z.string().max(128),
    displayPath: z.string().max(256),
    status: z.enum(['ready', 'dirty', 'locked', 'orphaned', 'missing']),
    createdAt: z.string().datetime(),
    branch: z.string().max(1_024).optional(),
  })
  .strict();
export type OwnedWorktreeV2 = z.infer<typeof ownedWorktreeV2Schema>;
export const ownedWorktreeListV2Schema = z
  .object({ worktrees: z.array(ownedWorktreeV2Schema).max(2_000) })
  .strict();
export const worktreeCleanupRequestV2Schema = z.object({ worktreeId: opaqueId }).strict();
