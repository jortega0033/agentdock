import { randomUUID } from 'node:crypto';
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
});
