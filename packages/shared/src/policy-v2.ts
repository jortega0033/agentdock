import { z } from 'zod';
import { PROVIDER_IDS } from './provider.js';
import { utf8ByteLength } from './capabilities-v2.js';

const MAX_PATH_BYTES = 32 * 1024;
const MAX_SAFE_SUMMARY_BYTES = 512;
const MAX_EVIDENCE_REFERENCE_BYTES = 512;
const MAX_AUDIT_PAGE_ENTRIES = 100;

const boundedUtf8String = (maximum: number, minimum = 0) =>
  z
    .string()
    .min(minimum)
    .refine((value) => utf8ByteLength(value) <= maximum, {
      message: `must be at most ${maximum} UTF-8 bytes`,
    });

const canonicalOperationSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:/-]*$/, 'must be a normalized operation');
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 digest');
const timestampSchema = z.string().datetime({ offset: true });

export const ACTION_CLASSES = [
  'filesystem',
  'command',
  'network',
  'mcp',
  'external_side_effect',
  'other',
] as const;

export const approvalDecisionV2Schema = z.enum(['allow_once', 'allow_session', 'deny']);
export const permissionRiskV2Schema = z.enum(['normal', 'destructive', 'unknown']);

export const permissionActionV2Schema = z
  .object({
    actionClass: z.enum(ACTION_CLASSES),
    operation: canonicalOperationSchema,
    targetFingerprint: sha256Schema,
    safeTargetSummary: boundedUtf8String(MAX_SAFE_SUMMARY_BYTES),
    risk: permissionRiskV2Schema,
    effectsComplete: z.boolean(),
    mcpDestructive: z.boolean(),
  })
  .strict()
  .superRefine((action, ctx) => {
    if (action.actionClass !== 'mcp' && action.mcpDestructive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mcpDestructive'],
        message: 'mcpDestructive is valid only for MCP actions',
      });
    }
    if (action.mcpDestructive && action.risk !== 'destructive') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['risk'],
        message: 'destructive MCP actions must use destructive risk',
      });
    }
    if (action.actionClass === 'other' && action.risk !== 'unknown') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['risk'],
        message: 'other actions must fail closed as unknown risk',
      });
    }
  });

export type ActionClass = (typeof ACTION_CLASSES)[number];
export type ApprovalDecisionV2 = z.infer<typeof approvalDecisionV2Schema>;
export type PermissionRiskV2 = z.infer<typeof permissionRiskV2Schema>;
export type PermissionActionV2 = z.infer<typeof permissionActionV2Schema>;

export const DEFAULT_PERMISSION_POLICY = 'ask' as const;

function permissionKeyFromNormalized(action: PermissionActionV2): string {
  return `agent-dock.permission.v1:${JSON.stringify([
    action.actionClass,
    action.operation,
    action.targetFingerprint,
    action.risk,
    action.effectsComplete,
    action.mcpDestructive,
  ])}`;
}

function sessionGrantAllowedForNormalized(action: PermissionActionV2): boolean {
  return (
    action.effectsComplete &&
    action.risk === 'normal' &&
    action.actionClass !== 'external_side_effect' &&
    action.actionClass !== 'other' &&
    !action.mcpDestructive
  );
}

export function permissionKey(action: PermissionActionV2): string {
  return permissionKeyFromNormalized(permissionActionV2Schema.parse(action));
}

export function isSessionGrantAllowed(action: PermissionActionV2): boolean {
  return sessionGrantAllowedForNormalized(permissionActionV2Schema.parse(action));
}

export function isApprovalDecisionAllowed(
  action: PermissionActionV2,
  decision: ApprovalDecisionV2,
): boolean {
  return decision !== 'allow_session' || isSessionGrantAllowed(action);
}

export const filesystemObjectIdentityV2Schema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('unix'),
      device: z.string().regex(/^[0-9]{1,32}$/),
      inode: z.string().regex(/^[0-9]{1,32}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('windows'),
      volumeSerial: z.string().regex(/^[a-f0-9]{1,32}$/),
      fileId: z.string().regex(/^[a-f0-9]{1,64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ephemeral'),
      nonce: z.string().uuid(),
    })
    .strict(),
]);

const canonicalPathSchema = boundedUtf8String(MAX_PATH_BYTES, 1);

const directoryWorkspaceIdentityV2Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('directory'),
    canonicalWorkingDirectory: canonicalPathSchema,
    workingDirectoryObject: filesystemObjectIdentityV2Schema,
  })
  .strict();

const gitWorkspaceIdentityV2Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('git'),
    canonicalGitCommonDirectory: canonicalPathSchema,
    gitCommonDirectoryObject: filesystemObjectIdentityV2Schema,
    canonicalWorktreeRoot: canonicalPathSchema,
    worktreeRootObject: filesystemObjectIdentityV2Schema,
  })
  .strict();

export const workspaceIdentityV2Schema = z
  .discriminatedUnion('kind', [directoryWorkspaceIdentityV2Schema, gitWorkspaceIdentityV2Schema])
  .superRefine((identity, ctx) => {
    if (identity.kind !== 'git') return;
    const commonKind = identity.gitCommonDirectoryObject.kind;
    const worktreeKind = identity.worktreeRootObject.kind;
    if (commonKind !== 'ephemeral' && worktreeKind !== 'ephemeral' && commonKind !== worktreeKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['worktreeRootObject', 'kind'],
        message: 'Git object identities must use the same platform identity kind',
      });
    }
  });

export const workspaceTrustRecordV2Schema = z
  .object({
    schemaVersion: z.literal(1),
    identity: workspaceIdentityV2Schema,
    state: z.enum(['untrusted', 'trusted']),
    source: z.enum(['default', 'user', 'managed_policy', 'revocation', 'identity_mismatch']),
    scope: z.enum(['session', 'persistent']),
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    const identities =
      record.identity.kind === 'git'
        ? [record.identity.gitCommonDirectoryObject, record.identity.worktreeRootObject]
        : [record.identity.workingDirectoryObject];
    if (
      record.scope === 'persistent' &&
      identities.some((identity) => identity.kind === 'ephemeral')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scope'],
        message: 'persistent trust requires stable filesystem object identities',
      });
    }
    if (
      record.state === 'trusted' &&
      ['default', 'revocation', 'identity_mismatch'].includes(record.source)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source'],
        message: 'trusted records require an explicit user or managed-policy source',
      });
    }
  });

export type FilesystemObjectIdentityV2 = z.infer<typeof filesystemObjectIdentityV2Schema>;
export type WorkspaceIdentityV2 = z.infer<typeof workspaceIdentityV2Schema>;
export type WorkspaceTrustRecordV2 = z.infer<typeof workspaceTrustRecordV2Schema>;

export const sandboxStateV2Schema = z.enum([
  'enforced',
  'provider_managed',
  'not_requested',
  'unavailable',
  'failed',
  'unknown',
]);

const sandboxEvidenceV2Schema = z
  .object({
    kind: z.enum(['fixture', 'host_probe', 'runtime_report']),
    reference: boundedUtf8String(MAX_EVIDENCE_REFERENCE_BYTES, 1),
    verifiedAt: timestampSchema,
  })
  .strict();

const sandboxLayer = (mechanism: 'provider_policy' | 'agentdock_policy' | 'os_sandbox') =>
  z
    .object({
      mechanism: z.literal(mechanism),
      state: sandboxStateV2Schema,
      evidence: z.array(sandboxEvidenceV2Schema).max(8),
    })
    .strict()
    .superRefine((layer, ctx) => {
      if (layer.state === 'enforced' && layer.evidence.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['evidence'],
          message: 'enforced sandbox state requires evidence',
        });
      }
      if (mechanism !== 'provider_policy' && layer.state === 'provider_managed') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['state'],
          message: 'provider_managed applies only to provider policy',
        });
      }
    });

export const sandboxStatusV2Schema = z
  .object({
    providerId: z.enum(PROVIDER_IDS),
    platform: z.enum(['win32', 'darwin', 'linux', 'linux_wsl2']),
    provider: sandboxLayer('provider_policy'),
    agentDock: sandboxLayer('agentdock_policy'),
    os: sandboxLayer('os_sandbox'),
    badge: z.enum(['none', 'restricted_by_policy', 'os_sandboxed', 'bash_sandboxed']),
  })
  .strict()
  .superRefine((status, ctx) => {
    if (
      (status.badge === 'os_sandboxed' || status.badge === 'bash_sandboxed') &&
      status.os.state !== 'enforced'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['badge'],
        message: 'sandboxed badges require enforced OS isolation',
      });
    }
    if (
      status.badge === 'restricted_by_policy' &&
      status.provider.state !== 'enforced' &&
      status.agentDock.state !== 'enforced'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['badge'],
        message: 'policy badge requires an enforced provider or AgentDock policy',
      });
    }
    if (
      status.badge === 'bash_sandboxed' &&
      (status.providerId !== 'claude' || status.platform === 'win32')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['badge'],
        message: 'Bash sandbox badge is valid only for non-Windows Claude sessions',
      });
    }
  });

export type SandboxStateV2 = z.infer<typeof sandboxStateV2Schema>;
export type SandboxStatusV2 = z.infer<typeof sandboxStatusV2Schema>;

export const auditActorV2Schema = z.enum([
  'user',
  'policy',
  'timeout',
  'disconnect',
  'interrupt',
  'cancel',
  'shutdown',
  'audit_failure',
]);

const permissionKeyV2Schema = boundedUtf8String(512, 1).refine(
  (value) => value.startsWith('agent-dock.permission.v1:'),
  'must be a versioned AgentDock permission key',
);

export const auditEntryV2Schema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    entryId: z.string().uuid(),
    recordedAt: timestampSchema,
    sessionId: z.string().uuid(),
    turnId: z.string().uuid(),
    requestId: z.string().uuid(),
    providerId: z.enum(PROVIDER_IDS),
    transport: boundedUtf8String(128, 1),
    workspaceFingerprint: sha256Schema,
    action: permissionActionV2Schema,
    permissionKey: permissionKeyV2Schema,
    decision: approvalDecisionV2Schema,
    actor: auditActorV2Schema,
  })
  .strict()
  .superRefine((entry, ctx) => {
    const parsedAction = permissionActionV2Schema.safeParse(entry.action);
    if (
      parsedAction.success &&
      entry.permissionKey !== permissionKeyFromNormalized(parsedAction.data)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissionKey'],
        message: 'permission key does not match normalized action',
      });
    }
    if (
      parsedAction.success &&
      entry.decision === 'allow_session' &&
      !sessionGrantAllowedForNormalized(parsedAction.data)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision'],
        message: 'this action cannot receive a session grant',
      });
    }
    if (
      entry.decision !== 'deny' &&
      ['timeout', 'disconnect', 'interrupt', 'cancel', 'shutdown', 'audit_failure'].includes(
        entry.actor,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision'],
        message: 'failure-path actors must deny',
      });
    }
  });

export const auditReadResponseV2Schema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(auditEntryV2Schema).max(MAX_AUDIT_PAGE_ENTRIES),
    nextCursor: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();

export type AuditActorV2 = z.infer<typeof auditActorV2Schema>;
export type AuditEntryV2 = z.infer<typeof auditEntryV2Schema>;
export type AuditReadResponseV2 = z.infer<typeof auditReadResponseV2Schema>;
