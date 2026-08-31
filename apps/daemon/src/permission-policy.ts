import { createHash } from 'node:crypto';
import {
  isSessionGrantAllowed,
  permissionActionV2Schema,
  permissionKey,
  type AgentEventV2,
  type ApprovalDecisionV2,
  type PermissionActionV2,
} from '@agent-dock/shared';

type ApprovalRequestedEvent = Extract<AgentEventV2, { type: 'approval.requested' }>;

export interface PermissionPolicyContext {
  trustState: 'trusted' | 'untrusted' | 'revoking';
  grants: ReadonlySet<string>;
}

export type PermissionPolicyResult =
  | { outcome: 'deny'; reason: 'workspace_untrusted' | 'workspace_revoking' }
  | {
      outcome: 'ask';
      reason:
        | 'default_ask'
        | 'destructive'
        | 'destructive_mcp'
        | 'external_side_effect'
        | 'incomplete_effects'
        | 'unknown';
      allowedDecisions: ApprovalDecisionV2[];
    }
  | { outcome: 'allow'; reason: 'session_grant'; permissionKey: string };

function fingerprint(value: string): string {
  return createHash('sha256').update(value.normalize('NFC')).digest('hex');
}

/** Builds a closed, audit-safe action when an adapter has not supplied richer normalization. */
export function normalizeApprovalAction(event: ApprovalRequestedEvent): PermissionActionV2 {
  if (event.permission) return permissionActionV2Schema.parse(event.permission);
  const effects = new Set(event.possibleEffects);
  const destructive = effects.has('destructive');
  const actionClass = effects.has('external_side_effect')
    ? 'external_side_effect'
    : effects.has('network')
      ? 'network'
      : effects.has('command')
        ? 'command'
        : effects.has('filesystem_write') || effects.has('read')
          ? 'filesystem'
          : 'other';
  const operation =
    actionClass === 'filesystem'
      ? effects.has('filesystem_write')
        ? 'filesystem.write'
        : 'filesystem.read'
      : actionClass === 'command'
        ? 'command.execute'
        : actionClass === 'network'
          ? 'network.access'
          : actionClass === 'external_side_effect'
            ? 'external.perform'
            : 'other.unknown';
  return permissionActionV2Schema.parse({
    actionClass,
    operation,
    targetFingerprint: fingerprint(event.target),
    safeTargetSummary: `${actionClass}:${operation}`,
    risk:
      !event.effectsComplete || actionClass === 'other'
        ? 'unknown'
        : destructive
          ? 'destructive'
          : 'normal',
    effectsComplete: event.effectsComplete,
    mcpDestructive: false,
  });
}

export function allowedApprovalDecisions(action: PermissionActionV2): ApprovalDecisionV2[] {
  return isSessionGrantAllowed(action)
    ? ['allow_once', 'allow_session', 'deny']
    : ['allow_once', 'deny'];
}

/** Fixed precedence. There is deliberately no global/persistent auto-allow branch. */
export function evaluatePermissionPolicy(
  actionInput: PermissionActionV2,
  context: PermissionPolicyContext,
): PermissionPolicyResult {
  const action = permissionActionV2Schema.parse(actionInput);
  if (context.trustState === 'revoking') {
    return { outcome: 'deny', reason: 'workspace_revoking' };
  }
  if (context.trustState === 'untrusted') {
    return { outcome: 'deny', reason: 'workspace_untrusted' };
  }
  const allowedDecisions = allowedApprovalDecisions(action);
  if (action.actionClass === 'mcp' && action.mcpDestructive) {
    return { outcome: 'ask', reason: 'destructive_mcp', allowedDecisions };
  }
  if (!action.effectsComplete) {
    return { outcome: 'ask', reason: 'incomplete_effects', allowedDecisions };
  }
  if (action.risk === 'destructive') {
    return { outcome: 'ask', reason: 'destructive', allowedDecisions };
  }
  if (action.risk === 'unknown' || action.actionClass === 'other') {
    return { outcome: 'ask', reason: 'unknown', allowedDecisions };
  }
  if (action.actionClass === 'external_side_effect') {
    return { outcome: 'ask', reason: 'external_side_effect', allowedDecisions };
  }
  const key = permissionKey(action);
  if (context.grants.has(key)) {
    return { outcome: 'allow', reason: 'session_grant', permissionKey: key };
  }
  return { outcome: 'ask', reason: 'default_ask', allowedDecisions };
}
