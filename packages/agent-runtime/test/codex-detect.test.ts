import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCodexLoginStatus, parseCodexVersion } from '../src/providers/codex/detect.js';

describe('parseCodexVersion', () => {
  it('preserves stable and prerelease versions exactly', () => {
    expect(parseCodexVersion('codex-cli 0.147.0')).toBe('0.147.0');
    expect(parseCodexVersion('codex-cli 0.147.0-alpha.1+build.7')).toBe('0.147.0-alpha.1+build.7');
    expect(parseCodexVersion('codex-cli unknown')).toBeUndefined();
  });
});

describe('parseCodexLoginStatus — pure parser (AD-16)', () => {
  it('returns "authenticated" for a real "Logged in using ChatGPT" line', () => {
    expect(parseCodexLoginStatus('Logged in using ChatGPT')).toBe('authenticated');
  });

  it('returns "authenticated" for "Logged in using API key"', () => {
    expect(parseCodexLoginStatus('Logged in using API key')).toBe('authenticated');
  });

  it('returns "unauthenticated" for "Not logged in"', () => {
    expect(parseCodexLoginStatus('Not logged in')).toBe('unauthenticated');
  });

  it('returns "unauthenticated" for "Not authenticated" / "No credentials found" variants', () => {
    expect(parseCodexLoginStatus('Not authenticated. Run `codex login` first.')).toBe(
      'unauthenticated',
    );
    expect(parseCodexLoginStatus('No credentials found.')).toBe('unauthenticated');
  });

  it('does not fall into the substring trap: "Not logged in" must not match the "logged in" positive check', () => {
    expect(parseCodexLoginStatus('Not logged in')).not.toBe('authenticated');
  });

  it('returns "unknown" for empty output', () => {
    expect(parseCodexLoginStatus('')).toBe('unknown');
  });

  it('returns "unknown" for unexpected/unrecognized output', () => {
    expect(parseCodexLoginStatus('codex: unrecognized subcommand "status"')).toBe('unknown');
    expect(parseCodexLoginStatus('some future wording this parser has never seen')).toBe('unknown');
  });
});

describe('detectCodex — end-to-end failure paths (mocked exec, no real CLI)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reports "unknown" and installed:false when the executable cannot be found at all', async () => {
    vi.doMock('../src/detect-executable.js', () => ({ findExecutable: async () => null }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({ installed: false, authenticated: 'unknown' });
  });

  it('reports "unknown" when --version exits non-zero', async () => {
    vi.doMock('../src/detect-executable.js', () => ({
      findExecutable: async () => '/usr/local/bin/codex',
    }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async () => ({ code: 1, stdout: '', stderr: 'not found', timedOut: false }),
    }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({
      installed: true,
      authenticated: 'unknown',
      error: 'codex --version failed',
    });
  });

  it('reports "unknown" when the login status check times out', async () => {
    vi.doMock('../src/detect-executable.js', () => ({
      findExecutable: async () => '/usr/local/bin/codex',
    }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '', timedOut: false }
          : { code: null, stdout: '', stderr: '', timedOut: true },
    }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({
      installed: true,
      authenticated: 'unknown',
      error: 'login status check timed out',
    });
  });

  it('reports "authenticated" end to end when both commands succeed with a logged-in line', async () => {
    vi.doMock('../src/detect-executable.js', () => ({
      findExecutable: async () => '/usr/local/bin/codex',
    }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '', timedOut: false }
          : { code: 0, stdout: 'Logged in using ChatGPT', stderr: '', timedOut: false },
    }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({
      installed: true,
      authenticated: 'authenticated',
      version: '0.147.0',
    });
  });

  it('reports "unauthenticated" end to end for a clean not-logged-in response', async () => {
    vi.doMock('../src/detect-executable.js', () => ({
      findExecutable: async () => '/usr/local/bin/codex',
    }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '', timedOut: false }
          : { code: 0, stdout: 'Not logged in', stderr: '', timedOut: false },
    }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({ installed: true, authenticated: 'unauthenticated' });
  });
});
