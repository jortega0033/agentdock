/** Every AI CLI provider the runtime knows about. Add new ids here when adding a provider. */
export const PROVIDER_IDS = ['claude', 'codex'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type AuthStatus = boolean | 'unknown';

/**
 * Point-in-time read of whether a provider CLI is usable. `authenticated: 'unknown'` must never
 * be treated as `true` by callers — it means the daemon could not determine auth state (e.g. the
 * CLI has no machine-readable status command, or the check errored) and the user should be
 * routed to the CLI's own login flow to find out.
 */
export interface ProviderStatus {
  id: ProviderId;
  name: string;
  installed: boolean;
  authenticated: AuthStatus;
  executablePath?: string;
  version?: string;
  error?: string;
}
