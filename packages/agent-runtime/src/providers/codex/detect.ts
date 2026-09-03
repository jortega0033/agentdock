import type { AuthSource, AuthStatus, ProviderStatus } from '@agent-dock/shared';
import { PROVIDER_DISPLAY_NAMES } from '@agent-dock/shared';
import { execCapture } from '../../process/exec-capture.js';
import { buildLegacyProviderEnvironment } from '../../process/provider-environment.js';
import { findExecutable } from '../../detect-executable.js';
import type { Logger } from '../../logger.js';
import type { ProviderDetectionOptions } from '../../types.js';
import { probeCodexAppServerScope } from './app-server/scope-probe.js';
import { CODEX_CAPABILITIES } from './capabilities.js';

const EXECUTABLE_NAMES = ['codex'];

/**
 * Pure parsing of `codex login status`'s combined stdout+stderr (AD-16), split out from
 * `detectCodex` so it's testable with captured output strings, no CLI or account needed. `codex
 * login status` has no `--json` flag, so this is a conservative regex match against short
 * human-readable lines rather than guessing: falls back to `'unknown'` for anything that doesn't
 * clearly say one way or the other, since a wrong "authenticated: 'authenticated'" is far worse
 * than an honest "unknown".
 */
export function parseCodexLoginStatus(output: string): AuthStatus {
  if (/logged in/i.test(output) && !/not logged in/i.test(output)) return 'authenticated';
  if (/not logged in|not authenticated|no credentials/i.test(output)) return 'unauthenticated';
  return 'unknown';
}

/** Parses only the non-secret credential source label exposed by `codex login status`. */
export function parseCodexAuthSource(output: string): AuthSource {
  if (/logged in using chatgpt/i.test(output) && !/not logged in/i.test(output)) return 'chatgpt';
  if (/logged in using api key/i.test(output) && !/not logged in/i.test(output)) return 'api_key';
  return 'unknown';
}

/** Preserves the complete CLI semver so prereleases cannot inherit stable fixture evidence. */
export function parseCodexVersion(output: string): string | undefined {
  return output
    .trim()
    .split(/\s+/)
    .find((token) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(token));
}

/**
 * Detects the Codex CLI and its login state via `codex login status`, which prints a short
 * human-readable line ("Logged in using ChatGPT" / "Logged in using API key" / not-logged-in
 * variants) rather than JSON. We pattern-match conservatively and fall back to 'unknown' rather
 * than guessing, since a wrong "authenticated: 'authenticated'" is far worse than an honest "unknown".
 */
export async function detectCodex(
  logger: Logger,
  options?: ProviderDetectionOptions,
): Promise<ProviderStatus> {
  const base = {
    id: 'codex' as const,
    name: PROVIDER_DISPLAY_NAMES.codex,
    capabilities: CODEX_CAPABILITIES,
    authSource: 'unknown' as const,
  };

  const executablePath = await findExecutable(EXECUTABLE_NAMES);
  if (!executablePath) {
    return { ...base, installed: false, authenticated: 'unknown' };
  }

  const env = buildLegacyProviderEnvironment(process.env, { provider: 'codex' });
  const versionResult = await execCapture(executablePath, ['--version'], { timeoutMs: 8_000, env });
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
  const version = parseCodexVersion(versionResult.stdout);

  const statusResult = await execCapture(executablePath, ['login', 'status'], {
    timeoutMs: 15_000,
    env,
  });
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
  if (statusResult.code !== 0) {
    logger.warn('codex: login status failed', { code: statusResult.code });
    return {
      ...base,
      installed: true,
      authenticated: 'unknown',
      executablePath,
      version,
      error: 'codex login status failed',
    };
  }
  const authenticated = parseCodexLoginStatus(output);
  const authSource = parseCodexAuthSource(output);
  if (authenticated !== 'unknown') {
    const status: ProviderStatus = {
      ...base,
      installed: true,
      authenticated,
      authSource,
      executablePath,
      version,
    };
    if (
      authenticated === 'authenticated' &&
      authSource !== 'unknown' &&
      options?.includeLaunchScopeEvidence === true &&
      options?.cwd &&
      options.workspaceTrust?.state === 'trusted' &&
      !options.signal?.aborted
    ) {
      try {
        const evidence = await probeCodexAppServerScope({
          executable: executablePath,
          cwd: options.cwd,
          providerStatus: status,
          signal: options.signal,
          env,
        });
        if (evidence) return { ...status, ...evidence };
      } catch {
        // Scope evidence is optional for ordinary app-server startup but mandatory for fallback.
        // Keep detection usable and let the daemon's existing fail-closed planner deny fallback.
        logger.warn('codex: launch scope evidence unavailable');
      }
    }
    return status;
  }

  return {
    ...base,
    installed: true,
    authenticated: 'unknown',
    executablePath,
    version,
    // Successful CLI output is still untrusted and may contain account or credential material.
    // Detection exposes only the fixed classification, never raw stdout/stderr.
    error: 'could not determine codex login status',
  };
}
