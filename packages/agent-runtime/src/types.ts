import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';

export interface StartSessionOptions {
  /** Daemon-generated session UUID. Used only for logging/correlation, never as a process id. */
  sessionId: string;
  cwd: string;
  prompt: string;
  /** Provider-native session/thread id to resume, if the provider supports it. */
  resumeProviderSessionId?: string;
  /** Unset by every caller in this codebase today: the spawned process inherits the daemon's
   * full `process.env` by default, deliberately, since the CLI needs its own PATH/HOME/etc. to
   * find its config and credentials. See SECURITY.md#environment-inheritance-a-deliberate-tradeoff-not-an-oversight. */
  env?: NodeJS.ProcessEnv;
}

export interface ProviderSessionHandle {
  /** Normalized event stream. Always terminates with a session.completed/failed/cancelled event. */
  events: AsyncGenerator<AgentEvent, void, void>;
  /** Request cancellation. Resolves once the underlying process has been signaled. */
  cancel(): Promise<void>;
}

/**
 * One AI CLI integration. Implementations own everything provider-specific: executable
 * discovery, command construction, process spawning, output parsing, and normalization into
 * AgentEvent. Nothing outside this package should need to know a provider's native event shape.
 */
export interface AgentProvider {
  readonly id: ProviderId;
  readonly name: string;
  detect(): Promise<ProviderStatus>;
  startSession(options: StartSessionOptions): ProviderSessionHandle;
}
