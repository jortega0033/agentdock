import type { StartSessionOptions } from '../../types.js';

/**
 * Pure argv construction for `claude -p ...`, extracted from adapter.ts so it can be unit- and
 * contract-tested without spawning a process (in particular, the resume-vs-fresh-session
 * branching — see the provider contract suite's "resume" section).
 *
 * The prompt is deliberately NOT one of these argv elements — it's written to the child's stdin
 * instead (see `runProviderSession`'s `promptViaStdin`, wired in adapter.ts). Two reasons: an
 * argv element has to fit Windows' `CreateProcess` command-line limit (~32,767 characters), well
 * under what the shared request schema permits, and an argv-passed prompt is visible to any
 * same-user process via `ps`/Task Manager's command line column for the process's whole
 * lifetime. `--input-format text` makes the stdin-reads-the-prompt behavior explicit rather than
 * relying on it being `-p`'s undocumented default.
 */
export function buildClaudeArgs(opts: StartSessionOptions): string[] {
  const args = ['-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose'];
  if (opts.resumeProviderSessionId) {
    args.push('--resume', opts.resumeProviderSessionId);
  } else {
    args.push('--session-id', opts.sessionId);
  }
  return args;
}
