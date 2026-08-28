import type { ProviderStatus } from '@agent-dock/shared';
import { execCapture } from '../../process/exec-capture.js';
import { findExecutable } from '../../detect-executable.js';
import type { Logger } from '../../logger.js';

const EXECUTABLE_NAMES = ['codex'];

/**
 * Detects the Codex CLI and its login state via `codex login status`, which prints a short
 * human-readable line ("Logged in using ChatGPT" / "Logged in using API key" / not-logged-in
 * variants) rather than JSON. We pattern-match conservatively and fall back to 'unknown' rather
 * than guessing, since a wrong "authenticated: true" is far worse than an honest "unknown".
 */
export async function detectCodex(logger: Logger): Promise<ProviderStatus> {
  const base = { id: 'codex' as const, name: 'Codex' };

  const executablePath = await findExecutable(EXECUTABLE_NAMES);
  if (!executablePath) {
    return { ...base, installed: false, authenticated: 'unknown' };
  }

  const versionResult = await execCapture(executablePath, ['--version'], { timeoutMs: 8_000 });
  if (versionResult.code !== 0) {
    logger.warn('codex: --version failed', { code: versionResult.code });
    return {
      ...base,
      installed: true,
      authenticated: 'unknown',
      executablePath,
      error: 'codex --version failed',
    };
  }
  const versionMatch = versionResult.stdout.trim().match(/[\d.]+/);
  const version = versionMatch?.[0];

  const statusResult = await execCapture(executablePath, ['login', 'status'], { timeoutMs: 15_000 });
  if (statusResult.timedOut) {
    return {
      ...base,
      installed: true,
      authenticated: 'unknown',
      executablePath,
      version,
      error: 'login status check timed out',
    };
  }

  const output = `${statusResult.stdout}\n${statusResult.stderr}`.trim();
  if (/logged in/i.test(output) && !/not logged in/i.test(output)) {
    return { ...base, installed: true, authenticated: true, executablePath, version };
  }
  if (/not logged in|not authenticated|no credentials/i.test(output)) {
    return { ...base, installed: true, authenticated: false, executablePath, version };
  }

  return {
    ...base,
    installed: true,
    authenticated: 'unknown',
    executablePath,
    version,
    error: output.slice(0, 200) || 'could not determine codex login status',
  };
}
