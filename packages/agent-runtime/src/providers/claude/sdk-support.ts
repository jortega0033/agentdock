import {
  CAPABILITY_CATALOG,
  type CapabilityConstraintById,
  type CapabilitySupportRecord,
  type CoreCapabilityId,
  type ProviderStatus,
  type ProviderTransportV2,
} from '@agent-dock/shared';
import type { ProviderV2Support } from '../../types.js';
import { resolveClaudeSdkAuth, type ClaudeSdkAuthSource } from './sdk-auth.js';
import { CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION, CLAUDE_AGENT_SDK_VERSION } from './sdk-version.js';
import type { ClaudeTransportMode } from './transport-mode.js';

export const CLAUDE_AGENT_SDK_TRANSPORT_ID = 'claude-agent-sdk';
export const CLAUDE_AGENT_SDK_FIXTURE_SET = `claude-agent-sdk-${CLAUDE_AGENT_SDK_VERSION}-v1`;

export const CLAUDE_AGENT_SDK_TRANSPORT: ProviderTransportV2 = {
  id: CLAUDE_AGENT_SDK_TRANSPORT_ID,
  priority: 1,
  stability: 'stable',
  possibleEffects: ['read', 'filesystem_write'],
  effectsComplete: true,
};

export class ClaudeSdkUnsupportedError extends Error {
  readonly code = 'claude_sdk_unsupported' as const;

  constructor(reason: string) {
    super(`Claude Agent SDK transport is unavailable: ${reason}`);
    this.name = 'ClaudeSdkUnsupportedError';
  }
}

const COMMON_CAPABILITIES = [
  'session.input.follow_up',
  'session.interrupt',
  'session.cancel',
  'interaction.question',
  'content.streaming',
  'content.usage.tokens',
  'content.usage.cost',
] as const satisfies readonly CoreCapabilityId[];

const TRUSTED_CAPABILITIES = [
  ...COMMON_CAPABILITIES,
  'interaction.approval',
  'content.tools',
] as const satisfies readonly CoreCapabilityId[];

type ClaudeCapabilityId = (typeof TRUSTED_CAPABILITIES)[number];

const EXPLICITLY_UNSUPPORTED_CAPABILITIES = [
  'session.resume',
  'session.fork',
  'integration.mcp.oauth',
] as const satisfies readonly CoreCapabilityId[];

type ClaudeUnsupportedCapabilityId = (typeof EXPLICITLY_UNSUPPORTED_CAPABILITIES)[number];

export interface ClaudeSdkRuntimeEligibility {
  runtimePlatform: NodeJS.Platform;
  sdkAssetAvailable: boolean;
  /** Version reported for the resolved SDK-owned executable, never a PATH CLI. */
  sdkClaudeCodeVersion: string | undefined;
}

function constraintsFor<I extends ClaudeCapabilityId>(id: I): CapabilityConstraintById[I] {
  switch (id) {
    case 'session.input.follow_up':
      return {
        kind: 'text_input',
        maxCharacters: 200_000,
        attachmentKinds: [],
      } as unknown as CapabilityConstraintById[I];
    case 'session.interrupt':
    case 'session.cancel':
      return { kind: 'acknowledgement', timeoutMs: 30_000 } as CapabilityConstraintById[I];
    case 'interaction.approval':
    case 'interaction.question':
      return {
        kind: 'interaction',
        timeoutMs: 300_000,
        maxPayloadBytes: 32 * 1024,
      } as CapabilityConstraintById[I];
    case 'content.streaming':
      return {
        kind: 'content',
        maxBlockBytes: 256 * 1024,
        persistence: 'normalized',
      } as CapabilityConstraintById[I];
    case 'content.tools':
      return {
        kind: 'effects',
        allowedEffects: ['read', 'filesystem_write'],
      } as CapabilityConstraintById[I];
    case 'content.usage.tokens':
      return { kind: 'usage', scopes: ['turn', 'session'] } as CapabilityConstraintById[I];
    case 'content.usage.cost':
      return {
        kind: 'cost',
        scopes: ['turn', 'session'],
        currencies: ['USD'],
        acceptsEstimates: true,
      } as CapabilityConstraintById[I];
  }
}

function sessionStatesFor(
  id: ClaudeCapabilityId,
): Array<'starting' | 'active' | 'idle' | 'terminal'> {
  switch (id) {
    case 'session.input.follow_up':
      return ['starting', 'idle'];
    case 'session.interrupt':
    case 'interaction.approval':
    case 'interaction.question':
      return ['starting', 'active'];
    case 'session.cancel':
      return ['starting', 'active', 'idle'];
    default:
      return ['starting', 'active', 'idle', 'terminal'];
  }
}

function supportRecord<I extends ClaudeCapabilityId>(
  status: ProviderStatus,
  authSource: ClaudeSdkAuthSource,
  id: I,
): CapabilitySupportRecord {
  const effects = id === 'content.tools' || id === 'interaction.approval';
  return {
    id,
    kind: CAPABILITY_CATALOG[id].kind,
    owner: CAPABILITY_CATALOG[id].owner,
    support: 'supported',
    stability: 'stable',
    evidence: [
      { kind: 'fixture', reference: CLAUDE_AGENT_SDK_FIXTURE_SET },
      {
        kind: 'vendor_declared',
        reference: 'https://platform.claude.com/docs/en/agent-sdk/typescript',
      },
    ],
    scope: {
      provider: status.id,
      transport: CLAUDE_AGENT_SDK_TRANSPORT_ID,
      platform: 'win32',
      model: '*',
      authMode: authSource,
      trustState: 'trusted',
      versions: {
        adapterContract: '2',
        transport: CLAUDE_AGENT_SDK_VERSION,
        runtime: process.version,
        sdk: CLAUDE_AGENT_SDK_VERSION,
        schema: CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION,
        fixtureSet: CLAUDE_AGENT_SDK_FIXTURE_SET,
      },
    },
    prerequisites: {
      capabilities: [],
      trustStates: ['trusted'],
      sessionStates: sessionStatesFor(id),
      services: [],
    },
    possibleEffects: effects ? ['read', 'filesystem_write'] : [],
    effectsComplete: true,
    constraints: constraintsFor(id),
  } as CapabilitySupportRecord;
}

function unsupportedRecord<I extends ClaudeUnsupportedCapabilityId>(
  status: ProviderStatus,
  authSource: ClaudeSdkAuthSource,
  id: I,
): CapabilitySupportRecord {
  const continuation = id === 'session.resume' || id === 'session.fork';
  return {
    id,
    kind: CAPABILITY_CATALOG[id].kind,
    owner: CAPABILITY_CATALOG[id].owner,
    support: 'unsupported',
    stability: 'stable',
    evidence: [
      { kind: 'fixture', reference: CLAUDE_AGENT_SDK_FIXTURE_SET },
      {
        kind: 'vendor_declared',
        reference: 'https://platform.claude.com/docs/en/agent-sdk/typescript',
      },
    ],
    scope: {
      provider: status.id,
      transport: CLAUDE_AGENT_SDK_TRANSPORT_ID,
      platform: 'win32',
      model: '*',
      authMode: authSource,
      trustState: 'trusted',
      versions: {
        adapterContract: '2',
        transport: CLAUDE_AGENT_SDK_VERSION,
        runtime: process.version,
        sdk: CLAUDE_AGENT_SDK_VERSION,
        schema: CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION,
        fixtureSet: CLAUDE_AGENT_SDK_FIXTURE_SET,
      },
    },
    prerequisites: {
      capabilities: [],
      trustStates: ['trusted'],
      sessionStates: continuation ? ['starting'] : ['starting', 'active', 'idle'],
      services: [],
    },
    possibleEffects: [],
    effectsComplete: true,
    constraints: continuation
      ? ({ kind: 'continuation', native: true } as CapabilityConstraintById[I])
      : ({ kind: 'none' } as CapabilityConstraintById[I]),
    reason: continuation
      ? 'Provider session identity cannot yet be bound to a non-secret account and model scope'
      : 'Claude Agent SDK transport disables MCP servers and OAuth flows',
  } as CapabilitySupportRecord;
}

/** Auto falls back to CLI; a forced SDK request instead converts every eligibility miss to error. */
export function resolveClaudeSdkV2Support(
  status: ProviderStatus,
  mode: ClaudeTransportMode,
  env: Readonly<Record<string, string | undefined>>,
  runtime: ClaudeSdkRuntimeEligibility,
): ProviderV2Support | undefined {
  if (mode === 'cli') return undefined;

  const auth = resolveClaudeSdkAuth(env);
  const unavailable = (reason: string): undefined => {
    if (mode === 'sdk') throw new ClaudeSdkUnsupportedError(reason);
    return undefined;
  };

  if (status.id !== 'claude') return unavailable('provider mismatch');
  if (!status.installed) return unavailable('provider is not installed');
  if (status.authenticated !== 'authenticated') return unavailable('provider is not authenticated');
  if (!auth.eligible) return unavailable(auth.reason);
  if (status.authSource !== auth.source) return unavailable('authentication source mismatch');
  if (runtime.runtimePlatform !== 'win32') return unavailable('unsupported platform');
  if (!runtime.sdkAssetAvailable) return unavailable('SDK asset missing');
  if (runtime.sdkClaudeCodeVersion !== CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION) {
    return unavailable('SDK executable version mismatch');
  }

  const authSource = auth.source;
  return {
    transports: [{ ...CLAUDE_AGENT_SDK_TRANSPORT }],
    capabilities: [
      ...TRUSTED_CAPABILITIES.map((id) => supportRecord(status, authSource, id)),
      ...EXPLICITLY_UNSUPPORTED_CAPABILITIES.map((id) => unsupportedRecord(status, authSource, id)),
    ],
  };
}
