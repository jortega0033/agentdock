/** Every AI CLI provider the runtime knows about. Add new ids here when adding a provider. */
export const PROVIDER_IDS = ['claude', 'codex'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Deliberately a pure string union with no boolean member (AD-13): the previous
 * `boolean | 'unknown'` shape let a lazy `if (status.authenticated)` silently treat "couldn't
 * determine" as "authenticated", which is exactly backwards for a security-relevant signal.
 * There is no member here a naive truthiness check would get right by accident: every consumer
 * must write `=== 'authenticated'` explicitly.
 */
export type AuthStatus = 'authenticated' | 'unauthenticated' | 'unknown';

/**
 * What an AgentDock adapter actually does for a provider, not a marketing claim about the
 * underlying model. A capability is `true` only if this codebase's adapter reliably implements
 * and normalizes that behavior today; if support is flaky, partial, or untested, it's `false` or
 * simply absent. This is what lets a downstream client render "supports resume" / show a cancel
 * button / expect usage numbers without ever writing `if (provider.id === 'claude')`.
 *
 * Every known key is optional (AD-15): **absent means unsupported**, exactly like `false`, so
 * adding a 6th capability later doesn't break a client built against today's five-key shape (see
 * `providerCapabilitiesSchema`'s `.catchall`). The index signature lets a future capability this
 * repo hasn't named yet still round-trip through a client one version behind, rather than being
 * silently dropped as an unrecognized field.
 */
export interface ProviderCapabilities {
  /** Can a session be started as a continuation of a prior `providerSessionId`? */
  resume?: boolean;
  /** Can an in-progress session be cancelled, terminating the underlying process? */
  cancellation?: boolean;
  /** Does the adapter normalize tool/command invocations into tool.started/tool.completed? */
  tools?: boolean;
  /** Does the adapter normalize token/cost accounting into `usage` events? */
  usage?: boolean;
  /** Does the adapter surface CLI-exposed reasoning as `thinking.delta` (only when the CLI itself makes it public)? */
  thinking?: boolean;
  [futureCapability: string]: boolean | undefined;
}

/**
 * Point-in-time read of whether a provider CLI is usable. `authenticated: 'unknown'` must never
 * be treated as `'authenticated'` by callers: it means the daemon could not determine auth state
 * (e.g. the CLI has no machine-readable status command, or the check errored) and the user should
 * be routed to the CLI's own login flow to find out.
 */
export interface ProviderStatus {
  id: ProviderId;
  name: string;
  installed: boolean;
  authenticated: AuthStatus;
  capabilities: ProviderCapabilities;
  executablePath?: string;
  version?: string;
  error?: string;
}
