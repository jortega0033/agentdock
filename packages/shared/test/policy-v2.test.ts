import { describe, expect, it } from 'vitest';
import {
  ACTION_CLASSES,
  DEFAULT_PERMISSION_POLICY,
  approvalDecisionV2Schema,
  auditEntryV2Schema,
  auditReadResponseV2Schema,
  isApprovalDecisionAllowed,
  isSessionGrantAllowed,
  permissionActionV2Schema,
  permissionKey,
  sandboxStatusV2Schema,
  workspaceIdentityV2Schema,
  workspaceTrustRecordV2Schema,
  type PermissionActionV2,
} from '../src/policy-v2.js';

const sessionId = '00000000-0000-4000-8000-000000000001';
const turnId = '00000000-0000-4000-8000-000000000002';
const requestId = '00000000-0000-4000-8000-000000000003';
const entryId = '00000000-0000-4000-8000-000000000004';
const timestamp = '2026-08-31T08:00:00.000Z';

function action(overrides: Partial<PermissionActionV2> = {}): PermissionActionV2 {
  return {
    actionClass: 'filesystem',
    operation: 'write',
    targetFingerprint: 'a'.repeat(64),
    safeTargetSummary: 'workspace file',
    risk: 'normal',
    effectsComplete: true,
    mcpDestructive: false,
    ...overrides,
  };
}

function evidence() {
  return [{ kind: 'fixture' as const, reference: 'fixtures/sandbox.json', verifiedAt: timestamp }];
}

function sandbox(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'claude',
    platform: 'linux',
    provider: { mechanism: 'provider_policy', state: 'provider_managed', evidence: [] },
    agentDock: { mechanism: 'agentdock_policy', state: 'not_requested', evidence: [] },
    os: { mechanism: 'os_sandbox', state: 'unknown', evidence: [] },
    badge: 'none',
    ...overrides,
  };
}

function auditEntry(permissionAction = action(), overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sequence: 1,
    entryId,
    recordedAt: timestamp,
    sessionId,
    turnId,
    requestId,
    providerId: 'claude',
    transport: 'sdk',
    workspaceFingerprint: 'b'.repeat(64),
    action: permissionAction,
    permissionKey: permissionKey(permissionAction),
    decision: 'allow_once',
    actor: 'user',
    ...overrides,
  };
}

describe('permission policy v2 contracts', () => {
  it('fixes the normalized action and decision vocabularies with ask as the default', () => {
    expect(ACTION_CLASSES).toEqual([
      'filesystem',
      'command',
      'network',
      'mcp',
      'external_side_effect',
      'other',
    ]);
    expect(DEFAULT_PERMISSION_POLICY).toBe('ask');
    for (const decision of ['allow_once', 'allow_session', 'deny']) {
      expect(approvalDecisionV2Schema.safeParse(decision).success).toBe(true);
    }
    expect(approvalDecisionV2Schema.safeParse('allow').success).toBe(false);
    expect(permissionActionV2Schema.safeParse({ ...action(), rawPrompt: 'secret' }).success).toBe(
      false,
    );
  });

  it('builds a deterministic exact permission key from normalized enforcement fields', () => {
    const first = action();
    const reordered = {
      safeTargetSummary: first.safeTargetSummary,
      mcpDestructive: first.mcpDestructive,
      effectsComplete: first.effectsComplete,
      risk: first.risk,
      targetFingerprint: first.targetFingerprint,
      operation: first.operation,
      actionClass: first.actionClass,
    };

    expect(permissionKey(reordered)).toBe(permissionKey(first));
    expect(permissionKey({ ...first, safeTargetSummary: 'same exact target, clearer label' })).toBe(
      permissionKey(first),
    );
    expect(permissionKey({ ...first, targetFingerprint: 'c'.repeat(64) })).not.toBe(
      permissionKey(first),
    );
    expect(permissionKey({ ...first, operation: 'delete' })).not.toBe(permissionKey(first));
  });

  it('never creates session grants for destructive, unknown, external, or destructive MCP actions', () => {
    const destructive = action({ risk: 'destructive' });
    const unknown = action({ risk: 'unknown', effectsComplete: false });
    const external = action({ actionClass: 'external_side_effect' });
    const destructiveMcp = action({
      actionClass: 'mcp',
      operation: 'tool.invoke',
      risk: 'destructive',
      mcpDestructive: true,
    });

    expect(isSessionGrantAllowed(action())).toBe(true);
    for (const unsafe of [destructive, unknown, external, destructiveMcp]) {
      expect(isSessionGrantAllowed(unsafe)).toBe(false);
      expect(isApprovalDecisionAllowed(unsafe, 'allow_session')).toBe(false);
      expect(isApprovalDecisionAllowed(unsafe, 'allow_once')).toBe(true);
      expect(isApprovalDecisionAllowed(unsafe, 'deny')).toBe(true);
    }
    expect(permissionActionV2Schema.safeParse(action({ actionClass: 'other' })).success).toBe(
      false,
    );
  });
});

describe('workspace trust v2 contracts', () => {
  const stableIdentity = {
    schemaVersion: 1 as const,
    kind: 'git' as const,
    canonicalGitCommonDirectory: '/workspace/.git',
    gitCommonDirectoryObject: { kind: 'unix' as const, device: '2049', inode: '100' },
    canonicalWorktreeRoot: '/workspace',
    worktreeRootObject: { kind: 'unix' as const, device: '2049', inode: '101' },
  };

  it('binds trust to canonical paths and stable filesystem incarnations', () => {
    expect(workspaceIdentityV2Schema.safeParse(stableIdentity).success).toBe(true);
    expect(
      workspaceTrustRecordV2Schema.safeParse({
        schemaVersion: 1,
        identity: stableIdentity,
        state: 'trusted',
        source: 'user',
        scope: 'persistent',
        updatedAt: timestamp,
      }).success,
    ).toBe(true);
    expect(
      workspaceIdentityV2Schema.safeParse({
        ...stableIdentity,
        worktreeRootObject: { kind: 'windows', volumeSerial: 'a1', fileId: 'b2' },
      }).success,
    ).toBe(false);
  });

  it('refuses reusable trust without stable object identity or an explicit trust source', () => {
    const ephemeralIdentity = {
      schemaVersion: 1,
      kind: 'directory',
      canonicalWorkingDirectory: '/workspace',
      workingDirectoryObject: { kind: 'ephemeral', nonce: sessionId },
    };
    expect(
      workspaceTrustRecordV2Schema.safeParse({
        schemaVersion: 1,
        identity: ephemeralIdentity,
        state: 'trusted',
        source: 'user',
        scope: 'persistent',
        updatedAt: timestamp,
      }).success,
    ).toBe(false);
    expect(
      workspaceTrustRecordV2Schema.safeParse({
        schemaVersion: 1,
        identity: stableIdentity,
        state: 'trusted',
        source: 'default',
        scope: 'persistent',
        updatedAt: timestamp,
      }).success,
    ).toBe(false);
  });
});

describe('sandbox truth v2 contract', () => {
  it('keeps provider, AgentDock, and OS enforcement separate', () => {
    expect(sandboxStatusV2Schema.safeParse(sandbox()).success).toBe(true);
    expect(
      sandboxStatusV2Schema.safeParse(
        sandbox({
          os: { mechanism: 'os_sandbox', state: 'enforced', evidence: evidence() },
          badge: 'os_sandboxed',
        }),
      ).success,
    ).toBe(true);
    expect(sandboxStatusV2Schema.safeParse(sandbox({ badge: 'os_sandboxed' })).success).toBe(false);
    expect(
      sandboxStatusV2Schema.safeParse(
        sandbox({
          agentDock: { mechanism: 'agentdock_policy', state: 'enforced', evidence: evidence() },
          badge: 'restricted_by_policy',
        }),
      ).success,
    ).toBe(true);
  });

  it('never permits a Bash-sandboxed badge for native Windows Claude', () => {
    expect(
      sandboxStatusV2Schema.safeParse(
        sandbox({
          platform: 'win32',
          os: { mechanism: 'os_sandbox', state: 'enforced', evidence: evidence() },
          badge: 'bash_sandboxed',
        }),
      ).success,
    ).toBe(false);
    expect(
      sandboxStatusV2Schema.safeParse(
        sandbox({
          os: { mechanism: 'os_sandbox', state: 'provider_managed', evidence: [] },
        }),
      ).success,
    ).toBe(false);
  });
});

describe('audit v2 contracts', () => {
  it('accepts only versioned normalized decision metadata with an exact permission key', () => {
    const entry = auditEntry();
    expect(auditEntryV2Schema.safeParse(entry).success).toBe(true);
    expect(
      auditEntryV2Schema.safeParse({
        ...entry,
        permissionKey: permissionKey(action({ operation: 'delete' })),
      }).success,
    ).toBe(false);
    expect(
      auditEntryV2Schema.safeParse({
        ...auditEntry(action({ risk: 'destructive' })),
        decision: 'allow_session',
      }).success,
    ).toBe(false);
    expect(
      auditEntryV2Schema.safeParse({ ...entry, actor: 'audit_failure', decision: 'allow_once' })
        .success,
    ).toBe(false);
  });

  it('rejects raw or secret-bearing audit fields and enforces page bounds', () => {
    const forbidden = ['rawPrompt', 'nativeRequestId', 'credentials', 'environment', 'toolResult'];
    for (const field of forbidden) {
      expect(auditEntryV2Schema.safeParse({ ...auditEntry(), [field]: 'forbidden' }).success).toBe(
        false,
      );
    }
    expect(
      auditEntryV2Schema.safeParse(
        auditEntry(action(), {
          action: action({ safeTargetSummary: '€'.repeat(512) }),
        }),
      ).success,
    ).toBe(false);
    expect(
      auditReadResponseV2Schema.safeParse({
        schemaVersion: 1,
        entries: Array.from({ length: 101 }, (_, sequence) => auditEntry(action(), { sequence })),
      }).success,
    ).toBe(false);
    expect(
      auditReadResponseV2Schema.safeParse({
        schemaVersion: 1,
        entries: [auditEntry()],
        nextCursor: 'page_2',
      }).success,
    ).toBe(true);
  });
});
