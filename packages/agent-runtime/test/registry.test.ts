import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../src/registry.js';
import { FAKE_PROVIDER_CAPABILITIES, FakeProvider } from '../src/providers/fake/adapter.js';

describe('ProviderRegistry', () => {
  it('registers and retrieves providers by id', () => {
    const registry = new ProviderRegistry();
    const claude = new FakeProvider('claude');
    registry.register(claude);
    expect(registry.get('claude')).toBe(claude);
    expect(registry.get('codex')).toBeUndefined();
  });

  it('lists all registered providers', () => {
    const registry = new ProviderRegistry();
    registry.register(new FakeProvider('claude'));
    registry.register(new FakeProvider('codex'));
    expect(registry.list().map((p) => p.id).sort()).toEqual(['claude', 'codex']);
  });

  it('detectAll runs detect() on every provider', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new FakeProvider('claude', {
        id: 'claude',
        name: 'Claude',
        installed: true,
        authenticated: true,
        capabilities: FAKE_PROVIDER_CAPABILITIES,
      }),
    );
    registry.register(
      new FakeProvider('codex', {
        id: 'codex',
        name: 'Codex',
        installed: false,
        authenticated: 'unknown',
        capabilities: FAKE_PROVIDER_CAPABILITIES,
      }),
    );
    const statuses = await registry.detectAll();
    expect(statuses).toHaveLength(2);
    expect(statuses.find((s) => s.id === 'codex')?.installed).toBe(false);
  });
});
