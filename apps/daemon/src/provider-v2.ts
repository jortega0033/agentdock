import type {
  AgentProvider,
  ProviderV2Support,
  StartSessionOptions,
  ProviderContinuationEvidence,
  WorkspaceTrustEvidence,
} from '@agent-dock/agent-runtime';
import {
  DEFAULT_CAPABILITY_REQUEST,
  negotiateCapabilities,
  type CapabilityRequest,
  type CapabilityRuntimeScope,
  type CapabilitySelection,
  type ProviderRuntimeMetadataV2,
  type ProviderStatus,
  type ProviderStatusV2,
  type ProviderTransportV2,
  type SessionContinuationV2,
} from '@agent-dock/shared';
import {
  legacyCapabilityRecords,
  legacyRuntimeScope,
  legacyTransports,
  toProviderStatusV2 as toLegacyProviderStatusV2,
} from './v2-legacy-provider.js';
import { providerSandboxStatus } from './sandbox-status.js';

export interface ProviderV2Manifest {
  interactive: boolean;
  runtimeScope: CapabilityRuntimeScope;
  supportRecords: ProviderV2Support['capabilities'];
  transports: ProviderV2Support['transports'];
}

/** Internal-only immutable facts that must remain equal before a transport fallback can dispatch. */
export interface FrozenProviderSessionScope {
  provider: ProviderStatus['id'];
  cwd: string;
  executablePath: string;
  providerVersion: string;
  authenticated: ProviderStatus['authenticated'];
  authSource: Exclude<NonNullable<ProviderStatus['authSource']>, 'unknown'>;
  accountFingerprint: string;
  model: string;
  authMode: string;
  platform: CapabilityRuntimeScope['platform'];
  workspaceTrust: WorkspaceTrustEvidence;
  sourceGate: {
    workspaceId?: string;
    incarnation?: string;
  };
  sandbox: NonNullable<StartSessionOptions['sandbox']>;
  continuation: 'fresh' | SessionContinuationV2;
  effectSelection: string;
  capabilitySelection: string;
  sandboxSelection: string;
  retentionSelection: string;
}

/** Provenance required before a daemon-issued native continuation id may be reused. */
export interface ProviderContinuationScope {
  provider: ProviderStatus['id'];
  cwd: string;
  executablePath: string;
  providerVersion: string;
  authenticated: 'authenticated';
  authSource: Exclude<NonNullable<ProviderStatus['authSource']>, 'unknown'>;
  accountFingerprint: string;
  selectedModel: string;
  workspaceTrust: Extract<WorkspaceTrustEvidence, { state: 'trusted' }>;
}

export interface ProviderV2FallbackPlan {
  selection: CapabilitySelection;
  transport: ProviderTransportV2;
  runtimeMetadata: ProviderRuntimeMetadataV2;
  frozenScope: FrozenProviderSessionScope;
}

export interface PinnedLegacyDispatchPlan {
  frozenScope: FrozenProviderSessionScope;
  sandbox: NonNullable<StartSessionOptions['sandbox']>;
}

export type ProviderV2ScopeDeniedReason =
  | 'fallback_auth_source_unverified'
  | 'fallback_account_unverified'
  | 'fallback_authentication_unverified'
  | 'fallback_continuation_fork_unsupported'
  | 'fallback_executable_unverified'
  | 'fallback_provider_version_unverified'
  | 'fallback_model_unverified'
  | 'fallback_resume_sandbox_unsupported'
  | 'fallback_required_capability_unavailable'
  | 'fallback_scope_mismatch'
  | 'fallback_transport_mode_forced'
  | 'fallback_workspace_untrusted';

export interface ProviderV2FallbackPlanning {
  primaryScope?: FrozenProviderSessionScope;
  fallback?: ProviderV2FallbackPlan;
  deniedReason?: ProviderV2ScopeDeniedReason;
}

/** Data-only policy input held until the live app-server has resolved its exact launch scope. */
export interface ProviderV2FallbackIntent {
  request?: CapabilityRequest;
  cwd: string;
  workspaceTrust: WorkspaceTrustEvidence;
  requestedTransportMode?: 'auto' | 'app-server' | 'exec';
  primaryManifest: ProviderV2Manifest;
  primarySelection: CapabilitySelection;
  continuation?: SessionContinuationV2;
}

/** Data-only policy input held until the last pre-spawn legacy scope probe. */
export interface ProviderV2LegacyIntent {
  request?: CapabilityRequest;
  cwd: string;
  workspaceTrust: WorkspaceTrustEvidence;
  manifest: ProviderV2Manifest;
  selection: CapabilitySelection;
  continuation?: SessionContinuationV2;
}

export interface PinnedLegacyDispatchPlanning {
  dispatch?: PinnedLegacyDispatchPlan;
  deniedReason?: ProviderV2ScopeDeniedReason;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
  );
}

function isBoundedWireValue(value: string, maxBytes: number): boolean {
  if (!value || Buffer.byteLength(value) > maxBytes) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  return true;
}

function canonicalSelection(
  selection: CapabilitySelection,
  include: (
    id: string,
    constraints: CapabilitySelection['enabled'][number]['constraints'],
  ) => boolean,
): string {
  return JSON.stringify(
    canonicalValue({
      enabled: [...selection.enabled]
        .filter((entry) => include(entry.id, entry.constraints))
        .map((entry) => ({ id: entry.id, constraints: entry.constraints }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    }),
  );
}

function selectedScope(
  selection: CapabilitySelection,
  include: (
    id: string,
    constraints: CapabilitySelection['enabled'][number]['constraints'],
  ) => boolean,
): string {
  return JSON.stringify(
    canonicalValue(
      [...selection.enabled]
        .filter((entry) => include(entry.id, entry.constraints))
        .map((entry) => ({ id: entry.id, constraints: entry.constraints }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
  );
}

function freezeProviderSessionScope(input: {
  status: ProviderStatus;
  cwd: string;
  runtimeScope: CapabilityRuntimeScope;
  selection: CapabilitySelection;
  workspaceTrust: WorkspaceTrustEvidence;
  request?: CapabilityRequest;
  sandbox: NonNullable<StartSessionOptions['sandbox']>;
  continuation?: SessionContinuationV2;
}): FrozenProviderSessionScope | undefined {
  const { status, cwd, runtimeScope, selection, workspaceTrust } = input;
  if (!status.executablePath) return undefined;
  if (!status.version) return undefined;
  if (!status.authSource || status.authSource === 'unknown') return undefined;
  const requiredIds = new Set(
    (input.request ?? DEFAULT_CAPABILITY_REQUEST).required.map(({ id }) => id),
  );
  return {
    provider: status.id,
    cwd,
    executablePath: status.executablePath,
    providerVersion: status.version,
    authenticated: status.authenticated,
    authSource: status.authSource,
    accountFingerprint: status.accountFingerprint as string,
    model: status.selectedModel as string,
    authMode: runtimeScope.authMode,
    platform: runtimeScope.platform,
    workspaceTrust,
    sourceGate:
      workspaceTrust.state === 'trusted'
        ? {
            workspaceId: workspaceTrust.workspaceId,
            incarnation: workspaceTrust.incarnation,
          }
        : {},
    sandbox: input.sandbox,
    continuation: input.continuation ?? 'fresh',
    effectSelection: JSON.stringify(
      canonicalValue({
        possibleEffects: [...selection.possibleEffects].sort(),
        effectsComplete: selection.effectsComplete,
      }),
    ),
    capabilitySelection: canonicalSelection(selection, (id) => requiredIds.has(id)),
    sandboxSelection: selectedScope(selection, (id) => id.startsWith('isolation.')),
    retentionSelection: selectedScope(
      selection,
      (id, constraints) => requiredIds.has(id) && constraints.kind === 'content',
    ),
  };
}

export function providerFallbackScopesEqual(
  primary: FrozenProviderSessionScope,
  fallback: FrozenProviderSessionScope,
): boolean {
  return JSON.stringify(canonicalValue(primary)) === JSON.stringify(canonicalValue(fallback));
}

export function providerStatusMatchesFrozenScope(
  status: ProviderStatus,
  scope: FrozenProviderSessionScope,
): boolean {
  return (
    status.id === scope.provider &&
    status.installed &&
    status.executablePath === scope.executablePath &&
    status.version === scope.providerVersion &&
    status.authenticated === scope.authenticated &&
    status.authSource === scope.authSource &&
    status.accountFingerprint === scope.accountFingerprint &&
    status.selectedModel === scope.model
  );
}

export function freezeProviderContinuationScope(input: {
  status: ProviderStatus;
  cwd: string;
  workspaceTrust: WorkspaceTrustEvidence;
  evidence?: Readonly<ProviderContinuationEvidence>;
}): ProviderContinuationScope | undefined {
  const { status } = input;
  if (
    !status.installed ||
    !status.executablePath ||
    !status.version ||
    status.authenticated !== 'authenticated' ||
    !status.authSource ||
    status.authSource === 'unknown' ||
    input.workspaceTrust.state !== 'trusted'
  ) {
    return undefined;
  }
  const evidence =
    input.evidence ??
    (status.accountFingerprint && status.selectedModel
      ? {
          accountFingerprint: status.accountFingerprint,
          selectedModel: status.selectedModel,
        }
      : undefined);
  if (
    !evidence ||
    !/^[a-f0-9]{64}$/.test(evidence.accountFingerprint) ||
    !isBoundedWireValue(evidence.selectedModel, 256)
  ) {
    return undefined;
  }
  return {
    provider: status.id,
    cwd: input.cwd,
    executablePath: status.executablePath,
    providerVersion: status.version,
    authenticated: 'authenticated',
    authSource: status.authSource,
    accountFingerprint: evidence.accountFingerprint,
    selectedModel: evidence.selectedModel,
    workspaceTrust: input.workspaceTrust,
  };
}

export function providerContinuationScopesEqual(
  expected: ProviderContinuationScope,
  current: ProviderContinuationScope,
): boolean {
  return JSON.stringify(canonicalValue(expected)) === JSON.stringify(canonicalValue(current));
}

export function capabilityRequestForContinuation(
  request: CapabilityRequest | undefined,
  continuation: SessionContinuationV2 | undefined,
): CapabilityRequest | undefined {
  if (!continuation) return request;
  const capabilityId = continuation.kind === 'resume' ? 'session.resume' : 'session.fork';
  const base = request ?? DEFAULT_CAPABILITY_REQUEST;
  const existing = [...base.required, ...base.optional].find(({ id }) => id === capabilityId);
  return {
    ...base,
    required: [
      ...base.required.filter(({ id }) => id !== capabilityId),
      existing ?? { id: capabilityId },
    ],
    optional: base.optional.filter(({ id }) => id !== capabilityId),
  };
}

function preflightScopeReason(
  status: ProviderStatus,
  workspaceTrust: WorkspaceTrustEvidence,
): ProviderV2ScopeDeniedReason | undefined {
  if (!status.installed || !status.executablePath) return 'fallback_executable_unverified';
  if (!status.version) return 'fallback_provider_version_unverified';
  if (status.authenticated !== 'authenticated') return 'fallback_authentication_unverified';
  if (!status.authSource || status.authSource === 'unknown') {
    return 'fallback_auth_source_unverified';
  }
  if (!status.accountFingerprint || !/^[a-f0-9]{64}$/.test(status.accountFingerprint)) {
    return 'fallback_account_unverified';
  }
  if (!status.selectedModel || !isBoundedWireValue(status.selectedModel, 256)) {
    return 'fallback_model_unverified';
  }
  if (workspaceTrust.state !== 'trusted') return 'fallback_workspace_untrusted';
  return undefined;
}

export function planPinnedLegacyDispatch(input: {
  status: ProviderStatus;
  request?: CapabilityRequest;
  cwd: string;
  workspaceTrust: WorkspaceTrustEvidence;
  manifest: ProviderV2Manifest;
  selection: CapabilitySelection;
  continuation?: SessionContinuationV2;
}): PinnedLegacyDispatchPlanning {
  if (input.continuation?.kind === 'fork') {
    return { deniedReason: 'fallback_continuation_fork_unsupported' };
  }
  if (input.continuation?.kind === 'resume') {
    return { deniedReason: 'fallback_resume_sandbox_unsupported' };
  }
  const deniedReason = preflightScopeReason(input.status, input.workspaceTrust);
  if (deniedReason) return { deniedReason };
  const frozenScope = freezeProviderSessionScope({
    status: input.status,
    cwd: input.cwd,
    runtimeScope: input.manifest.runtimeScope,
    selection: input.selection,
    workspaceTrust: input.workspaceTrust,
    request: input.request,
    sandbox: 'workspace-write',
    continuation: input.continuation,
  });
  if (!frozenScope) return { deniedReason: 'fallback_scope_mismatch' };
  return {
    dispatch: {
      frozenScope,
      sandbox: 'workspace-write',
    },
  };
}

/**
 * Pre-computes the only legal fallback before provider startup. The returned plan contains no
 * credentials or native payloads and is usable only while its exact frozen scope still matches.
 */
export function planLegacyProviderFallback(
  input: ProviderV2FallbackIntent & { status: ProviderStatus },
): ProviderV2FallbackPlanning {
  const { status } = input;
  if (input.requestedTransportMode !== 'auto') {
    return { deniedReason: 'fallback_transport_mode_forced' };
  }
  if (input.continuation?.kind === 'fork') {
    return { deniedReason: 'fallback_continuation_fork_unsupported' };
  }
  if (input.continuation?.kind === 'resume') {
    return { deniedReason: 'fallback_resume_sandbox_unsupported' };
  }
  const deniedReason = preflightScopeReason(status, input.workspaceTrust);
  if (deniedReason) return { deniedReason };

  const legacyManifest: ProviderV2Manifest = {
    interactive: false,
    runtimeScope: legacyRuntimeScope(status),
    supportRecords: legacyCapabilityRecords(status),
    transports: legacyTransports(),
  };
  const negotiation = negotiateCapabilities({
    request: input.request,
    runtimeScope: legacyManifest.runtimeScope,
    supportRecords: legacyManifest.supportRecords,
    transports: legacyManifest.transports,
  });
  if (!negotiation.success) {
    return { deniedReason: 'fallback_required_capability_unavailable' };
  }
  const transport = legacyManifest.transports.find(
    (candidate) => candidate.id === negotiation.selection.transport,
  );
  if (!transport) return { deniedReason: 'fallback_scope_mismatch' };

  const primaryScope = freezeProviderSessionScope({
    status,
    cwd: input.cwd,
    runtimeScope: input.primaryManifest.runtimeScope,
    selection: input.primarySelection,
    workspaceTrust: input.workspaceTrust,
    request: input.request,
    sandbox: 'workspace-write',
    continuation: input.continuation,
  });
  const fallbackScope = freezeProviderSessionScope({
    status,
    cwd: input.cwd,
    runtimeScope: legacyManifest.runtimeScope,
    selection: negotiation.selection,
    workspaceTrust: input.workspaceTrust,
    request: input.request,
    sandbox: 'workspace-write',
    continuation: input.continuation,
  });
  if (
    !primaryScope ||
    !fallbackScope ||
    !providerFallbackScopesEqual(primaryScope, fallbackScope)
  ) {
    return { ...(primaryScope ? { primaryScope } : {}), deniedReason: 'fallback_scope_mismatch' };
  }

  const versions = legacyManifest.runtimeScope.versions;
  return {
    primaryScope,
    fallback: {
      selection: negotiation.selection,
      transport,
      frozenScope: fallbackScope,
      runtimeMetadata: {
        cliVersion: status.version,
        ...(versions.schema ? { schemaVersion: versions.schema } : {}),
        fixtureSet: versions.fixtureSet,
        requestedTransportMode: input.requestedTransportMode,
      },
    },
  };
}

function runtimeScopeFromSupport(
  support: ProviderV2Support,
  status: ProviderStatus,
): CapabilityRuntimeScope {
  const scope = support.capabilities[0]?.scope;
  if (!scope) return legacyRuntimeScope(status);
  return {
    provider: scope.provider,
    platform: scope.platform,
    model: scope.model,
    authMode: scope.authMode,
    trustState: scope.trustState,
    versions: scope.versions,
  };
}

/** Resolves the provider's rich v2 contract, falling back to the compatibility bridge. */
export function resolveProviderV2Manifest(
  provider: AgentProvider,
  status: ProviderStatus,
): ProviderV2Manifest {
  const support = provider.startInteractiveSession ? provider.getV2Support?.(status) : undefined;
  if (!support) {
    return {
      interactive: false,
      runtimeScope: legacyRuntimeScope(status),
      supportRecords: legacyCapabilityRecords(status),
      transports: legacyTransports(),
    };
  }
  return {
    interactive: true,
    runtimeScope: runtimeScopeFromSupport(support, status),
    supportRecords: [...support.capabilities],
    transports: [...support.transports],
  };
}

export function toProviderStatusV2(
  provider: AgentProvider,
  status: ProviderStatus,
): ProviderStatusV2 {
  let manifest: ProviderV2Manifest;
  try {
    manifest = resolveProviderV2Manifest(provider, status);
  } catch {
    return {
      ...toLegacyProviderStatusV2(status),
      // Interactive protocol support is not evidence that AgentDock policy is enforced.
      sandbox: providerSandboxStatus(status.id, false),
      error:
        'Codex app-server transport is unavailable for the detected CLI version or transport mode',
    };
  }
  return {
    ...toLegacyProviderStatusV2(status),
    transports: manifest.transports,
    capabilities: manifest.supportRecords,
    // A provider-owned interactive transport does not establish AgentDock policy enforcement.
    sandbox: providerSandboxStatus(status.id, false),
  };
}
