import {
  findProviderCompatibility,
  LEGACY_ONE_SHOT_TRANSPORT_ID,
  type ProviderCompatibilityManifestEntry,
} from '@agent-dock/agent-runtime';
import {
  CAPABILITY_CATALOG,
  type CapabilityConstraintById,
  type CapabilityScope,
  type CapabilitySupportRecord,
  type CoreCapabilityId,
  type CoreCapabilitySupportRecord,
  type Effect,
  type ProviderStatus,
  type ProviderStatusV2,
  type ProviderTransportV2,
} from '@agent-dock/shared';
import { providerSandboxStatus } from './sandbox-status.js';

export const LEGACY_ONE_SHOT_TRANSPORT = LEGACY_ONE_SHOT_TRANSPORT_ID;
export const UNVERIFIED_PROVIDER_FIXTURE_SET = 'unverified-provider-fixtures';

const ALL_EFFECTS: Effect[] = [
  'read',
  'filesystem_write',
  'command',
  'network',
  'external_side_effect',
  'destructive',
];

const LEGACY_TRANSPORT: ProviderTransportV2 = {
  id: LEGACY_ONE_SHOT_TRANSPORT,
  priority: 1_000,
  stability: 'stable',
  possibleEffects: ALL_EFFECTS,
  // A v1 boolean says that tool observations exist, not that every possible tool/effect is known.
  effectsComplete: false,
};

type RuntimeScope = Omit<CapabilityScope, 'transport'>;

function runtimePlatform(): CapabilityScope['platform'] {
  if (process.platform === 'win32' || process.platform === 'darwin') return process.platform;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return 'linux_wsl2';
  return 'linux';
}

function compatibilityFor(status: ProviderStatus): ProviderCompatibilityManifestEntry | undefined {
  return findProviderCompatibility(status.id, status.version, LEGACY_ONE_SHOT_TRANSPORT);
}

function versionsFor(
  status: ProviderStatus,
  compatibility = compatibilityFor(status),
): CapabilityScope['versions'] {
  return {
    adapterContract: '2',
    transport: status.version ?? 'unknown',
    runtime: process.version,
    ...(compatibility ? { schema: compatibility.schemaSet } : {}),
    fixtureSet: compatibility?.fixtureSet ?? UNVERIFIED_PROVIDER_FIXTURE_SET,
  };
}

function legacyRuntimeScopeFor(
  status: ProviderStatus,
  compatibility: ProviderCompatibilityManifestEntry | undefined,
): RuntimeScope {
  return {
    provider: status.id,
    platform: runtimePlatform(),
    model: '*',
    authMode: '*',
    // #9 adds enforcement, but #5 already fixes the truthful initial state. No isolation
    // guarantee is advertised by this bridge, so "untrusted" does not imply sandbox enforcement.
    trustState: 'untrusted',
    versions: versionsFor(status, compatibility),
  };
}

export function legacyRuntimeScope(status: ProviderStatus): RuntimeScope {
  return legacyRuntimeScopeFor(status, compatibilityFor(status));
}

interface LegacyRecordInput<I extends CoreCapabilityId> {
  status: ProviderStatus;
  id: I;
  supported: boolean;
  constraints: CapabilityConstraintById[I];
  possibleEffects?: Effect[];
  effectsComplete?: boolean;
  sessionStates: CapabilitySupportRecord['prerequisites']['sessionStates'];
}

function legacyRecord<I extends CoreCapabilityId>(
  input: LegacyRecordInput<I>,
  compatibility: ProviderCompatibilityManifestEntry | undefined,
): CoreCapabilitySupportRecord {
  const { status } = input;
  const catalog = CAPABILITY_CATALOG[input.id];
  const support = input.supported ? (compatibility ? 'supported' : 'unknown') : 'unsupported';
  return {
    id: input.id,
    kind: catalog.kind,
    owner: catalog.owner,
    support,
    stability: 'stable',
    evidence: compatibility ? [{ kind: 'fixture', reference: compatibility.fixtureSet }] : [],
    scope: {
      ...legacyRuntimeScopeFor(status, compatibility),
      transport: LEGACY_ONE_SHOT_TRANSPORT,
    },
    prerequisites: {
      capabilities: [],
      trustStates: ['untrusted'],
      sessionStates: input.sessionStates,
      services: [],
    },
    possibleEffects: input.possibleEffects ?? [],
    effectsComplete: input.effectsComplete ?? true,
    constraints: input.constraints,
    ...(support === 'unsupported'
      ? { reason: 'legacy adapter reports this capability as unsupported' }
      : support === 'unknown'
        ? { reason: 'no compatibility fixture matches this provider version and transport' }
        : {}),
  } as CoreCapabilitySupportRecord;
}

export function legacyCapabilityRecords(status: ProviderStatus): CapabilitySupportRecord[] {
  const capabilities = status.capabilities;
  const compatibility = compatibilityFor(status);
  return [
    legacyRecord(
      {
        status,
        id: 'session.cancel',
        supported: capabilities.cancellation === true,
        constraints: { kind: 'acknowledgement', timeoutMs: 30_000 },
        sessionStates: ['starting', 'active', 'idle'],
      },
      compatibility,
    ),
    legacyRecord(
      {
        status,
        id: 'session.resume',
        supported: capabilities.resume === true,
        constraints: { kind: 'continuation', native: true },
        sessionStates: ['starting'],
      },
      compatibility,
    ),
    legacyRecord(
      {
        status,
        id: 'content.tools',
        supported: capabilities.tools === true,
        constraints: { kind: 'effects', allowedEffects: ALL_EFFECTS },
        possibleEffects: ALL_EFFECTS,
        effectsComplete: false,
        sessionStates: ['starting', 'active', 'idle'],
      },
      compatibility,
    ),
    legacyRecord(
      {
        status,
        id: 'content.usage.tokens',
        supported: capabilities.usage === true,
        // V1 proves per-turn reports, but does not prove that every adapter produces a session total.
        constraints: { kind: 'usage', scopes: ['turn'] },
        sessionStates: ['starting', 'active', 'idle', 'terminal'],
      },
      compatibility,
    ),
    legacyRecord(
      {
        status,
        id: 'content.thinking',
        // V1 exposes uncorrelated deltas only. V2 requires a stable block id and completion
        // boundary, so the bridge must summarize these observations instead of advertising core
        // thinking support.
        supported: false,
        constraints: { kind: 'content', maxBlockBytes: 256 * 1024, persistence: 'live_only' },
        sessionStates: ['starting', 'active', 'idle'],
      },
      compatibility,
    ),
  ];
}

export function toProviderStatusV2(status: ProviderStatus): ProviderStatusV2 {
  return {
    id: status.id,
    name: status.name,
    installed: status.installed,
    authenticated: status.authenticated,
    ...(status.authSource === undefined ? {} : { authSource: status.authSource }),
    transports: [LEGACY_TRANSPORT],
    capabilities: legacyCapabilityRecords(status),
    sandbox: providerSandboxStatus(status.id, false),
    ...(status.executablePath === undefined ? {} : { executablePath: status.executablePath }),
    ...(status.version === undefined ? {} : { version: status.version }),
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}

export function legacyTransports(): ProviderTransportV2[] {
  return [{ ...LEGACY_TRANSPORT, possibleEffects: [...LEGACY_TRANSPORT.possibleEffects] }];
}
