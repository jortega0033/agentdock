import { spawnProcess } from './spawn-process.js';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a short-lived command (version checks, auth status) and captures its output. Not for
 * long-running sessions — use spawnProcess + readLines for those. Always bounded by a timeout
 * so a hung CLI can't stall provider detection indefinitely.
 */
export async function execCapture(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const { child, exit, kill } = spawnProcess(command, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length < 1_000_000) stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 1_000_000) stderr += chunk.toString('utf8');
  });

  const timeoutMs = opts.timeoutMs ?? 10_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);

  const { code } = await exit;
  clearTimeout(timer);

  return { code, stdout, stderr, timedOut };
}
