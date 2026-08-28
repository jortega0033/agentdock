import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface SpawnResult {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Kills the whole process tree, not just the direct child. Safe to call more than once. */
  kill: () => void;
}

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawns a command with an argv array (never a shell string) and no shell interpolation.
 * Runs the child detached in its own process group on POSIX and kills the whole tree via
 * `taskkill /T` on Windows, so cancelling a session can't leave grandchild processes orphaned.
 */
export function spawnProcess(command: string, args: string[], opts: SpawnOptions): SpawnResult {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });

  let settled = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      settled = true;
      resolve({ code, signal });
    });
    child.once('error', () => {
      if (!settled) {
        settled = true;
        resolve({ code: null, signal: null });
      }
    });
  });

  let killed = false;
  function kill(): void {
    if (killed || settled) return;
    killed = true;
    if (process.platform === 'win32') {
      if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false });
    } else {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        if (!settled) {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }, 5000).unref();
    }
  }

  return { child, exit, kill };
}
