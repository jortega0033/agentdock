import type { ProviderStatus } from '@agent-dock/shared';
import type { AgentProvider, ProviderSessionHandle, StartSessionOptions } from '../../types.js';
import { type Logger, noopLogger } from '../../logger.js';
import { runProviderSession } from '../common/run-session.js';
import { buildClaudeArgs } from './build-args.js';
import { detectClaude } from './detect.js';
import { parseClaudeLine } from './parser.js';

/**
 * Claude Code CLI adapter. Runs `claude -p ... --output-format stream-json --verbose` and
 * normalizes its JSONL output. Authentication is entirely owned by the `claude` binary; this
 * adapter never reads Claude's credential storage and never passes an API key.
 */
export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly name = 'Claude Code';

  constructor(private readonly logger: Logger = noopLogger) {}

  detect(): Promise<ProviderStatus> {
    return detectClaude(this.logger);
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    return runProviderSession(
      {
        providerId: 'claude',
        executableNames: ['claude'],
        buildArgs: buildClaudeArgs,
        parseLine: parseClaudeLine,
        promptViaStdin: true,
      },
      options,
      this.logger,
    );
  }
}
