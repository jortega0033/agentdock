import { describe, expect, it } from 'vitest';
import { isLiveProviderSmokeEnabled, LIVE_PROVIDER_SMOKE_ENV_VAR } from '../../src/live-smoke/opt-in.js';

describe('isLiveProviderSmokeEnabled', () => {
  it('is disabled when the env var is unset', () => {
    expect(isLiveProviderSmokeEnabled({})).toBe(false);
  });

  it('is disabled for any value other than the exact string "1"', () => {
    expect(isLiveProviderSmokeEnabled({ [LIVE_PROVIDER_SMOKE_ENV_VAR]: 'true' })).toBe(false);
    expect(isLiveProviderSmokeEnabled({ [LIVE_PROVIDER_SMOKE_ENV_VAR]: 'yes' })).toBe(false);
    expect(isLiveProviderSmokeEnabled({ [LIVE_PROVIDER_SMOKE_ENV_VAR]: '' })).toBe(false);
  });

  it('is enabled only for the exact string "1"', () => {
    expect(isLiveProviderSmokeEnabled({ [LIVE_PROVIDER_SMOKE_ENV_VAR]: '1' })).toBe(true);
  });
});
