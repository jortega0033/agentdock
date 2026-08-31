import { describe, expect, it } from 'vitest';
import {
  CLAUDE_LEGACY_COMPATIBILITY,
  CODEX_LEGACY_COMPATIBILITY,
  FAKE_INTERACTIVE_COMPATIBILITY,
  PROVIDER_COMPATIBILITY_MANIFEST,
  PROVIDER_FIXTURE_SCHEMA_SET,
  findProviderCompatibility,
} from '../src/providers/compatibility-manifest.js';
import { FakeProvider } from '../src/providers/fake/adapter.js';

describe('provider compatibility manifest', () => {
  it('is immutable and resolves only exact provider/version/transport tuples', () => {
    expect(Object.isFrozen(PROVIDER_COMPATIBILITY_MANIFEST)).toBe(true);
    expect(PROVIDER_COMPATIBILITY_MANIFEST.every((entry) => Object.isFrozen(entry))).toBe(true);

    expect(findProviderCompatibility('claude', '2.1.228', 'legacy-one-shot')).toBe(
      CLAUDE_LEGACY_COMPATIBILITY,
    );
    expect(findProviderCompatibility('codex', '0.147.0', 'legacy-one-shot')).toBe(
      CODEX_LEGACY_COMPATIBILITY,
    );
    expect(findProviderCompatibility('claude', '2.1.229', 'legacy-one-shot')).toBeUndefined();
    expect(findProviderCompatibility('claude', undefined, 'legacy-one-shot')).toBeUndefined();
    expect(findProviderCompatibility('claude', '2.1.228', 'fake-interactive')).toBeUndefined();
  });

  it('pins one schema set and an accepted-work boundary for every entry', () => {
    expect(PROVIDER_COMPATIBILITY_MANIFEST).toHaveLength(3);
    for (const entry of PROVIDER_COMPATIBILITY_MANIFEST) {
      expect(entry.schemaSet).toBe(PROVIDER_FIXTURE_SCHEMA_SET);
      expect(entry.fixtureSet).toBeTruthy();
      expect(entry.acceptedWorkBoundary).toBeTruthy();
    }
  });

  it('derives fake interactive support metadata from its manifest entry', async () => {
    const provider = new FakeProvider('claude', undefined, 'success', 'multi-input');
    const support = provider.getV2Support(await provider.detect());
    const record = support?.capabilities[0];

    expect(support?.transports[0]?.id).toBe(FAKE_INTERACTIVE_COMPATIBILITY.transport);
    expect(record?.scope.versions).toMatchObject({
      transport: FAKE_INTERACTIVE_COMPATIBILITY.providerVersion,
      schema: FAKE_INTERACTIVE_COMPATIBILITY.schemaSet,
      fixtureSet: FAKE_INTERACTIVE_COMPATIBILITY.fixtureSet,
    });
    expect(record?.evidence).toContainEqual({
      kind: 'fixture',
      reference: FAKE_INTERACTIVE_COMPATIBILITY.fixtureSet,
    });
  });
});
