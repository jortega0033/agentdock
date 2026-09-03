import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_NODE_RANGE,
  buildReport,
  isNodeVersionSupported,
  parseActivePnpmVersion,
  parseDeclaredPnpmVersion,
  parseSemver,
  pnpmVersionMatches,
} from '../../../scripts/preflight.mjs';

describe('parseSemver', () => {
  it('parses a v-prefixed Node version', () => {
    expect(parseSemver('v20.11.0')).toEqual({ major: 20, minor: 11, patch: 0 });
  });

  it('parses a bare version, including pre-release/build suffixes', () => {
    expect(parseSemver('10.29.2')).toEqual({ major: 10, minor: 29, patch: 2 });
    expect(parseSemver('10.29.2-beta.1')).toEqual({ major: 10, minor: 29, patch: 2 });
  });

  it('returns undefined for garbage input', () => {
    expect(parseSemver('not-a-version')).toBeUndefined();
    expect(parseSemver(undefined)).toBeUndefined();
    expect(parseSemver('')).toBeUndefined();
  });
});

describe('isNodeVersionSupported', () => {
  it('accepts every major in the declared range, using the module default', () => {
    expect(isNodeVersionSupported('v20.0.0')).toBe(true);
    expect(isNodeVersionSupported('v20.19.4')).toBe(true);
    expect(isNodeVersionSupported('v22.11.0')).toBe(true);
  });

  it('rejects a major below the range', () => {
    expect(isNodeVersionSupported('v18.20.0')).toBe(false);
  });

  it('rejects a major at or above the exclusive upper bound', () => {
    expect(isNodeVersionSupported('v23.0.0')).toBe(false);
    expect(isNodeVersionSupported('v25.5.0')).toBe(false);
  });

  it('respects a custom range', () => {
    expect(isNodeVersionSupported('v24.0.0', { minMajor: 20, maxMajorExclusive: 25 })).toBe(true);
  });

  it('rejects unparseable input', () => {
    expect(isNodeVersionSupported('not-a-version')).toBe(false);
  });

  it('exposes the exact range the rest of the module defaults to', () => {
    expect(SUPPORTED_NODE_RANGE).toEqual({ minMajor: 20, maxMajorExclusive: 23 });
  });
});

describe('parseActivePnpmVersion', () => {
  it('extracts the version pnpm puts at the front of npm_config_user_agent', () => {
    expect(parseActivePnpmVersion('pnpm/10.29.2 npm/? node/v22.11.0 win32 x64')).toBe('10.29.2');
  });

  it('returns undefined when the user agent is missing or from a different tool', () => {
    expect(parseActivePnpmVersion(undefined)).toBeUndefined();
    expect(parseActivePnpmVersion('npm/10.2.0 node/v22.11.0 win32 x64')).toBeUndefined();
    expect(parseActivePnpmVersion('yarn/1.22.19 npm/? node/v22.11.0 win32 x64')).toBeUndefined();
  });
});

describe('parseDeclaredPnpmVersion', () => {
  it('extracts the version from a "pnpm@<version>" packageManager field', () => {
    expect(parseDeclaredPnpmVersion('pnpm@10.29.2')).toBe('10.29.2');
  });

  it('returns undefined for a non-pnpm or malformed field', () => {
    expect(parseDeclaredPnpmVersion('yarn@4.0.0')).toBeUndefined();
    expect(parseDeclaredPnpmVersion(undefined)).toBeUndefined();
  });
});

describe('pnpmVersionMatches', () => {
  it('matches on exact major/minor/patch', () => {
    expect(pnpmVersionMatches('10.29.2', '10.29.2')).toBe(true);
  });

  it('rejects any component mismatch', () => {
    expect(pnpmVersionMatches('10.29.1', '10.29.2')).toBe(false);
    expect(pnpmVersionMatches('9.29.2', '10.29.2')).toBe(false);
    expect(pnpmVersionMatches(undefined, '10.29.2')).toBe(false);
  });
});

describe('buildReport', () => {
  it('reports ok and no fixes when Node and pnpm both match', () => {
    const report = buildReport({
      nodeVersion: 'v20.11.0',
      userAgent: 'pnpm/10.29.2 npm/? node/v20.11.0 linux x64',
      declaredPnpmField: 'pnpm@10.29.2',
      platform: 'linux',
      arch: 'x64',
    });
    expect(report.ok).toBe(true);
    expect(report.fixes).toEqual([]);
    expect(report.lines[0]).toContain('supported');
    expect(report.lines[1]).toContain('matches packageManager');
  });

  it('reports the exact real-world failure this issue was filed for: a Node release with no active pnpm detected', () => {
    const report = buildReport({
      nodeVersion: 'v25.5.0',
      userAgent: undefined,
      declaredPnpmField: 'pnpm@10.29.2',
      platform: 'win32',
      arch: 'x64',
    });
    expect(report.ok).toBe(false);
    expect(report.lines[0]).toContain('UNSUPPORTED');
    expect(report.fixes.join('\n')).toContain('Unsupported Node version');
    expect(report.fixes.join('\n')).toContain('corepack enable');
    expect(report.fixes.join('\n')).toContain('npm install -g corepack');
    expect(report.fixes.join('\n')).toContain('npm install -g pnpm@10.29.2');
  });

  it('flags only the pnpm mismatch when Node is supported but pnpm drifted', () => {
    const report = buildReport({
      nodeVersion: 'v22.11.0',
      userAgent: 'pnpm/9.1.0 npm/? node/v22.11.0 darwin arm64',
      declaredPnpmField: 'pnpm@10.29.2',
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(report.ok).toBe(false);
    expect(report.lines[0]).toContain('supported');
    expect(report.fixes).toHaveLength(1);
    expect(report.fixes[0]).toContain('9.1.0');
    expect(report.fixes[0]).toContain('10.29.2');
  });
});
