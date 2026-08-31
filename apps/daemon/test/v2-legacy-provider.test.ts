import { describe, expect, it } from 'vitest';
import { CLAUDE_LEGACY_COMPATIBILITY, CODEX_LEGACY_COMPATIBILITY } from '@agent-dock/agent-runtime';
import type { ProviderId, ProviderStatus } from '@agent-dock/shared';
import {
  UNVERIFIED_PROVIDER_FIXTURE_SET,
  legacyCapabilityRecords,
  legacyRuntimeScope,
} from '../src/v2-legacy-provider.js';

function status(
  id: ProviderId,
  version: string | undefined,
  capabilities: ProviderStatus['capabilities'] = {
    cancellation: true,
    resume: false,
    tools: true,
    usage: true,
    thinking: true,
  },
): ProviderStatus {
  return {
    id,
    name: id,
    installed: true,
    authenticated: 'authenticated',
    capabilities,
    ...(version === undefined ? {} : { version }),
  };
}

describe('legacy provider compatibility evidence', () => {
  it.each([
    ['claude', CLAUDE_LEGACY_COMPATIBILITY],
    ['codex', CODEX_LEGACY_COMPATIBILITY],
  ] as const)('uses exact %s manifest metadata for supported claims', (id, compatibility) => {
    const records = legacyCapabilityRecords(status(id, compatibility.providerVersion));
    const supported = records.find((record) => record.id === 'session.cancel');

    expect(supported).toMatchObject({
      support: 'supported',
      evidence: [{ kind: 'fixture', reference: compatibility.fixtureSet }],
      scope: {
        transport: compatibility.transport,
        versions: {
          transport: compatibility.providerVersion,
          schema: compatibility.schemaSet,
          fixtureSet: compatibility.fixtureSet,
        },
      },
    });
  });

  it.each([undefined, '2.1.229'])(
    'downgrades supported claims to unknown without matching version evidence (%s)',
    (version) => {
      const providerStatus = status('claude', version);
      const records = legacyCapabilityRecords(providerStatus);
      const supportedClaim = records.find((record) => record.id === 'session.cancel');
      const explicitUnsupported = records.find((record) => record.id === 'session.resume');

      expect(supportedClaim).toMatchObject({
        support: 'unknown',
        evidence: [],
        reason: 'no compatibility fixture matches this provider version and transport',
      });
      expect(explicitUnsupported).toMatchObject({
        support: 'unsupported',
        evidence: [],
        reason: 'legacy adapter reports this capability as unsupported',
      });
      expect(legacyRuntimeScope(providerStatus).versions).toEqual({
        adapterContract: '2',
        transport: version ?? 'unknown',
        runtime: process.version,
        fixtureSet: UNVERIFIED_PROVIDER_FIXTURE_SET,
      });
    },
  );

  it('does not let a Codex prerelease inherit stable fixture evidence', () => {
    const supportedClaim = legacyCapabilityRecords(status('codex', '0.147.0-alpha.1')).find(
      (record) => record.id === 'session.cancel',
    );

    expect(supportedClaim).toMatchObject({
      support: 'unknown',
      evidence: [],
      reason: 'no compatibility fixture matches this provider version and transport',
    });
  });
});
