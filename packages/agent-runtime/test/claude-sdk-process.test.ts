import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeSdkManagedProcessSpawner } from '../src/providers/claude/sdk-process.js';
import type {
  SpawnOptions as ProcessSpawnOptions,
  SpawnResult,
} from '../src/process/spawn-process.js';

const executable = 'C:\\agent-dock\\claude.exe';
const cwd = 'C:\\workspace';

describe('Claude SDK managed process seam', () => {
  it('pins command and cwd, preserves only validated auth, and force-closes then reaps', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let settle!: () => void;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      settle = () => resolve({ code: null, signal: 'SIGKILL' });
    });
    const kill = vi.fn(async () => settle());
    const spawn = vi.fn((): SpawnResult => ({
      child: { stdin, stdout, stderr, kill: vi.fn(() => true) },
      exit,
      kill,
    }));
    const make = createClaudeSdkManagedProcessSpawner({
      executable,
      cwd,
      authSource: 'api_key',
      expectedEnvironment: { ANTHROPIC_API_KEY: 'key' },
      runtimePlatform: 'win32',
      spawn: spawn as never,
    });
    const controller = new AbortController();
    const managed = make({
      command: executable.toUpperCase(),
      args: ['--print'],
      cwd: cwd.toUpperCase(),
      env: { ANTHROPIC_API_KEY: 'key' },
      signal: controller.signal,
    });
    expect(spawn).toHaveBeenCalledWith(
      executable,
      ['--print'],
      expect.objectContaining({ cwd, env: { ANTHROPIC_API_KEY: 'key' }, platform: 'win32' }),
    );
    await managed.forceClose();
    await managed.reaped;
    expect(kill).toHaveBeenCalledOnce();
    expect(managed.process.killed).toBe(true);
  });

  it('rejects an SDK attempt to substitute command, cwd, or authentication', () => {
    const spawn = vi.fn();
    const make = createClaudeSdkManagedProcessSpawner({
      executable,
      cwd,
      authSource: 'api_key',
      expectedEnvironment: { ANTHROPIC_API_KEY: 'key' },
      runtimePlatform: 'win32',
      spawn: spawn as never,
    });
    const signal = new AbortController().signal;
    expect(() =>
      make({ command: 'C:\\other.exe', args: [], cwd, env: { ANTHROPIC_API_KEY: 'key' }, signal }),
    ).toThrow(/pinned executable/);
    expect(() =>
      make({
        command: executable,
        args: [],
        cwd: 'C:\\other',
        env: { ANTHROPIC_API_KEY: 'key' },
        signal,
      }),
    ).toThrow(/pinned workspace/);
    expect(() =>
      make({ command: executable, args: [], cwd, env: { ANTHROPIC_API_KEY: 'other-key' }, signal }),
    ).toThrow(/authentication scope changed/);
    expect(() =>
      make({ command: executable, args: [], cwd, env: { CLAUDE_CODE_USE_BEDROCK: '1' }, signal }),
    ).toThrow(/authentication scope changed/);
    expect(() =>
      make({
        command: executable,
        args: [],
        cwd,
        env: {
          ANTHROPIC_API_KEY: 'key',
          CLAUDE_CODE_API_KEY_HELPER: 'reinjected-wrapper-canary',
        },
        signal,
      }),
    ).toThrow(/authentication scope changed/);
    expect(() =>
      make({
        command: executable,
        args: [],
        cwd,
        env: {
          ANTHROPIC_API_KEY: 'key',
          CLAUDE_SECURESTORAGE_CONFIG_DIR: 'reinjected-config-canary',
        },
        signal,
      }),
    ).toThrow(/authentication scope changed/);
    expect(() =>
      make({
        command: executable,
        args: [],
        cwd,
        env: { ANTHROPIC_API_KEY: 'key', CLAUDE_AGENT_SDK_VERSION: 'unreviewed-version' },
        signal,
      }),
    ).toThrow(/authentication scope changed/);
    expect(() =>
      make({
        command: executable,
        args: [],
        cwd,
        env: { ANTHROPIC_API_KEY: 'key', ANTHROPIC_VERTEX_BASE_URL: 'gateway-canary' },
        signal,
      }),
    ).toThrow(/authentication scope changed/);
    expect(() =>
      make({
        command: executable,
        args: [],
        cwd,
        env: { ANTHROPIC_API_KEY: 'key', NODE_OPTIONS: '--require=attacker.js' },
        signal,
      }),
    ).toThrow(/authentication scope changed/);
    expect(() =>
      make({
        command: executable,
        args: [],
        cwd,
        env: { ANTHROPIC_API_KEY: 'key', UNRELATED_SECRET: 'secret-canary' },
        signal,
      }),
    ).toThrow(/authentication scope changed/);
    expect(() =>
      make({
        command: executable,
        args: [],
        cwd,
        env: { ANTHROPIC_API_KEY: 'key', anthropic_api_key: 'key' },
        signal,
      }),
    ).toThrow(/authentication scope changed/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    {
      authSource: 'api_key' as const,
      expectedEnvironment: {
        ANTHROPIC_API_KEY: 'key',
        PATH: 'C:\\Windows\\System32',
        HOME: 'C:\\Users\\safe',
      },
      changedKey: 'PATH',
    },
    {
      authSource: 'api_key' as const,
      expectedEnvironment: {
        ANTHROPIC_API_KEY: 'key',
        PATH: 'C:\\Windows\\System32',
        HOME: 'C:\\Users\\safe',
      },
      changedKey: 'HOME',
    },
    {
      authSource: 'bedrock' as const,
      expectedEnvironment: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1' },
      changedKey: 'AWS_REGION',
    },
    {
      authSource: 'vertex' as const,
      expectedEnvironment: {
        CLAUDE_CODE_USE_VERTEX: '1',
        GOOGLE_CLOUD_PROJECT: 'safe-project',
      },
      changedKey: 'GOOGLE_CLOUD_PROJECT',
    },
    {
      authSource: 'foundry' as const,
      expectedEnvironment: {
        CLAUDE_CODE_USE_FOUNDRY: '1',
        AZURE_CLIENT_ID: 'safe-client',
      },
      changedKey: 'AZURE_CLIENT_ID',
    },
  ])('rejects a changed $changedKey value', ({ authSource, expectedEnvironment, changedKey }) => {
    const spawn = vi.fn();
    const make = createClaudeSdkManagedProcessSpawner({
      executable,
      cwd,
      authSource,
      expectedEnvironment,
      runtimePlatform: 'win32',
      spawn: spawn as never,
    });
    const changedEnvironment = { ...expectedEnvironment, [changedKey]: 'attacker-value' };

    expect(() =>
      make({
        command: executable,
        args: [],
        cwd,
        env: changedEnvironment,
        signal: new AbortController().signal,
      }),
    ).toThrow(/authentication scope changed/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('snapshots the expected environment and spawns only the sanitized copy', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const expectedEnvironment: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'key',
    };
    let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
    const spawn = vi.fn(
      (_command: string, _args: string[], options: ProcessSpawnOptions): SpawnResult => {
        spawnedEnvironment = options.env;
        return {
          child: { stdin, stdout, stderr, kill: vi.fn(() => true) },
          exit: Promise.resolve({ code: 0, signal: null }),
          kill: vi.fn(async () => undefined),
        };
      },
    );
    const make = createClaudeSdkManagedProcessSpawner({
      executable,
      cwd,
      authSource: 'api_key',
      expectedEnvironment,
      runtimePlatform: 'win32',
      spawn: spawn as never,
    });
    expectedEnvironment.NODE_OPTIONS = '--require=attacker.js';
    const sdkEnvironment = { ANTHROPIC_API_KEY: 'key' };

    make({
      command: executable,
      args: [],
      cwd,
      env: sdkEnvironment,
      signal: new AbortController().signal,
    });

    expect(spawnedEnvironment).toEqual({ ANTHROPIC_API_KEY: 'key' });
    expect(spawnedEnvironment).not.toBe(sdkEnvironment);
  });
});
