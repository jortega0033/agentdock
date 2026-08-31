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

function actionClassFromEffects(effects: ReadonlySet<string>): PermissionActionV2['actionClass'] {
  if (effects.has('external_side_effect')) return 'external_side_effect';
  if (effects.has('network')) return 'network';
  if (effects.has('command')) return 'command';
  if (effects.has('filesystem_write') || effects.has('read')) return 'filesystem';
  return 'other';
}

function conservativeActionClass(
  effectsClass: PermissionActionV2['actionClass'],
  providerClass: PermissionActionV2['actionClass'] | undefined,
): PermissionActionV2['actionClass'] {
  if (!providerClass) return effectsClass;
  if (effectsClass === 'external_side_effect' || providerClass === 'external_side_effect') {
    return 'external_side_effect';
  }
  if (providerClass === 'other') return 'other';
  // MCP is not representable in the generic effects list, so retain that classification while
  // deriving every key/audit string locally below.
  if (providerClass === 'mcp') return 'mcp';
  if (effectsClass === 'other') return providerClass;
  // Conflicting normal classes are ambiguous and must not inherit either class's session grant.
  return effectsClass === providerClass ? effectsClass : 'other';
}

function closedOperation(
  actionClass: PermissionActionV2['actionClass'],
  effects: ReadonlySet<string>,
): string {
  switch (actionClass) {
    case 'filesystem':
      return effects.has('filesystem_write')
        ? 'filesystem.write'
        : effects.has('read')
          ? 'filesystem.read'
          : 'filesystem.access';
    case 'command':
      return 'command.execute';
    case 'network':
      return 'network.access';
    case 'mcp':
      return 'mcp.invoke';
    case 'external_side_effect':
      return 'external.perform';
    case 'other':
      return 'other.unknown';
  }
}

/** Builds a closed, audit-safe action when an adapter has not supplied richer normalization. */
export function normalizeApprovalAction(event: ApprovalRequestedEvent): PermissionActionV2 {
  const effects = new Set(event.possibleEffects);
  const provider = event.permission ? permissionActionV2Schema.parse(event.permission) : undefined;
  const actionClass = conservativeActionClass(
    actionClassFromEffects(effects),
    provider?.actionClass,
  );
  const operation = closedOperation(actionClass, effects);
  const effectsComplete = event.effectsComplete && (provider?.effectsComplete ?? true);
  const destructive =
    effects.has('destructive') ||
    provider?.risk === 'destructive' ||
    provider?.mcpDestructive === true;
  const risk = destructive
    ? 'destructive'
    : !effectsComplete || actionClass === 'other' || provider?.risk === 'unknown'
      ? 'unknown'
      : 'normal';
  return permissionActionV2Schema.parse({
    actionClass,
    operation,
    targetFingerprint: fingerprint(event.target),
    safeTargetSummary: `${actionClass}:${operation}`,
    risk,
    effectsComplete,
    mcpDestructive: actionClass === 'mcp' && destructive,
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
