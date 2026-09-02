import { existsSync, statSync } from 'node:fs';
import type { AgentEvent, ProviderId } from '@agent-dock/shared';
import { AsyncChannel } from '../../process/async-channel.js';
import { readLines } from '../../process/line-reader.js';
import { spawnProcess } from '../../process/spawn-process.js';
import { buildLegacyProviderEnvironment } from '../../process/provider-environment.js';
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
  /**
   * When true, the prompt is written to the child's stdin instead of appearing anywhere in argv
   * (AD-05), set by an adapter whose CLI supports reading its prompt from stdin. Adapters that
   * don't set this keep the previous behavior (`buildArgs` embeds the prompt itself; stdin is
   * closed immediately with nothing written).
   */
  promptViaStdin?: boolean;
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

  /**
   * Enqueues an EVENT_OVERFLOW error followed by session.failed, bypassing the channel's normal
   * cap (see AsyncChannel.closeWith); the fix for AD-10: an overflowed channel must still
   * deliver exactly one terminal event, not silently strand every subscriber in "running".
   */
  function closeWithOverflow(): void {
    channel.closeWith([
      {
        type: 'error',
        code: 'EVENT_OVERFLOW',
        message: 'session event buffer overflowed',
        recoverable: false,
      },
      { type: 'session.failed', message: 'session event buffer overflowed' },
    ]);
  }

  async function run() {
    if (
      !channel.push({
        type: 'session.started',
        sessionId: options.sessionId,
        provider: config.providerId,
      })
    ) {
      closeWithOverflow();
      return;
    }

    if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
      channel.closeWith([
        {
          type: 'error',
          code: 'INVALID_CWD',
          message: `working directory does not exist: ${options.cwd}`,
          recoverable: false,
        },
        { type: 'session.failed', message: 'invalid working directory' },
      ]);
      return;
    }

    const pinnedStatus = options.providerStatus;
    if (pinnedStatus && pinnedStatus.id !== config.providerId) {
      channel.closeWith([
        {
          type: 'error',
          code: 'PROVIDER_SNAPSHOT_MISMATCH',
          message: 'provider launch snapshot does not match the selected provider',
          recoverable: false,
        },
        { type: 'session.failed', message: 'provider launch snapshot mismatch' },
      ]);
      return;
    }
    const exePath = pinnedStatus
      ? pinnedStatus.executablePath
      : await findExecutable(config.executableNames);
    if (!exePath) {
      channel.closeWith([
        {
          type: 'error',
          code: 'PROVIDER_NOT_INSTALLED',
          message: `${config.executableNames[0]} executable not found on this machine`,
          recoverable: false,
        },
        { type: 'session.failed', message: 'provider executable not found' },
      ]);
      return;
    }

    if (cancelled) {
      channel.closeWith([{ type: 'session.cancelled' }]);
      return;
    }

    const args = config.buildArgs(options);
    logger.info(`${config.providerId}: starting session`, { sessionId: options.sessionId });
    // Sanitized by default (issue #53): the daemon's full process.env only reaches this child if
    // a caller explicitly overrides `options.env` (a test/fork seam), never silently.
    const env =
      options.env ?? buildLegacyProviderEnvironment(process.env, { provider: config.providerId });
    spawned = spawnProcess(exePath, args, { cwd: options.cwd, env });
    // AD-05: when the adapter supports it, the prompt travels over stdin rather than argv, see
    // ProviderRunConfig.promptViaStdin and build-args.ts for why. `.write()` followed immediately
    // by `.end()` is safe and standard: Node buffers and flushes the write before actually
    // closing the stream, no explicit wait needed here, and preserves the string exactly
    // (spaces, quotes, newlines, unicode) since it's a plain UTF-8 write, not shell-parsed.
    if (config.promptViaStdin) {
      spawned.child.stdin.write(options.prompt, 'utf8');
    }
    spawned.child.stdin.end();

    let providerSessionId: string | undefined;
    let stderrBytes = 0;
    spawned.child.stderr.on('data', (chunk: Buffer) => {
      // Provider stderr is untrusted and can echo prompts or credentials. Retain only a bounded
      // numeric fact for diagnostics; never decode, persist, log, or surface its contents.
      stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + chunk.length);
    });

    let overflowed = false;
    let streamReadFailed = false;
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
        for (const event of parsed.events) {
          if (!channel.push(event)) {
            overflowed = true;
            break;
          }
        }
        if (overflowed) break;
      }
    } catch {
      streamReadFailed = true;
      channel.push({
        type: 'error',
        code: 'STREAM_READ_FAILED',
        message: `failed reading ${config.providerId} output`,
        recoverable: false,
      });
    }

    if (overflowed) {
      await spawned.kill();
      closeWithOverflow();
      return;
    }

    const { code, signal } = await spawned.exit;
    logger.info(`${config.providerId}: process exited`, {
      sessionId: options.sessionId,
      code,
      signal,
    });

    if (cancelled) {
      channel.closeWith([{ type: 'session.cancelled' }]);
    } else if (streamReadFailed) {
      channel.closeWith([{ type: 'session.failed', message: 'provider output could not be read' }]);
    } else if (code === 0) {
      channel.closeWith([{ type: 'session.completed', providerSessionId }]);
    } else {
      logger.warn(`${config.providerId}: process exited non-zero`, {
        sessionId: options.sessionId,
        code,
        signal,
        stderrBytes,
      });
      const message = defaultFailureMessage(config.providerId, code, signal);
      channel.closeWith([
        { type: 'error', code: 'PROCESS_EXIT', message, recoverable: false },
        { type: 'session.failed', message },
      ]);
    }
  }

  run().catch(() => {
    // Parser/process failures can contain provider-controlled prompt, credential, or approval
    // text. Log only the bounded failure class; the public event is intentionally generic too.
    logger.error(`${config.providerId}: adapter crashed`, { failure: 'adapter_crash' });
    channel.closeWith([
      {
        type: 'error',
        code: 'ADAPTER_CRASH',
        message: 'internal adapter error',
        recoverable: false,
      },
      { type: 'session.failed', message: 'internal adapter error' },
    ]);
  });

  return {
    events: channel[Symbol.asyncIterator](),
    cancel: async () => {
      cancelled = true;
      await spawned?.kill();
    },
  };
}

function defaultFailureMessage(
  providerId: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  return `${providerId} exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`;
}
