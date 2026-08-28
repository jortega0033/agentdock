import { existsSync, statSync } from 'node:fs';
import type { AgentEvent, ProviderId } from '@agent-dock/shared';
import { AsyncChannel } from '../../process/async-channel.js';
import { readLines } from '../../process/line-reader.js';
import { spawnProcess } from '../../process/spawn-process.js';
import { findExecutable } from '../../detect-executable.js';
import type { Logger } from '../../logger.js';
import type { ProviderSessionHandle, StartSessionOptions } from '../../types.js';

export interface ParsedLine {
  events: AgentEvent[];
  providerSessionId?: string;
}

export interface ProviderRunConfig {
  providerId: ProviderId;
  executableNames: string[];
  buildArgs(options: StartSessionOptions): string[];
  parseLine(raw: unknown, logger: Logger): ParsedLine;
  describeFailure?(stderr: string, code: number | null, signal: NodeJS.Signals | null): string;
}

/**
 * Shared spawn/parse/normalize skeleton used by every provider adapter: validates the working
 * directory, resolves the executable, spawns it with an argv array (never a shell string), turns
 * stdout into normalized AgentEvents via the provider's parseLine, and always terminates the
 * event stream with exactly one of session.completed / session.failed / session.cancelled.
 */
export function runProviderSession(
  config: ProviderRunConfig,
  options: StartSessionOptions,
  logger: Logger,
): ProviderSessionHandle {
  const channel = new AsyncChannel<AgentEvent>();
  let spawned: ReturnType<typeof spawnProcess> | undefined;
  let cancelled = false;

  async function run() {
    channel.push({ type: 'session.started', sessionId: options.sessionId, provider: config.providerId });

    if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
      channel.push({
        type: 'error',
        code: 'INVALID_CWD',
        message: `working directory does not exist: ${options.cwd}`,
        recoverable: false,
      });
      channel.push({ type: 'session.failed', message: 'invalid working directory' });
      channel.close();
      return;
    }

    const exePath = await findExecutable(config.executableNames);
    if (!exePath) {
      channel.push({
        type: 'error',
        code: 'PROVIDER_NOT_INSTALLED',
        message: `${config.executableNames[0]} executable not found on this machine`,
        recoverable: false,
      });
      channel.push({ type: 'session.failed', message: 'provider executable not found' });
      channel.close();
      return;
    }

    if (cancelled) {
      channel.push({ type: 'session.cancelled' });
      channel.close();
      return;
    }

    const args = config.buildArgs(options);
    logger.info(`${config.providerId}: starting session`, { sessionId: options.sessionId });
    spawned = spawnProcess(exePath, args, { cwd: options.cwd, env: options.env });
    spawned.child.stdin.end();

    let providerSessionId: string | undefined;
    const stderrChunks: string[] = [];
    let stderrBytes = 0;
    spawned.child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < 200_000) {
        stderrChunks.push(chunk.toString('utf8'));
        stderrBytes += chunk.length;
      }
    });

    try {
      for await (const line of readLines(spawned.child.stdout)) {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          logger.debug(`${config.providerId}: skipped unparseable line`);
          continue;
        }
        const parsed = config.parseLine(raw, logger);
        if (parsed.providerSessionId) providerSessionId = parsed.providerSessionId;
        for (const event of parsed.events) channel.push(event);
      }
    } catch (err) {
      channel.push({
        type: 'error',
        code: 'STREAM_READ_FAILED',
        message: `failed reading ${config.providerId} output: ${(err as Error).message}`,
        recoverable: false,
      });
    }

    const { code, signal } = await spawned.exit;
    logger.info(`${config.providerId}: process exited`, { sessionId: options.sessionId, code, signal });

    if (cancelled) {
      channel.push({ type: 'session.cancelled' });
    } else if (code === 0) {
      channel.push({ type: 'session.completed', providerSessionId });
    } else {
      const stderrText = stderrChunks.join('');
      if (stderrText.trim()) {
        // Bounded and at warn (shown by default): a session failure with no visible reason is
        // unusable for debugging. This is the CLI's own diagnostic output, not daemon secrets —
        // still capped, since we can't guarantee a third-party CLI never echoes something
        // sensitive to stderr.
        logger.warn(`${config.providerId}: process exited non-zero`, {
          sessionId: options.sessionId,
          code,
          signal,
          stderrSnippet: stderrText.slice(0, 2000),
        });
      }
      const message = config.describeFailure?.(stderrText, code, signal) ?? defaultFailureMessage(config.providerId, stderrText, code, signal);
      channel.push({ type: 'error', code: 'PROCESS_EXIT', message, recoverable: false });
      channel.push({ type: 'session.failed', message });
    }
    channel.close();
  }

  run().catch((err) => {
    logger.error(`${config.providerId}: adapter crashed`, { message: (err as Error).message });
    channel.push({ type: 'error', code: 'ADAPTER_CRASH', message: 'internal adapter error', recoverable: false });
    channel.push({ type: 'session.failed', message: 'internal adapter error' });
    channel.close();
  });

  return {
    events: channel[Symbol.asyncIterator](),
    cancel: async () => {
      cancelled = true;
      spawned?.kill();
    },
  };
}

/**
 * Falls back to this when an adapter doesn't provide its own `describeFailure`. A bare "exited
 * with code 1" tells a developer nothing actionable — include a short stderr snippet so a session
 * failure is debuggable without needing to run the daemon with debug logging just to see why.
 */
function defaultFailureMessage(
  providerId: string,
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  const base = `${providerId} exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`;
  const snippet = stderr.trim().slice(0, 500);
  return snippet ? `${base}: ${snippet}` : base;
}
