import { describe, expect, it } from 'vitest';
import { checkVersionSupported } from '../../src/live-smoke/version-gate.js';

describe('checkVersionSupported', () => {
  it('supports an exact match against the pinned version', () => {
    expect(checkVersionSupported('2.1.228', '2.1.228')).toEqual({ supported: true });
  });

  it('treats a version mismatch as unsupported/stale, never a false pass', () => {
    const result = checkVersionSupported('2.1.229', '2.1.228');
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toContain('2.1.229');
  });

  it('treats a missing detected version as unsupported', () => {
    const result = checkVersionSupported(undefined, '2.1.228');
    expect(result.supported).toBe(false);
  });
});
