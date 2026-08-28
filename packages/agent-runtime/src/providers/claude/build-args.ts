import type { StartSessionOptions } from '../../types.js';

/**
 * Pure argv construction for `claude -p ...`, extracted from adapter.ts so it can be unit- and
 * contract-tested without spawning a process (in particular, the resume-vs-fresh-session
 * branching — see the provider contract suite's "resume" section).
 */
export function buildClaudeArgs(opts: StartSessionOptions): string[] {
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose'];
  if (opts.resumeProviderSessionId) {
    args.push('--resume', opts.resumeProviderSessionId);
  } else {
    args.push('--session-id', opts.sessionId);
  }
  return args;
}
