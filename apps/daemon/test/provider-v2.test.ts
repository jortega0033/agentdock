import { describe, expect, it } from 'vitest';
import type { CapabilitySelection, ProviderStatus, ProviderTransportV2 } from '@agent-dock/shared';
import {
  planLegacyProviderFallback,
  planPinnedLegacyDispatch,
  providerFallbackScopesEqual,
  type ProviderV2Manifest,
} from '../src/provider-v2.js';
import { legacyRuntimeScope } from '../src/v2-legacy-provider.js';

const effects = [
  'read',
  'filesystem_write',
  'command',
  'network',
  'external_side_effect',
  'destructive',
] as const;

const status: ProviderStatus = {
  id: 'codex',
  name: 'Codex',
  installed: true,
  authenticated: 'authenticated',
  authSource: 'chatgpt',
  accountFingerprint: 'a'.repeat(64),
  selectedModel: 'gpt-5.4',
  executablePath: 'C:\\Program Files\\OpenAI\\Codex\\codex.exe',
  version: '0.147.0',
  capabilities: {
    cancellation: true,
    resume: true,
    tools: true,
    usage: true,
    thinking: false,
  },
};

const appServerTransport: ProviderTransportV2 = {
  id: 'codex-app-server',
  priority: 1,
  stability: 'stable',
  possibleEffects: [...effects],
  effectsComplete: false,
};

const selection: CapabilitySelection = {
  transport: appServerTransport.id,
  enabled: [
    {
      id: 'session.cancel',
      constraints: { kind: 'acknowledgement', timeoutMs: 30_000 },
    },
  ],
  unavailableOptional: [],
  possibleEffects: [...effects],
  effectsComplete: false,
};

const primaryManifest: ProviderV2Manifest = {
  interactive: true,
  runtimeScope: {
    ...legacyRuntimeScope(status),
    trustState: 'trusted',
    versions: {
      adapterContract: '2',
      transport: '0.147.0',
      runtime: process.version,
      schema: 'schema-0.147.0',
      fixtureSet: 'codex-app-server-0.147.0-v1',
    },
  },
  supportRecords: [],
  transports: [appServerTransport],
};

const workspaceTrust = {
  state: 'trusted' as const,
  workspaceId: 'workspace-1',
  incarnation: 'incarnation-1',
  trustEpoch: 3,
};

function plan(overrides: Partial<Parameters<typeof planLegacyProviderFallback>[0]> = {}) {
  return planLegacyProviderFallback({
    status,
    request: {
      required: [{ id: 'session.cancel' }],
      optional: [],
      allowExperimental: false,
    },
    cwd: 'C:\\work\\repo',
    workspaceTrust,
    requestedTransportMode: 'auto',
    primaryManifest,
    primarySelection: selection,
    ...overrides,
  });
}

describe('provider v2 fallback planning', () => {
  it('builds an exec fallback only for an exact frozen scope in auto mode', () => {
    const result = plan();

    expect(result.deniedReason).toBeUndefined();
    expect(result.fallback?.transport.id).toBe('legacy-one-shot');
    expect(result.fallback?.runtimeMetadata).toMatchObject({
      cliVersion: '0.147.0',
      requestedTransportMode: 'auto',
    });
    expect(result.primaryScope).toBeDefined();
    expect(providerFallbackScopesEqual(result.primaryScope!, result.fallback!.frozenScope)).toBe(
      true,
    );
  });

  it('denies fallback for forced app-server and unverified auth sources', () => {
    expect(plan({ requestedTransportMode: 'app-server' }).deniedReason).toBe(
      'fallback_transport_mode_forced',
    );
    expect(plan({ status: { ...status, authenticated: 'unknown' } }).deniedReason).toBe(
      'fallback_authentication_unverified',
    );
    expect(plan({ status: { ...status, authSource: 'unknown' } }).deniedReason).toBe(
      'fallback_auth_source_unverified',
    );
    expect(plan({ status: { ...status, accountFingerprint: undefined } }).deniedReason).toBe(
      'fallback_account_unverified',
    );
    expect(plan({ status: { ...status, selectedModel: undefined } }).deniedReason).toBe(
      'fallback_model_unverified',
    );
  });

  it('denies capability, constraint, effect, sandbox, and retention drift', () => {
    const drifted: CapabilitySelection = {
      ...selection,
      enabled: [
        {
          id: 'session.cancel',
          constraints: { kind: 'acknowledgement', timeoutMs: 1_000 },
        },
        {
          id: 'isolation.network.restricted',
          constraints: { kind: 'network_isolation', destinations: [] },
        },
        {
          id: 'content.streaming',
          constraints: { kind: 'content', maxBlockBytes: 1_024, persistence: 'normalized' },
        },
      ],
      possibleEffects: ['read'],
      effectsComplete: true,
    };

    expect(plan({ primarySelection: drifted }).deniedReason).toBe('fallback_scope_mismatch');
  });

  it('binds fallback to the exact workspace trust epoch and source identity', () => {
    const result = plan();
    const changed = {
      ...result.fallback!.frozenScope,
      workspaceTrust: { ...workspaceTrust, trustEpoch: workspaceTrust.trustEpoch + 1 },
    };

    expect(providerFallbackScopesEqual(result.primaryScope!, changed)).toBe(false);
  });

  it('preserves required safety scope while truthfully dropping unavailable rich optionals', () => {
    const request = {
      required: [{ id: 'session.cancel' }],
      optional: [
        { id: 'interaction.approval' },
        { id: 'interaction.question' },
        { id: 'content.streaming' },
      ],
      allowExperimental: false,
    };
    const richSelection: CapabilitySelection = {
      ...selection,
      enabled: [
        ...selection.enabled,
        {
          id: 'interaction.approval',
          constraints: { kind: 'interaction', timeoutMs: 300_000, maxPayloadBytes: 32_768 },
        },
        {
          id: 'interaction.question',
          constraints: { kind: 'interaction', timeoutMs: 300_000, maxPayloadBytes: 32_768 },
        },
        {
          id: 'content.streaming',
          constraints: { kind: 'content', maxBlockBytes: 262_144, persistence: 'live_only' },
        },
      ],
    };

    const result = plan({ request, primarySelection: richSelection });

    expect(result.fallback).toBeDefined();
    expect(result.fallback?.selection.enabled.map(({ id }) => id)).toEqual(['session.cancel']);
    expect(result.fallback?.selection.unavailableOptional.map(({ id }) => id).sort()).toEqual([
      'content.streaming',
      'interaction.approval',
      'interaction.question',
    ]);
  });

  it('rejects cross-transport resume and fork fallback', () => {
    const request = {
      required: [{ id: 'session.cancel' }, { id: 'session.resume' }],
      optional: [],
      allowExperimental: false,
    };
    const resumeSelection: CapabilitySelection = {
      ...selection,
      enabled: [
        ...selection.enabled,
        { id: 'session.resume', constraints: { kind: 'continuation', native: true } },
      ],
    };
    const result = plan({
      request,
      primarySelection: resumeSelection,
      continuation: { kind: 'resume', providerSessionId: 'native-thread-1' },
    });
    expect(result.fallback).toBeUndefined();
    expect(result.deniedReason).toBe('fallback_resume_sandbox_unsupported');
    expect(
      plan({ continuation: { kind: 'fork', providerSessionId: 'native-thread-1' } }).deniedReason,
    ).toBe('fallback_continuation_fork_unsupported');
    expect(
      planPinnedLegacyDispatch({
        status,
        request,
        cwd: 'C:\\work\\repo',
        workspaceTrust,
        manifest: { ...primaryManifest, interactive: false },
        selection: resumeSelection,
        continuation: { kind: 'resume', providerSessionId: 'native-thread-1' },
      }).deniedReason,
    ).toBe('fallback_resume_sandbox_unsupported');
  });
});
