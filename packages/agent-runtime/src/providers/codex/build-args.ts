import type { StartSessionOptions } from '../../types.js';

/** Codex's documented positional placeholder for "read the prompt from stdin instead". */
const CODEX_STDIN_PROMPT_PLACEHOLDER = '-';

/**
 * Pure argv construction for `codex exec ...`, extracted from adapter.ts so it can be unit- and
 * contract-tested without spawning a process (in particular, the resume-vs-fresh-session
 * branching, see the provider contract suite's "resume" section).
 *
 * The prompt is deliberately NOT one of these argv elements: `-` in its place tells Codex to read
 * the prompt from stdin instead (see `runProviderSession`'s `promptViaStdin`, wired in
 * adapter.ts). Two reasons: an argv element has to fit Windows' `CreateProcess` command-line limit
 * (~32,767 characters), well under what the shared request schema permits (up to 200,000
 * characters), and an argv-passed prompt is visible to any same-user process via `ps`/Task
 * Manager's command line column for the process's whole lifetime.
 *
 * `opts.attachments` (issue #152) is delivered as `-i`/`--image <path>` argv, one flag+path pair
 * per attachment -- unlike Claude, this is a real local file path Codex reads itself, not inline
 * content, so the prompt keeps going over stdin unchanged either way. Appended last so it can
 * never shift the position of any existing flag for a session with no attachments (empty array).
 */
export function buildCodexArgs(opts: StartSessionOptions): string[] {
  const sandboxArgs = opts.sandbox ? ['--sandbox', opts.sandbox] : [];
  const modelArgs = opts.model ? ['--model', opts.model] : [];
  const imageArgs = (opts.attachments ?? []).flatMap((attachment) => ['--image', attachment.path]);
  if (opts.resumeProviderSessionId) {
    if (opts.sandbox) {
      throw new Error('Codex exec resume cannot preserve an explicit sandbox scope');
    }
    return [
      'exec',
      'resume',
      opts.resumeProviderSessionId,
      CODEX_STDIN_PROMPT_PLACEHOLDER,
      '--json',
      '--skip-git-repo-check',
      ...sandboxArgs,
      ...modelArgs,
      ...imageArgs,
    ];
  }
  return [
    'exec',
    CODEX_STDIN_PROMPT_PLACEHOLDER,
    '--json',
    '--skip-git-repo-check',
    ...sandboxArgs,
    ...modelArgs,
    ...imageArgs,
  ];
}
