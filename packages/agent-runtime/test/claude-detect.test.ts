import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseClaudeAuthSource, parseClaudeAuthStatus } from '../src/providers/claude/detect.js';

describe('parseClaudeAuthStatus — pure parser (AD-16)', () => {
  it('returns "authenticated" for { loggedIn: true }', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true }))).toBe('authenticated');
  });

  it('returns "unauthenticated" for { loggedIn: false }', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }))).toBe('unauthenticated');
  });

  it('returns "unknown" for malformed JSON', () => {
    expect(parseClaudeAuthStatus('{not valid json')).toBe('unknown');
  });

  it('returns "unknown" for empty output', () => {
    expect(parseClaudeAuthStatus('')).toBe('unknown');
  });

  it('returns "unknown" when loggedIn is missing entirely', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ authMethod: 'claude.ai' }))).toBe('unknown');
  });

  it('returns "unknown" when loggedIn is present but not a boolean — never guesses truthy/falsy', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: 'yes' }))).toBe('unknown');
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: 1 }))).toBe('unknown');
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: null }))).toBe('unknown');
  });

  it('returns "unknown" for valid JSON that is not an object (e.g. a bare array or string)', () => {
    expect(parseClaudeAuthStatus('[]')).toBe('unknown');
    expect(parseClaudeAuthStatus('"just a string"')).toBe('unknown');
  });

  it('tolerates unrecognized extra fields alongside a valid loggedIn', () => {
    expect(
      parseClaudeAuthStatus(
        JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', extra: { nested: 1 } }),
      ),
    ).toBe('authenticated');
  });
});

describe('parseClaudeAuthSource — bounded non-secret label', () => {
  it.each([
    ['claude.ai', 'claude_subscription'],
    ['apiKey', 'api_key'],
    ['console API key', 'api_key'],
    ['Bedrock', 'bedrock'],
    ['Vertex AI', 'vertex'],
    ['Azure Foundry', 'foundry'],
  ] as const)('maps %s to %s', (authMethod, expected) => {
    expect(parseClaudeAuthSource(JSON.stringify({ loggedIn: true, authMethod }))).toBe(expected);
  });

  it('never projects a value from unauthenticated, malformed, or unrecognized output', () => {
    expect(
      parseClaudeAuthSource(JSON.stringify({ loggedIn: false, authMethod: 'claude.ai' })),
    ).toBe('unknown');
    expect(
      parseClaudeAuthSource(JSON.stringify({ loggedIn: true, authMethod: 'secret-account' })),
    ).toBe('unknown');
    expect(parseClaudeAuthSource('not json')).toBe('unknown');
  });
});

describe('detectClaude — end-to-end failure paths (mocked exec, no real CLI)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reports "unknown" and installed:false when the executable cannot be found at all', async () => {
    vi.doMock('../src/detect-executable.js', () => ({ findExecutable: async () => null }));
    const { detectClaude } = await import('../src/providers/claude/detect.js');
    const status = await detectClaude({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({
      name: 'Claude Agent',
      installed: false,
      authenticated: 'unknown',
      authSource: 'unknown',
    });
  });

  it('reports "unknown" when --version exits non-zero', async () => {
    vi.doMock('../src/detect-executable.js', () => ({
      findExecutable: async () => '/usr/local/bin/claude',
    }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async () => ({
        code: 1,
        stdout: '',
        stderr: 'command not found',
        timedOut: false,
      }),
    }));
    const { detectClaude } = await import('../src/providers/claude/detect.js');
    const status = await detectClaude({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({
      installed: true,
      authenticated: 'unknown',
      error: 'claude --version failed',
    });
  });

  it('reports "unknown" when the auth status check times out', async () => {
    vi.doMock('../src/detect-executable.js', () => ({
      findExecutable: async () => '/usr/local/bin/claude',
    }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: '2.1.228 (Claude Code)', stderr: '', timedOut: false }
          : { code: null, stdout: '', stderr: '', timedOut: true },
    }));
    const { detectClaude } = await import('../src/providers/claude/detect.js');
    const status = await detectClaude({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({
      installed: true,
      authenticated: 'unknown',
      error: 'auth status check timed out',
    });
  });

  it('reports "authenticated" end to end when both commands succeed with a logged-in response', async () => {
    vi.doMock('../src/detect-executable.js', () => ({
      findExecutable: async () => '/usr/local/bin/claude',
    }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: '2.1.228 (Claude Code)', stderr: '', timedOut: false }
          : {
              code: 0,
              stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
              stderr: '',
              timedOut: false,
            },
    }));
    const { detectClaude } = await import('../src/providers/claude/detect.js');
    const status = await detectClaude({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({
      name: 'Claude Agent',
      installed: true,
      authenticated: 'authenticated',
      authSource: 'claude_subscription',
      version: '2.1.228',
    });
  });

  it('probes --version and auth status with a sanitized environment, never the daemon\'s full process.env (issue #53)', async () => {
    process.env.AGENT_DOCK_ENV_ISOLATION_TEST_CANARY = 'CANARY-do-not-leak';
    try {
      vi.doMock('../src/detect-executable.js', () => ({
        findExecutable: async () => '/usr/local/bin/claude',
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
            ? { code: 0, stdout: '2.1.228 (Claude Code)', stderr: '', timedOut: false }
            : {
                code: 0,
                stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
                stderr: '',
                timedOut: false,
              };
        },
      }));
      const { detectClaude } = await import('../src/providers/claude/detect.js');
      await detectClaude({ debug() {}, info() {}, warn() {}, error() {} });

      expect(capturedEnvs).toHaveLength(2); // --version, then auth status
      for (const env of capturedEnvs) {
        expect(env).not.toHaveProperty('AGENT_DOCK_ENV_ISOLATION_TEST_CANARY');
        expect(env?.PATH ?? (env as Record<string, string> | undefined)?.Path).toBeDefined();
      }
    } finally {
      delete process.env.AGENT_DOCK_ENV_ISOLATION_TEST_CANARY;
    }
  });

  it('reports "unknown" with an error when the auth status output is unparseable garbage', async () => {
    vi.doMock('../src/detect-executable.js', () => ({
      findExecutable: async () => '/usr/local/bin/claude',
    }));
    vi.doMock('../src/process/exec-capture.js', () => ({
      execCapture: async (_cmd: string, args: string[]) =>
        args.includes('--version')
          ? { code: 0, stdout: '2.1.228', stderr: '', timedOut: false }
          : { code: 0, stdout: 'not json at all', stderr: '', timedOut: false },
    }));
    const { detectClaude } = await import('../src/providers/claude/detect.js');
    const status = await detectClaude({ debug() {}, info() {}, warn() {}, error() {} });
    expect(status).toMatchObject({
      installed: true,
      authenticated: 'unknown',
      error: 'could not parse claude auth status output',
    });
  });
});
