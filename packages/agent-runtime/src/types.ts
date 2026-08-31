import type {
  AgentCommandV2,
  AgentEvent,
  AgentEventV2,
  CapabilitySelection,
  CapabilitySupportRecord,
  ProviderId,
  ProviderStatus,
  ProviderTransportV2,
  SessionContinuationV2,
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
  /** Exact detector snapshot for launch pinning. Legacy callers may omit it and retain discovery. */
  providerStatus?: ProviderStatus;
  /** Optional provider sandbox pin used when two transports must preserve the same launch scope. */
  sandbox?: 'read-only' | 'workspace-write';
  /** Exact provider model pin for transports that must preserve launch scope. */
  model?: string;
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

/** Verified daemon-owned workspace evidence. Providers must treat an absent value as untrusted. */
export type WorkspaceTrustEvidence =
  | {
      state: 'trusted';
      workspaceId: string;
      incarnation: string;
      trustEpoch: number;
    }
  | { state: 'untrusted' };

/** Optional daemon-owned context for provider detection that may perform trusted, read-only probes. */
export interface ProviderDetectionOptions {
  cwd?: string;
  workspaceTrust?: WorkspaceTrustEvidence;
  signal?: AbortSignal;
  /** Explicitly permits a bounded, read-only native probe for account/model launch evidence. */
  includeLaunchScopeEvidence?: boolean;
}

/** Bounded, non-secret facts a provider may project onto the public session status. */
export interface ProviderRuntimeMetadata {
  cliVersion?: string;
  schemaVersion?: string;
  fixtureSet?: string;
  requestedTransportMode?: 'auto' | 'app-server' | 'exec';
  fallbackReason?: string;
}

/** Internal-only, non-secret evidence used to bind a provider-native continuation. */
export interface ProviderContinuationEvidence {
  accountFingerprint: string;
  selectedModel: string;
}

export type ProviderDeliveryState = 'not_delivered' | 'ambiguous' | 'delivered';

/** Startup failure safe for cross-layer fallback planning; never carries native payloads. */
export class ProviderTransportStartupError extends Error {
  constructor(
    readonly reasonCode: string,
    readonly deliveryState: ProviderDeliveryState,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderTransportStartupError';
  }
}

/** A user command the provider rejected without damaging the live provider session. */
export class ProviderCommandRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderCommandRejectedError';
  }
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
  /** Supplied only by the daemon after canonical identity and trust-epoch validation. */
  workspaceTrust?: WorkspaceTrustEvidence;
  /**
   * Daemon-owned last-moment gate for any provider request that delivers user work. Providers must
   * await it immediately before writing the work-bearing request to their native transport.
   */
  beforeWorkDelivery?: () => Promise<void>;
  /**
   * Daemon-owned fallback planning gate. Interactive providers must await it after resolving the
   * exact account/model/capability scope and before writing any provider thread request.
   */
  beforeProviderThreadStart?: (
    evidence: Readonly<ProviderContinuationEvidence> | undefined,
  ) => Promise<void>;
  /** Strict public continuation intent. Absence starts a fresh provider thread. */
  continuation?: SessionContinuationV2;
  /** Expected evidence for a daemon-bound resume/fork, verified before any native thread call. */
  expectedContinuationEvidence?: Readonly<ProviderContinuationEvidence>;
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
  readonly providerSessionId?: string;
  readonly runtimeMetadata?: Readonly<ProviderRuntimeMetadata>;
  readonly continuationEvidence?: Readonly<ProviderContinuationEvidence>;
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
  readonly providerSessionId?: string;
  readonly runtimeMetadata?: Readonly<ProviderRuntimeMetadata>;
  readonly continuationEvidence?: Readonly<ProviderContinuationEvidence>;
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
  detect(options?: ProviderDetectionOptions): Promise<ProviderStatus>;
  startSession(options: StartSessionOptions): ProviderSessionHandle;
  /** Optional rich-transport manifest. Undefined keeps the provider on the legacy v1 bridge. */
  getV2Support?(status: ProviderStatus): ProviderV2Support | undefined;
  /** Optional rich-transport factory. Real Claude/Codex adapters remain one-shot until #8. */
  startInteractiveSession?(
    options: StartInteractiveSessionOptions,
  ): Promise<InteractiveProviderSessionHandle>;
}
