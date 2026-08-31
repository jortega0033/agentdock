import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { spawnProcess, type SpawnResult } from '../../process/spawn-process.js';
import type { ClaudeAgentSdkManagedSpawn } from './sdk/index.js';
import { resolveClaudeSdkAuth, type ClaudeSdkAuthSource } from './sdk-auth.js';

export interface ClaudeSdkManagedSpawnerOptions {
  executable: string;
  cwd: string;
  authSource: ClaudeSdkAuthSource;
  expectedEnvironment: Readonly<Record<string, string | undefined>>;
  runtimePlatform?: NodeJS.Platform;
  spawn?: typeof spawnProcess;
}

function exactEnvironmentMatches(
  actual: Readonly<Record<string, string | undefined>>,
  expected: Readonly<Record<string, string | undefined>>,
): boolean {
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  if (actualEntries.length !== expectedEntries.length) return false;
  const normalizedKeys = new Set<string>();
  for (const [key, value] of actualEntries) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKeys.has(normalizedKey) || !Object.hasOwn(expected, key)) return false;
    normalizedKeys.add(normalizedKey);
    if (expected[key] !== value) return false;
  }
  return true;
}

function comparablePath(path: string, platform: NodeJS.Platform): string {
  const absolute = resolve(path);
  return platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function sameClaudeSdkPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return comparablePath(left, platform) === comparablePath(right, platform);
}

class ClaudeSdkSpawnedProcess implements SpawnedProcess {
  private readonly emitter = new EventEmitter();
  private killedValue = false;
  private exitCodeValue: number | null = null;
  private signalCodeValue: NodeJS.Signals | null = null;

  readonly stdin: SpawnedProcess['stdin'];
  readonly stdout: SpawnedProcess['stdout'];

  constructor(private readonly spawned: SpawnResult) {
    this.stdin = spawned.child.stdin;
    this.stdout = spawned.child.stdout;
    // SDK custom spawners own stderr. Drain it without decoding, retaining, or logging it.
    spawned.child.stderr.resume();
    void spawned.exit.then(({ code, signal }) => {
      this.exitCodeValue = code;
      this.signalCodeValue = signal;
      this.emitter.emit('exit', code, signal);
    });
  }

  get killed(): boolean {
    return this.killedValue;
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.signalCodeValue;
  }

  kill(signal: NodeJS.Signals): boolean {
    const killed = this.spawned.child.kill(signal);
    this.killedValue ||= killed;
    return killed;
  }

  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(
    event: 'exit' | 'error',
    listener:
      ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void),
  ): void {
    this.emitter.on(event, listener);
  }

  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(
    event: 'exit' | 'error',
    listener:
      ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void),
  ): void {
    this.emitter.once(event, listener);
  }

  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
  off(
    event: 'exit' | 'error',
    listener:
      ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void),
  ): void {
    this.emitter.off(event, listener);
  }

  async forceClose(): Promise<void> {
    this.killedValue = true;
    await this.spawned.kill();
  }
}

/** Adapts the daemon-owned Job Object/process-group host to the SDK's custom spawn contract. */
export function createClaudeSdkManagedProcessSpawner(
  input: ClaudeSdkManagedSpawnerOptions,
): (options: SpawnOptions) => ClaudeAgentSdkManagedSpawn {
  const platform = input.runtimePlatform ?? process.platform;
  const spawn = input.spawn ?? spawnProcess;
  // Snapshot before handing the SDK its options object. The SDK must not be able to mutate the
  // reference that defines the daemon-approved process environment.
  const expectedEnvironment = { ...input.expectedEnvironment };
  return (options) => {
    if (!sameClaudeSdkPath(options.command, input.executable, platform)) {
      throw new Error('Claude SDK attempted to replace its pinned executable');
    }
    if (!options.cwd || !sameClaudeSdkPath(options.cwd, input.cwd, platform)) {
      throw new Error('Claude SDK attempted to replace its pinned workspace');
    }
    const auth = resolveClaudeSdkAuth(options.env);
    if (
      !auth.eligible ||
      auth.source !== input.authSource ||
      !exactEnvironmentMatches(options.env, expectedEnvironment)
    ) {
      throw new Error('Claude SDK process authentication scope changed');
    }

    const spawned = spawn(input.executable, options.args, {
      cwd: input.cwd,
      env: { ...expectedEnvironment },
      platform,
    });
    const process = new ClaudeSdkSpawnedProcess(spawned);
    const forceClose = async (): Promise<void> => process.forceClose();
    const abort = (): void => {
      void forceClose().catch(() => undefined);
    };
    options.signal.addEventListener('abort', abort, { once: true });
    const reaped = spawned.exit.then(() => {
      options.signal.removeEventListener('abort', abort);
    });
    return { process, forceClose, reaped };
  };
}
