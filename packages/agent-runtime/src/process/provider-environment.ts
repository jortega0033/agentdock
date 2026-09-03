import type { ProviderId } from '@agent-dock/shared';

/**
 * The one transport-aware provider environment builder (issue #53). Every provider subprocess --
 * one-shot Claude/Codex, Codex app-server, version/auth probes, and provider CLI control
 * operations -- routes through this instead of inheriting the daemon's full `process.env`. A
 * downstream fork that adds database or connector secrets to the daemon process must not have
 * those secrets silently reach a spawned provider CLI just because a caller forgot to pass an
 * explicit environment.
 *
 * This intentionally does not attempt the Claude Agent SDK's richer per-auth-source key sets
 * (`sdk-auth.ts`'s `buildClaudeSdkEnvironment`, which this module supplies the reusable
 * case-insensitive lookup/copy primitives for): empirically, both `claude` and `codex`'s own CLI
 * commands (`--version`, `auth status`/`login status`) resolve their own stored credentials from
 * disk (under `HOME`/`APPDATA`/`USERPROFILE`) with nothing more than the reviewed OS/runtime keys
 * below -- neither CLI needs the daemon to hand it a credential through the environment.
 * `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` are included anyway as each CLI's own documented API-key
 * auth mode, so a user relying on that mode (rather than `claude auth login`/`codex login`) is not
 * silently broken by this change.
 */

/**
 * Minimal host state a provider CLI needs to start at all and locate its own config/credential
 * store on disk. Identical to the Claude Agent SDK's own reviewed `PROCESS_ENV_KEYS`
 * (`sdk-auth.ts`) by design -- both spawn essentially the same native binary, so there is no
 * reason for two different "what does this process need to boot" answers.
 */
export const REVIEWED_OS_RUNTIME_ENV_KEYS = Object.freeze([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR',
] as const);

/**
 * Each provider CLI's own documented environment-variable API-key auth mode (distinct from the
 * interactive `claude auth login` / `codex login` flow, which needs no environment variable at
 * all -- both were verified against the real installed CLIs on Windows with only the OS/runtime
 * keys above present). Extend this matrix, not an ad hoc per-call-site allowlist, when a provider
 * needs one more supported auth key.
 */
export const PROVIDER_AUTH_ENV_KEYS: Record<ProviderId, readonly string[]> = Object.freeze({
  claude: Object.freeze(['ANTHROPIC_API_KEY']),
  codex: Object.freeze(['OPENAI_API_KEY']),
});

/** One canonical (case-preserved) key's every case-insensitive match in `env`. Windows environment
 * names are case-insensitive; treating `Path` and `PATH` as two different keys would silently let
 * an unreviewed casing of a reviewed name through, or mask a real value with an unrelated one. */
export function findEnvEntries(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): Array<[string, string | undefined]> {
  const normalized = name.toUpperCase();
  return Object.entries(env).filter(([key]) => key.toUpperCase() === normalized);
}

export function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return findEnvEntries(env, name)[0]?.[1];
}

/** Copies only the named keys, case-insensitively, into `target`. Throws rather than picking one
 * arbitrarily if the source environment has more than one casing of the same reviewed name -- an
 * ambiguous duplicate is a sign of a misconfigured host, not something to guess through. */
export function copyCanonicalEnvKeys(
  source: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
  target: Record<string, string | undefined>,
): void {
  for (const name of names) {
    const entries = findEnvEntries(source, name);
    if (entries.length > 1) {
      throw new Error(`provider environment contains duplicate reviewed keys: ${name}`);
    }
    const value = entries[0]?.[1];
    if (value !== undefined) target[name] = value;
  }
}

/**
 * The provider-agnostic floor every sanitized environment starts from: reviewed OS/runtime keys
 * only, no provider auth keys. Used directly by call sites that don't yet know which provider
 * they're probing (e.g. a bare executable-on-PATH lookup).
 */
export function buildBaseProcessEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const target: Record<string, string | undefined> = {};
  copyCanonicalEnvKeys(env, REVIEWED_OS_RUNTIME_ENV_KEYS, target);
  return target;
}

export interface LegacyProviderEnvironmentOptions {
  provider: ProviderId;
  /**
   * Trusted-host extension seam: a fork that runs behind, say, a corporate proxy or a custom CA
   * bundle path can name the exact extra variables its provider CLIs need here. Never populated by
   * this repository itself -- every default call site passes nothing, so forking without touching
   * this file keeps today's reviewed matrix exactly as-is.
   */
  additionalAllowedKeys?: readonly string[];
}

/**
 * The default-deny environment for one-shot Claude/Codex, Codex app-server, version/auth probes,
 * and provider CLI control operations: reviewed OS/runtime keys plus the requested provider's own
 * documented auth-key mode, nothing else. AgentDock discovery tokens, state paths, app secrets,
 * and arbitrary `AGENT_DOCK_*` variables are excluded unless a fork explicitly adds them via
 * `additionalAllowedKeys`.
 */
export function buildLegacyProviderEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: LegacyProviderEnvironmentOptions,
): Record<string, string | undefined> {
  const target = buildBaseProcessEnvironment(env);
  copyCanonicalEnvKeys(env, PROVIDER_AUTH_ENV_KEYS[options.provider], target);
  if (options.additionalAllowedKeys) {
    copyCanonicalEnvKeys(env, options.additionalAllowedKeys, target);
  }
  return target;
}
