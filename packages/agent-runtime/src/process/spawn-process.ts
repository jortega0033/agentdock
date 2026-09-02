import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { encodeWindowsJobHostArguments, resolveWindowsJobHostPath } from './windows-job-host.js';
import { buildBaseProcessEnvironment } from './provider-environment.js';

export interface ProcessExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

type NativeProcess = ChildProcessByStdio<Writable, Readable, Readable>;

// The supervisor gives forceClose 5s. Keep verification inside that outer boundary.
const TREE_TERMINATION_TIMEOUT_MS = 4_000;
const POSIX_GRACE_MS = 250;
const PROCESS_GROUP_POLL_MS = 25;
const MAX_WINDOWS_HANDSHAKE_BYTES = 512;

export interface TerminateProcessTreeOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export interface SpawnResult {
  child: SpawnedProcess;
  exit: Promise<ProcessExitResult>;
  /** Kills the complete owned process tree and resolves only after its owner is reaped. */
  kill: () => Promise<void>;
}

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test/embedding seam. Production resolves the helper relative to the daemon bundle. */
  windowsJobHostPath?: string;
  /** Test seam only. */
  platform?: NodeJS.Platform;
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remainingMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

async function boundedUntil<T>(
  promise: Promise<T>,
  deadlineMs: number,
  message: string,
): Promise<T> {
  return bounded(promise, remainingMs(deadlineMs), message);
}

/**
 * Terminates a provider owner. On Windows the direct child is the shipped Job Host and closing
 * its sole KILL_ON_JOB_CLOSE handle is the kernel-owned tree boundary. POSIX retains the detached
 * process-group termination and verification path.
 */
export async function terminateProcessTree(
  child: SpawnedProcess,
  exit: Promise<ProcessExitResult>,
  isExited: () => boolean,
  options: TerminateProcessTreeOptions = {},
): Promise<void> {
  const deadlineMs = Date.now() + (options.timeoutMs ?? TREE_TERMINATION_TIMEOUT_MS);
  const platform = options.platform ?? process.platform;
  const pid = child.pid;

  if (platform === 'win32') {
    if (pid === undefined) throw new Error('Windows provider Job Host has no process id');
    // The helper is outside its unnamed Job Object and owns its only handle. Windows closes that
    // handle before reporting the helper exited, atomically terminating every owned descendant.
    if (!isExited()) child.kill('SIGKILL');
    await boundedUntil(exit, deadlineMs, 'Windows provider Job Host could not be confirmed reaped');
    return;
  }

  // A leader exit does not imply that its detached process group exited. Continue with the
  // process-group probe and kill path so descendants cannot outlive a naturally exiting leader.
  if (isExited() && pid === undefined) return;

  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  } else {
    child.kill('SIGTERM');
  }
  if (!isExited()) {
    await new Promise<void>((resolve) => setTimeout(resolve, POSIX_GRACE_MS));
  }
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      if (!isExited()) child.kill('SIGKILL');
    }
  } else if (!isExited()) {
    child.kill('SIGKILL');
  }
  try {
    await boundedUntil(exit, deadlineMs, 'provider process could not be confirmed reaped');
  } catch {
    if (!isExited()) child.kill('SIGKILL');
    await boundedUntil(exit, deadlineMs, 'provider process could not be confirmed reaped');
  }
  if (pid !== undefined && !(await waitForProcessGroupGone(pid, deadlineMs))) {
    throw new Error('POSIX provider process group could not be confirmed reaped');
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessGroupGone(pid: number, deadlineMs: number): Promise<boolean> {
  while (processGroupExists(pid)) {
    if (Date.now() >= deadlineMs) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_MS));
  }
  return true;
}

export function filterWindowsJobHostStderr(
  source: Readable,
  onInvalid: () => void = () => undefined,
): Readable {
  const output = new PassThrough();
  let handshake = Buffer.alloc(0);
  let state: 'pending' | 'ready' | 'blocked' = 'pending';

  source.on('data', (chunk: Buffer | string) => {
    if (state === 'ready') {
      output.write(chunk);
      return;
    }
    if (state === 'blocked') return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const combined = Buffer.concat([handshake, buffer]);
    const newline = combined.indexOf(0x0a);
    if (newline < 0 && combined.byteLength > MAX_WINDOWS_HANDSHAKE_BYTES) {
      // A shipped helper can only emit a short fixed control line before provider resume. Never
      // expose unexpected startup bytes because an executable error could contain launch values.
      state = 'blocked';
      handshake = Buffer.alloc(0);
      output.end();
      onInvalid();
      return;
    }
    if (newline < 0) {
      handshake = combined;
      return;
    }
    const controlLine = combined.subarray(0, newline + 1);
    const remainder = combined.subarray(newline + 1);
    handshake = Buffer.alloc(0);
    state = 'blocked';
    if (
      controlLine.byteLength <= MAX_WINDOWS_HANDSHAKE_BYTES &&
      /^ADJH\/1 READY [1-9]\d*\r?\n$/u.test(controlLine.toString('ascii'))
    ) {
      state = 'ready';
      if (remainder.byteLength > 0) output.write(remainder);
      return;
    }
    // Invalid/error control lines are fixed helper diagnostics. Suppress them so public provider
    // stderr remains provider-only and callers cannot accidentally surface launch configuration.
    output.end();
    onInvalid();
  });
  source.once('end', () => {
    if (state === 'pending') onInvalid();
    output.end();
  });
  source.once('error', () => {
    if (state === 'pending') onInvalid();
    output.end();
  });
  return output;
}

function publicWindowsProcess(child: NativeProcess): SpawnedProcess {
  const stderr = filterWindowsJobHostStderr(child.stderr, () => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr,
    get pid() {
      return child.pid;
    },
    kill: (signal) => child.kill(signal),
  };
}

/**
 * Spawns without shell interpolation. Windows launches every command atomically inside the
 * shipped Job Object host; POSIX launches the provider in its own process group.
 */
export function spawnProcess(command: string, args: string[], opts: SpawnOptions): SpawnResult {
  const platform = opts.platform ?? process.platform;
  const usesWindowsJobHost = platform === 'win32';
  const actualCommand = usesWindowsJobHost
    ? resolveWindowsJobHostPath(opts.windowsJobHostPath)
    : command;
  const actualArgs = usesWindowsJobHost
    ? encodeWindowsJobHostArguments({
        ownerPid: process.pid,
        executable: command,
        cwd: opts.cwd,
        args,
      })
    : args;
  const nativeChild = spawn(actualCommand, actualArgs, {
    cwd: opts.cwd,
    // Structural, not convention-dependent (issue #53): every caller of this shared low-level
    // primitive gets a sanitized floor by default, not the daemon's full process.env, even a
    // future one that forgets to pass an explicit env.
    env: opts.env ?? buildBaseProcessEnvironment(),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !usesWindowsJobHost,
  });
  const child: SpawnedProcess = usesWindowsJobHost
    ? publicWindowsProcess(nativeChild)
    : nativeChild;

  let settled = false;
  const exit = new Promise<ProcessExitResult>((resolve) => {
    nativeChild.once('exit', (code, signal) => {
      settled = true;
      resolve({ code, signal });
    });
    nativeChild.once('error', () => {
      if (!settled) {
        settled = true;
        resolve({ code: null, signal: null });
      }
    });
  });

  let killPromise: Promise<void> | undefined;
  function kill(): Promise<void> {
    if (killPromise) return killPromise;
    killPromise = terminateProcessTree(child, exit, () => settled, { platform });
    return killPromise;
  }

  return { child, exit, kill };
}
