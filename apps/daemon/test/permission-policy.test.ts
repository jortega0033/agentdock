import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { permissionKey, type PermissionActionV2 } from '@agent-dock/shared';
import {
  allowedApprovalDecisions,
  evaluatePermissionPolicy,
  normalizeApprovalAction,
} from '../src/permission-policy.js';

const normalAction: PermissionActionV2 = {
  actionClass: 'command',
  operation: 'command.execute',
  targetFingerprint: 'a'.repeat(64),
  safeTargetSummary: 'git status',
  risk: 'normal',
  effectsComplete: true,
  mcpDestructive: false,
};

describe('permission policy', () => {
  it('defaults to ask and applies only an exact session-local key', () => {
    expect(
      evaluatePermissionPolicy(normalAction, { trustState: 'trusted', grants: new Set() }),
    ).toMatchObject({ outcome: 'ask', reason: 'default_ask' });
    expect(
      evaluatePermissionPolicy(normalAction, {
        trustState: 'trusted',
        grants: new Set([permissionKey(normalAction)]),
      }),
    ).toMatchObject({ outcome: 'allow', reason: 'session_grant' });
    expect(
      evaluatePermissionPolicy(
        { ...normalAction, targetFingerprint: 'b'.repeat(64) },
        {
          trustState: 'trusted',
          grants: new Set([permissionKey(normalAction)]),
        },
      ),
    ).toMatchObject({ outcome: 'ask' });
  });

  it('denies untrusted/revoking workspaces before considering grants', () => {
    const grants = new Set([permissionKey(normalAction)]);
    expect(evaluatePermissionPolicy(normalAction, { trustState: 'untrusted', grants })).toEqual({
      outcome: 'deny',
      reason: 'workspace_untrusted',
    });
    expect(evaluatePermissionPolicy(normalAction, { trustState: 'revoking', grants })).toEqual({
      outcome: 'deny',
      reason: 'workspace_revoking',
    });
  });

  it.each([
    [{ ...normalAction, risk: 'destructive' as const }, 'destructive'],
    [{ ...normalAction, effectsComplete: false }, 'incomplete_effects'],
    [{ ...normalAction, actionClass: 'external_side_effect' as const }, 'external_side_effect'],
    [
      {
        ...normalAction,
        actionClass: 'mcp' as const,
        risk: 'destructive' as const,
        mcpDestructive: true,
      },
      'destructive_mcp',
    ],
  ])('never reuses a grant for high-risk action %#', (action, reason) => {
    expect(
      evaluatePermissionPolicy(action, {
        trustState: 'trusted',
        grants: new Set([permissionKey(action)]),
      }),
    ).toMatchObject({ outcome: 'ask', reason });
    expect(allowedApprovalDecisions(action)).toEqual(['allow_once', 'deny']);
  });

  it('normalizes legacy approval metadata without retaining raw target text', () => {
    const normalized = normalizeApprovalAction({
      type: 'approval.requested',
      turnId: randomUUID(),
      requestId: randomUUID(),
      title: 'Run command',
      action: 'execute',
      target: 'SECRET_TARGET_CANARY',
      possibleEffects: ['command'],
      effectsComplete: true,
      deadlineAt: new Date().toISOString(),
    });
    expect(normalized).toMatchObject({
      actionClass: 'command',
      operation: 'command.execute',
      risk: 'normal',
    });
    expect(JSON.stringify(normalized)).not.toContain('SECRET_TARGET_CANARY');
  });

  it('does not trust provider display text as audit-safe metadata', () => {
    const normalized = normalizeApprovalAction({
      type: 'approval.requested',
      turnId: randomUUID(),
      requestId: randomUUID(),
      title: 'Run command',
      action: 'execute',
      target: 'ignored',
      possibleEffects: ['command'],
      effectsComplete: true,
      deadlineAt: new Date().toISOString(),
      permission: {
        ...normalAction,
        safeTargetSummary: 'Bearer SECRET_CANARY',
      },
    });

    expect(normalized.safeTargetSummary).toBe('command:command.execute');
    expect(JSON.stringify(normalized)).not.toContain('SECRET_CANARY');
  });

  it('never reuses a benign MCP grant when event facts become destructive', () => {
    const permission: PermissionActionV2 = {
      ...normalAction,
      actionClass: 'mcp',
      operation: 'mcp.read',
    };
    const common = {
      type: 'approval.requested' as const,
      turnId: randomUUID(),
      title: 'Invoke MCP tool',
      action: 'invoke',
      target: 'stable-mcp-target',
      effectsComplete: true,
      deadlineAt: new Date().toISOString(),
      permission,
    };
    const benign = normalizeApprovalAction({
      ...common,
      requestId: randomUUID(),
      possibleEffects: ['network'],
    });
    const destructive = normalizeApprovalAction({
      ...common,
      requestId: randomUUID(),
      possibleEffects: ['network', 'destructive'],
    });

    expect(benign).toMatchObject({
      actionClass: 'mcp',
      operation: 'mcp.invoke',
      risk: 'normal',
      mcpDestructive: false,
    });
    expect(destructive).toMatchObject({
      actionClass: 'mcp',
      operation: 'mcp.invoke',
      risk: 'destructive',
      mcpDestructive: true,
    });
    expect(
      evaluatePermissionPolicy(destructive, {
        trustState: 'trusted',
        grants: new Set([permissionKey(benign)]),
      }),
    ).toMatchObject({ outcome: 'ask', reason: 'destructive_mcp' });
  });

  it('derives the target fingerprint locally and preserves incomplete event facts', () => {
    const target = 'actual-target';
    const normalized = normalizeApprovalAction({
      type: 'approval.requested',
      turnId: randomUUID(),
      requestId: randomUUID(),
      title: 'Run command',
      action: 'execute',
      target,
      possibleEffects: ['command'],
      effectsComplete: false,
      deadlineAt: new Date().toISOString(),
      permission: {
        ...normalAction,
        targetFingerprint: 'f'.repeat(64),
        effectsComplete: true,
      },
    });

    expect(normalized.targetFingerprint).toBe(
      createHash('sha256').update(target.normalize('NFC')).digest('hex'),
    );
    expect(normalized.targetFingerprint).not.toBe('f'.repeat(64));
    expect(normalized).toMatchObject({ effectsComplete: false, risk: 'unknown' });
    expect(
      evaluatePermissionPolicy(normalized, {
        trustState: 'trusted',
        grants: new Set([permissionKey({ ...normalized, effectsComplete: true, risk: 'normal' })]),
      }),
    ).toMatchObject({ outcome: 'ask', reason: 'incomplete_effects' });
  });

  it('replaces a secret-bearing provider operation with a closed daemon operation', () => {
    const secret = 'secretcanary123';
    const normalized = normalizeApprovalAction({
      type: 'approval.requested',
      turnId: randomUUID(),
      requestId: randomUUID(),
      title: 'Run command',
      action: 'execute',
      target: secret,
      possibleEffects: ['command'],
      effectsComplete: true,
      deadlineAt: new Date().toISOString(),
      permission: {
        ...normalAction,
        operation: `command.execute/${secret}`,
        safeTargetSummary: secret,
      },
    });

    expect(normalized.operation).toBe('command.execute');
    expect(normalized.safeTargetSummary).toBe('command:command.execute');
    expect(JSON.stringify(normalized)).not.toContain(secret);
  });
});
