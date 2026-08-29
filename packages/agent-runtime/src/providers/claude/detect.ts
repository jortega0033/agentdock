import type { AuthStatus, ProviderStatus } from '@agent-dock/shared';
import { execCapture } from '../../process/exec-capture.js';
import { findExecutable } from '../../detect-executable.js';
import type { Logger } from '../../logger.js';
import { CLAUDE_CAPABILITIES } from './capabilities.js';

const EXECUTABLE_NAMES = ['claude'];

/**
 * Pure parsing of `claude auth status --json`'s stdout (AD-16) — split out from `detectClaude` so
 * it's testable with captured output strings, no CLI or account needed. Never optimistically
 * returns `'authenticated'`: any shape other than a genuine `{ "loggedIn": boolean }` (malformed
 * JSON, a missing/non-boolean field, empty output) falls through to `'unknown'`.
 */
export function parseClaudeAuthStatus(rawStdout: string): AuthStatus {
  try {
    const parsed = JSON.parse(rawStdout) as { loggedIn?: unknown };
    if (typeof parsed.loggedIn === 'boolean') {
      return parsed.loggedIn ? 'authenticated' : 'unauthenticated';
    }
  } catch {
    // fall through to unknown
  }
  return 'unknown';
}

/**
 * Detects the Claude Code CLI and, separately, whether it's authenticated. These are two
 * independent questions: an installed-but-unauthenticated CLI is a distinct, expected state,
 * not an error. Auth is read via `claude auth status --json`, which reports the CLI's own
 * cached login state — this never reads or touches Claude's credential storage directly.
 */
export async function detectClaude(logger: Logger): Promise<ProviderStatus> {
  const base = { id: 'claude' as const, name: 'Claude Code', capabilities: CLAUDE_CAPABILITIES };

  const executablePath = await findExecutable(EXECUTABLE_NAMES);
  if (!executablePath) {
    return { ...base, installed: false, authenticated: 'unknown' };
  }

  const versionResult = await execCapture(executablePath, ['--version'], { timeoutMs: 8_000 });
  if (versionResult.code !== 0) {
    logger.warn('claude: --version failed', { code: versionResult.code });
    return {
      ...base,
      installed: true,
      authenticated: 'unknown',
      executablePath,
      error: 'claude --version failed',
    };
  }
  const version = versionResult.stdout.trim().split(/\s+/)[0];

  const authResult = await execCapture(executablePath, ['auth', 'status', '--json'], {
    timeoutMs: 15_000,
  });
  if (authResult.timedOut) {
    return { ...base, installed: true, authenticated: 'unknown', executablePath, version, error: 'auth status check timed out' };
  }

  const authenticated = parseClaudeAuthStatus(authResult.stdout);
  if (authenticated === 'unknown') {
    return { ...base, installed: true, authenticated, executablePath, version, error: 'could not parse claude auth status output' };
  }
  return { ...base, installed: true, authenticated, executablePath, version };
}
