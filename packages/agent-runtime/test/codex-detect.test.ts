import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseCodexAuthSource,
  parseCodexLoginStatus,
  parseCodexVersion,
} from '../src/providers/codex/detect.js';

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

describe('parseCodexAuthSource', () => {
  it('returns only the non-secret runtime-owned account source', () => {
    expect(parseCodexAuthSource('Logged in using ChatGPT')).toBe('chatgpt');
    expect(parseCodexAuthSource('Logged in using API key')).toBe('api_key');
    expect(parseCodexAuthSource('Not logged in')).toBe('unknown');
    expect(parseCodexAuthSource('Logged in as person@example.test')).toBe('unknown');
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

  it('probes --version and login status with a sanitized environment, never the daemon\'s full process.env (issue #53)', async () => {
    process.env.AGENT_DOCK_ENV_ISOLATION_TEST_CANARY = 'CANARY-do-not-leak';
    try {
      vi.doMock('../src/detect-executable.js', () => ({
        findExecutable: async () => '/usr/local/bin/codex',
      }));
      const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
      vi.doMock('../src/process/exec-capture.js', () => ({
        execCapture: async (
          _cmd: string,
          args: string[],
          opts: { env?: NodeJS.ProcessEnv },
        ) => {
          capturedEnvs.push(opts.env);
          return args.includes('--version')
            ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '', timedOut: false }
            : { code: 0, stdout: 'Logged in using ChatGPT', stderr: '', timedOut: false };
        },
      }));
      const { detectCodex } = await import('../src/providers/codex/detect.js');
      await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });

      expect(capturedEnvs).toHaveLength(2); // --version, then login status
      for (const env of capturedEnvs) {
        expect(env).not.toHaveProperty('AGENT_DOCK_ENV_ISOLATION_TEST_CANARY');
        expect(env?.PATH ?? (env as Record<string, string> | undefined)?.Path).toBeDefined();
      }
    } finally {
      delete process.env.AGENT_DOCK_ENV_ISOLATION_TEST_CANARY;
    }
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
      authSource: 'chatgpt',
      version: '0.147.0',
    });
  });

  it('adds fallback scope evidence only through a trusted read-only production probe', async () => {
    const accountFingerprint = 'a'.repeat(64);
    const probe = vi.fn(async () => ({ accountFingerprint, selectedModel: 'gpt-5.4' }));
    vi.doMock('../src/detect-executable.js', () => ({
      findExecutable: async () => '/usr/local/bin/codex',
    }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: 'codex-cli 0.999.0', stderr: '', timedOut: false }
          : {
              code: 0,
              stdout: 'Logged in using ChatGPT',
              stderr: '',
              timedOut: false,
            },
    }));
    vi.doMock('../src/providers/codex/app-server/scope-probe.js', () => ({
      probeCodexAppServerScope: probe,
    }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex(
      { debug() {}, info() {}, warn() {}, error() {} },
      {
        cwd: '/trusted/workspace',
        includeLaunchScopeEvidence: true,
        workspaceTrust: {
          state: 'trusted',
          workspaceId: 'workspace-id',
          incarnation: 'incarnation',
          trustEpoch: 7,
        },
      },
    );

    expect(status).toMatchObject({
      executablePath: '/usr/local/bin/codex',
      version: '0.999.0',
      authenticated: 'authenticated',
      authSource: 'chatgpt',
      accountFingerprint,
      selectedModel: 'gpt-5.4',
    });
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: '/usr/local/bin/codex',
        cwd: '/trusted/workspace',
        providerStatus: expect.objectContaining({
          authSource: 'chatgpt',
          version: '0.999.0',
        }),
      }),
    );

    probe.mockClear();
    const normalSupportedStatus = await detectCodex(
      { debug() {}, info() {}, warn() {}, error() {} },
      {
        cwd: '/trusted/workspace',
        workspaceTrust: {
          state: 'trusted',
          workspaceId: 'workspace-id',
          incarnation: 'incarnation',
          trustEpoch: 7,
        },
      },
    );
    expect(probe).not.toHaveBeenCalled();
    expect(normalSupportedStatus.accountFingerprint).toBeUndefined();
    expect(normalSupportedStatus.selectedModel).toBeUndefined();
  });

  it('does not trust logged-in text from a non-zero login status result', async () => {
    vi.doMock('../src/detect-executable.js', () => ({
      findExecutable: async () => '/usr/local/bin/codex',
    }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '', timedOut: false }
          : {
              code: 1,
              stdout: 'Logged in using ChatGPT',
              stderr: 'status failed',
              timedOut: false,
            },
    }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({
      installed: true,
      authenticated: 'unknown',
      authSource: 'unknown',
      error: 'codex login status failed',
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

  it('does not expose unrecognized successful login output', async () => {
    const canary = 'sk-proj-CREDENTIAL_CANARY_login_status';
    vi.doMock('../src/detect-executable.js', () => ({
      findExecutable: async () => '/usr/local/bin/codex',
    }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: 'codex-cli 0.147.0', stderr: '', timedOut: false }
          : {
              code: 0,
              stdout: `future login response ${canary}`,
              stderr: 'RAW_APPROVAL_CANARY_login_status',
              timedOut: false,
            },
    }));
    const { detectCodex } = await import('../src/providers/codex/detect.js');
    const status = await detectCodex({ debug() {}, info() {}, warn() {}, error() {} });

    expect(status).toMatchObject({
      installed: true,
      authenticated: 'unknown',
      authSource: 'unknown',
      error: 'could not determine codex login status',
    });
    expect(JSON.stringify(status)).not.toContain(canary);
    expect(JSON.stringify(status)).not.toContain('RAW_APPROVAL_CANARY_login_status');
  });
});
