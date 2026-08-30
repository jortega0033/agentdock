import type { ProviderStatus } from '@agent-dock/shared';
import type { AgentProvider, ProviderSessionHandle, StartSessionOptions } from '../../types.js';
import { type Logger, noopLogger } from '../../logger.js';
import { runProviderSession } from '../common/run-session.js';
import { buildCodexArgs } from './build-args.js';
import { detectCodex } from './detect.js';
import { parseCodexLine } from './parser.js';

/**
 * Codex CLI adapter. Runs `codex exec --json ...` (or `codex exec resume <id> --json ...` to
 * continue a prior thread) and normalizes its JSONL event stream. Authentication is entirely
 * owned by the `codex` binary via `codex login`; this adapter never reads Codex's credential
 * storage and never passes an API key.
 *
 * Command construction is isolated to `buildArgs` below specifically so a future migration to
 * `codex app-server` only touches this adapter: the daemon API and desktop UI depend on
 * ProviderSessionHandle/AgentEvent, not on how the process was invoked.
 */
export class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const;
  readonly name = 'Codex';

  constructor(private readonly logger: Logger = noopLogger) {}

  detect(): Promise<ProviderStatus> {
    return detectCodex(this.logger);
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    return runProviderSession(
      {
        providerId: 'codex',
        executableNames: ['codex'],
        buildArgs: buildCodexArgs,
        parseLine: parseCodexLine,
      },
      options,
      this.logger,
    );
  }
}
