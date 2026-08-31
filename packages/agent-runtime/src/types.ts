import type {
  AgentCommandV2,
  AgentEvent,
  AgentEventV2,
  CapabilitySelection,
  CapabilitySupportRecord,
  ProviderId,
  ProviderStatus,
  ProviderTransportV2,
} from '@agent-dock/shared';

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

export interface ProviderV2Support {
  transports: ProviderTransportV2[];
  capabilities: CapabilitySupportRecord[];
}

export interface StartInteractiveSessionOptions extends StartSessionOptions {
  transport: ProviderTransportV2;
  selection: CapabilitySelection;
  executionId: string;
  turnId: string;
  /** Daemon ownership defers interaction deadlines until responder publication. */
  interactionOwner?: 'provider' | 'daemon';
  /** Cancels startup or the live session. Teardown still waits for bounded process-tree reaping. */
  signal?: AbortSignal;
}

export type AcceptedWorkState = 'not_accepted' | 'accepted' | 'unknown';

export type ProviderInteractionResolution =
  | {
      kind: 'approval';
      requestId: string;
      turnId: string;
      decision: 'deny';
      reason:
        | 'cancel'
        | 'disconnect'
        | 'interrupt'
        | 'overflow'
        | 'shutdown'
        | 'timeout'
        | 'trust_revoked';
    }
  | {
      kind: 'question';
      requestId: string;
      turnId: string;
      reason:
        | 'cancel'
        | 'disconnect'
        | 'interrupt'
        | 'overflow'
        | 'shutdown'
        | 'timeout'
        | 'trust_revoked';
    };

/**
 * Long-lived, bidirectional provider session. Creation resolves only after the provider startup
 * handshake. `accepted` is the explicit no-replay boundary for the initial prompt; each `send()`
 * resolves only after that command crosses the provider's accepted-work boundary.
 */
export interface InteractiveProviderSessionHandle {
  events: AsyncGenerator<AgentEventV2, void, void>;
  accepted: Promise<AcceptedWorkState>;
  send(command: AgentCommandV2): Promise<void>;
  /** Fail-closed daemon resolution for an unanswered published interaction. */
  resolveInteraction(
    requestId: string,
    reason:
      'cancel' | 'disconnect' | 'interrupt' | 'overflow' | 'shutdown' | 'timeout' | 'trust_revoked',
  ): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** Low-level provider host contract wrapped by the common session supervisor. */
export interface InteractiveProviderTransport {
  /**
   * UTF-8 JSON text/bytes, or a data-only JSON-compatible normalized object. Implementations must
   * bound native framing before parsing; the supervisor independently verifies the normalized view.
   */
  events: AsyncGenerator<unknown, void, void>;
  /** Drained independently and retained only within the supervisor's bounded diagnostic buffer. */
  stderr: AsyncGenerator<unknown, void, void>;
  started: Promise<void>;
  accepted: Promise<AcceptedWorkState>;
  send(command: AgentCommandV2): Promise<void>;
  /** Provider-native fail-closed response; resolves only after the provider accepts it. */
  resolveInteraction(resolution: ProviderInteractionResolution): Promise<void>;
  interrupt(): Promise<void>;
  /** Requests graceful shutdown and resolves only after the provider host has exited and been reaped. */
  close(): Promise<void>;
  /** Hard-stop used when graceful close exceeds its bound. It must kill and reap the whole host
   * process tree before resolving; provider adapters must not leave orphan descendants. */
  forceClose(): Promise<void>;
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
  /** Optional rich-transport manifest. Undefined keeps the provider on the legacy v1 bridge. */
  getV2Support?(status: ProviderStatus): ProviderV2Support | undefined;
  /** Optional rich-transport factory. Real Claude/Codex adapters remain one-shot until #8. */
  startInteractiveSession?(
    options: StartInteractiveSessionOptions,
  ): Promise<InteractiveProviderSessionHandle>;
}
