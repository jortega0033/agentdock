import type { AgentProvider, ProviderV2Support } from '@agent-dock/agent-runtime';
import type { CapabilityRuntimeScope, ProviderStatus, ProviderStatusV2 } from '@agent-dock/shared';
import {
  legacyCapabilityRecords,
  legacyRuntimeScope,
  legacyTransports,
  toProviderStatusV2 as toLegacyProviderStatusV2,
} from './v2-legacy-provider.js';

export interface ProviderV2Manifest {
  interactive: boolean;
  runtimeScope: CapabilityRuntimeScope;
  supportRecords: ProviderV2Support['capabilities'];
  transports: ProviderV2Support['transports'];
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
  const manifest = resolveProviderV2Manifest(provider, status);
  return {
    ...toLegacyProviderStatusV2(status),
    transports: manifest.transports,
    capabilities: manifest.supportRecords,
  };
}
