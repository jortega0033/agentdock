import { spawnProcess } from './spawn-process.js';
import { buildBaseProcessEnvironment } from './provider-environment.js';

const TERMINATION_WAIT_MS = 5_000;

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a short-lived command (version checks, auth status) and captures its output. Not for
 * long-running sessions; use spawnProcess + readLines for those. Always bounded by a timeout
 * so a hung CLI can't stall provider detection indefinitely.
 */
export async function execCapture(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecResult> {
  // Sanitized by default (issue #53): a caller that needs a provider's own auth-key mode passes an
  // explicit env built by buildLegacyProviderEnvironment(); one that doesn't (a bare `which`
  // lookup, for instance) still never inherits the daemon's full process.env.
  const { child, exit, kill } = spawnProcess(command, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? buildBaseProcessEnvironment(),
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
  let resolveTimeout!: () => void;
  const timeout = new Promise<void>((resolve) => {
    resolveTimeout = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    resolveTimeout();
  }, timeoutMs);

  const outcome = await Promise.race([
    exit.then((result) => ({ type: 'exit' as const, result })),
    timeout.then(() => ({ type: 'timeout' as const })),
  ]);
  clearTimeout(timer);

  if (outcome.type === 'exit') {
    return { code: outcome.result.code, stdout, stderr, timedOut };
  }

  // spawnProcess.kill is itself idempotent and reaps its child. Bound both that work and the
  // exit wait here: detection must return even if a platform helper rejects or never reports exit.
  await settleWithin(
    Promise.resolve()
      .then(kill)
      .catch(() => undefined),
    TERMINATION_WAIT_MS,
  );
  const reaped = await settleWithin(exit, TERMINATION_WAIT_MS);

  return { code: reaped?.code ?? null, stdout, stderr, timedOut: true };
}
