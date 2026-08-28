import type { StartSessionOptions } from '../../types.js';

/**
 * Pure argv construction for `codex exec ...`, extracted from adapter.ts so it can be unit- and
 * contract-tested without spawning a process (in particular, the resume-vs-fresh-session
 * branching — see the provider contract suite's "resume" section).
 */
export function buildCodexArgs(opts: StartSessionOptions): string[] {
  if (opts.resumeProviderSessionId) {
    return ['exec', 'resume', opts.resumeProviderSessionId, opts.prompt, '--json', '--skip-git-repo-check'];
  }
  return ['exec', opts.prompt, '--json', '--skip-git-repo-check'];
}
