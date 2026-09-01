import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  agentEventV2EnvelopeSchema,
  agentSessionV2Schema,
  providerSessionIdV2Schema,
  providerRuntimeMetadataV2Schema,
  utf8ByteLength,
  type AgentCommandV2,
  type AgentEventEnvelope,
  type AgentEventV2Envelope,
  type AgentSession,
  type AgentSessionV2,
  type CapabilitySelection,
  type CreateSessionV2Request,
  type ProviderRuntimeMetadataV2,
  type ProviderStatus,
  type ProviderTransportV2,
  type SessionContinuationInputV2,
  type SessionEventHistoryV2Page,
  type SessionEventHistoryV2Query,
  type SessionListV2Page,
  type SessionListV2Query,
} from '@agent-dock/shared';
import {
  ProviderTransportStartupError,
  type ProviderContinuationEvidence,
  type ProviderDeliveryState,
  type WorkspaceTrustEvidence,
} from '@agent-dock/agent-runtime';
import type { DispatchResult, SessionManager } from './session-manager.js';
import {
  MemoryExecutionGraphStore,
  type DurableExecutionRecord,
  type ExecutionGraphStore,
} from './execution-graph-store.js';
import type { WorkspaceIdentity } from './workspace-identity.js';
import {
  freezeProviderContinuationScope,
  planLegacyProviderFallback,
  planPinnedLegacyDispatch,
  providerContinuationScopesEqual,
  providerFallbackScopesEqual,
  providerStatusMatchesFrozenScope,
  type FrozenProviderSessionScope,
  type PinnedLegacyDispatchPlan,
  type ProviderContinuationScope,
  type ProviderV2FallbackPlan,
  type ProviderV2FallbackIntent,
  type ProviderV2FallbackPlanning,
  type ProviderV2LegacyIntent,
} from './provider-v2.js';

interface ToolCorrelation {
  toolCallId: string;
  contentBlockId: string;
  toolName: string;
}

interface StoredV2Event {
  event: AgentEventV2Envelope;
  bytes: number;
}

interface V2SessionMetadata {
  sessionId: string;
  selection: CapabilitySelection;
  executionId: string;
  rootExecutionId: string;
  parentSessionId?: string;
  parentExecutionId?: string;
  continuationKind: 'fresh' | 'resume' | 'fork';
  turnId: string;
  events: Map<number, StoredV2Event>;
  listeners: Set<(sequence: number, event: AgentEventV2Envelope) => void>;
  replayBytes: number;
  nextSequence: number;
  sourceUnsubscribe?: () => void;
  nativeTools: Map<string, ToolCorrelation>;
  interactive: boolean;
  status: AgentSessionV2['status'];
  acceptedWork: AgentSessionV2['acceptedWork'];
  terminalReason?: string;
  pendingInteractions: Map<string, { kind: 'approval' | 'question'; turnId: string }>;
  responderLease?: string;
  providerSessionId?: string;
  runtimeMetadata?: ProviderRuntimeMetadataV2;
  continuationScope?: ProviderContinuationScope;
  continuationLease?: {
    provider: AgentSessionV2['provider'];
    providerSessionId: string;
    leaseId: string;
  };
  continuationTargetLease?: {
    provider: AgentSessionV2['provider'];
    providerSessionId: string;
    leaseId: string;
  };
}

export interface V2SessionCreateContext {
  providerStatus?: ProviderStatus;
  fallbackIntent?: ProviderV2FallbackIntent;
  primaryScope?: FrozenProviderSessionScope;
  fallback?: ProviderV2FallbackPlan;
  fallbackDeniedReason?: ProviderV2FallbackPlanning['deniedReason'];
  legacyIntent?: ProviderV2LegacyIntent;
  legacyDispatch?: PinnedLegacyDispatchPlan;
}

export class V2ProviderStartupError extends Error {
  readonly code = 'provider_transport_startup_failed' as const;

  constructor(
    readonly reasonCode: string,
    readonly deliveryState: ProviderDeliveryState,
    readonly fallbackReason: string,
  ) {
    super('provider transport failed before the session could start');
    this.name = 'V2ProviderStartupError';
  }
}

const ALL_EFFECTS = [
  'read',
  'filesystem_write',
  'command',
  'network',
  'external_side_effect',
  'destructive',
] as const;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_WIRE_STRING_BYTES = 256;
const MAX_REPLAY_EVENTS = 5_000;
const MAX_REPLAY_BYTES = 16 * 1024 * 1024;
const RESPONDER_LEASE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CONTINUATION_BINDINGS = 1_024;

interface ProviderContinuationBinding {
  sessionId: string;
  scope: ProviderContinuationScope;
  leaseId?: string;
}

export interface V2LineageContext {
  rootExecutionId: string;
  parentSessionId: string;
  parentExecutionId: string;
  continuationKind: 'resume' | 'fork';
}

export class V2ContinuationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'V2ContinuationError';
  }
}

function isTerminal(event: AgentEventV2Envelope): boolean {
  return (
    event.type === 'session.completed' ||
    event.type === 'session.failed' ||
    event.type === 'session.cancelled' ||
    event.type === 'session.interrupted'
  );
}

function isTerminalStatus(status: AgentSessionV2['status']): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

function continuationKey(provider: AgentSessionV2['provider'], providerSessionId: string): string {
  return `${provider}\0${providerSessionId}`;
}

function v2Status(status: AgentSession['status']): AgentSessionV2['status'] {
  return status === 'running' ? 'active' : status;
}

function boundedSummary(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 511)}…`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (utf8ByteLength(value.slice(0, midpoint)) <= maxBytes) low = midpoint;
    else high = midpoint - 1;
  }
  const truncated = value.slice(0, low);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}

function boundedTerminalReason(value: string | undefined, fallback: string): string {
  return truncateUtf8(value ?? '', MAX_WIRE_STRING_BYTES) || fallback;
}

function validTokenCount(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function safeReasonCode(value: string): string {
  return /^[a-z0-9][a-z0-9._-]{0,255}$/.test(value) ? value : 'provider_transport_startup_failed';
}

function sameWorkspaceTrust(
  expected: WorkspaceTrustEvidence,
  current: WorkspaceTrustEvidence,
): boolean {
  if (expected.state !== current.state) return false;
  if (expected.state === 'untrusted' || current.state === 'untrusted') return true;
  return (
    expected.workspaceId === current.workspaceId &&
    expected.incarnation === current.incarnation &&
    expected.trustEpoch === current.trustEpoch
  );
}

function sameProviderDetectionSnapshot(expected: ProviderStatus, current: ProviderStatus): boolean {
  return (
    expected.id === current.id &&
    expected.installed === current.installed &&
    expected.executablePath === current.executablePath &&
    expected.version === current.version &&
    expected.authenticated === current.authenticated &&
    expected.authSource === current.authSource &&
    (expected.accountFingerprint === undefined ||
      expected.accountFingerprint === current.accountFingerprint) &&
    (expected.selectedModel === undefined || expected.selectedModel === current.selectedModel)
  );
}

function safeRuntimeMetadata(value: unknown): ProviderRuntimeMetadataV2 | undefined {
  const parsed = providerRuntimeMetadataV2Schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export class V2SessionFacade {
  private readonly metadata = new Map<string, V2SessionMetadata>();
  private readonly continuationBindings = new Map<string, ProviderContinuationBinding>();
  private readonly graph: ExecutionGraphStore;

  constructor(
    private readonly sessions: SessionManager,
    graph?: ExecutionGraphStore,
  ) {
    this.graph = graph ?? sessions.executionGraphStore ?? new MemoryExecutionGraphStore();
    this.hydrate();
  }

  async create(
    input: CreateSessionV2Request,
    selection: CapabilitySelection,
    transport: ProviderTransportV2,
    interactive: boolean,
    signal?: AbortSignal,
    workspace?: WorkspaceIdentity,
    context?: V2SessionCreateContext,
    lineage?: V2LineageContext,
  ): Promise<AgentSessionV2> {
    this.prune();
    const executionId = randomUUID();
    const turnId = randomUUID();
    const rootExecutionId = lineage?.rootExecutionId ?? executionId;
    const continuationKind = lineage?.continuationKind ?? 'fresh';
    let continuationBinding: ProviderContinuationBinding | undefined;
    const continuationLease = input.continuation
      ? {
          provider: input.provider,
          providerSessionId: input.continuation.providerSessionId,
          leaseId: executionId,
        }
      : undefined;
    let continuationTargetLease:
      | {
          provider: AgentSessionV2['provider'];
          providerSessionId: string;
          leaseId: string;
        }
      | undefined;
    if (input.continuation) {
      const requiredCapability =
        input.continuation.kind === 'resume' ? 'session.resume' : 'session.fork';
      if (!selection.enabled.some(({ id }) => id === requiredCapability)) {
        throw new V2ProviderStartupError(
          'continuation_capability_not_selected',
          'not_delivered',
          'continuation_capability_not_selected',
        );
      }
      continuationBinding = this.continuationBindings.get(
        continuationKey(input.provider, input.continuation.providerSessionId),
      );
      if (!continuationBinding) {
        throw new V2ProviderStartupError(
          'continuation_binding_not_found',
          'not_delivered',
          'continuation_binding_not_found',
        );
      }
      if (continuationBinding.leaseId) {
        throw new V2ProviderStartupError(
          'continuation_in_use',
          'not_delivered',
          'continuation_in_use',
        );
      }
      // No await may occur between checking and taking this in-memory lease.
      this.graph.acquireContinuation(
        input.provider,
        input.continuation.providerSessionId,
        executionId,
      );
      continuationBinding.leaseId = executionId;
    }
    let retainContinuationLease = false;
    const reservedSessionIds = new Set<string>();
    const reserve =
      (
        activeSelection: CapabilitySelection,
        activeInteractive: boolean,
        continuationScope?: ProviderContinuationScope,
        runtimeMetadata?: ProviderRuntimeMetadataV2,
      ) =>
      (session: Readonly<AgentSession>): void => {
        this.graph.reserve(
          this.initialRecord(
            session,
            activeSelection,
            activeInteractive,
            executionId,
            turnId,
            rootExecutionId,
            continuationKind,
            lineage,
            continuationScope,
            runtimeMetadata,
          ),
        );
        reservedSessionIds.add(session.id);
      };
    const discardReservations = (): void => {
      for (const sessionId of reservedSessionIds) this.graph.discard(sessionId);
      reservedSessionIds.clear();
    };
    try {
      let activeSelection = selection;
      let activeInteractive = interactive;
      let fallbackRuntimeMetadata: ProviderRuntimeMetadataV2 | undefined;
      let primaryScope = context?.primaryScope;
      let fallback = context?.fallback;
      let fallbackDeniedReason = context?.fallbackDeniedReason;
      const currentWorkspaceTrust = await this.sessions.verifiedWorkspaceTrust(workspace);
      let launchProviderStatus = context?.providerStatus;
      let continuationScope: ProviderContinuationScope | undefined;
      let expectedContinuationEvidence:
        { accountFingerprint: string; selectedModel: string } | undefined;
      if (primaryScope && fallback) {
        expectedContinuationEvidence = {
          accountFingerprint: primaryScope.accountFingerprint,
          selectedModel: primaryScope.model,
        };
      }
      if (input.continuation) {
        expectedContinuationEvidence = {
          accountFingerprint: continuationBinding!.scope.accountFingerprint,
          selectedModel: continuationBinding!.scope.selectedModel,
        };
        continuationScope = context?.providerStatus
          ? freezeProviderContinuationScope({
              status: context.providerStatus,
              cwd: input.cwd,
              workspaceTrust: currentWorkspaceTrust,
              evidence: expectedContinuationEvidence,
            })
          : undefined;
        if (!continuationScope) {
          throw new V2ProviderStartupError(
            'continuation_scope_mismatch',
            'not_delivered',
            'continuation_scope_mismatch',
          );
        }
        if (!providerContinuationScopesEqual(continuationBinding!.scope, continuationScope)) {
          throw new V2ProviderStartupError(
            'continuation_scope_mismatch',
            'not_delivered',
            'continuation_scope_mismatch',
          );
        }
        if (
          !interactive &&
          (context?.providerStatus?.accountFingerprint !==
            expectedContinuationEvidence.accountFingerprint ||
            context?.providerStatus?.selectedModel !== expectedContinuationEvidence.selectedModel)
        ) {
          throw new V2ProviderStartupError(
            'continuation_scope_mismatch',
            'not_delivered',
            'continuation_scope_mismatch',
          );
        }
      }
      const fallbackIntent = context?.fallbackIntent;
      const initialProviderStatus = context?.providerStatus;
      const beforeProviderThreadStart =
        fallbackIntent && initialProviderStatus
          ? async (evidence: Readonly<ProviderContinuationEvidence> | undefined): Promise<void> => {
              const prePlanningTrust = await this.sessions.verifiedWorkspaceTrust(workspace);
              if (
                signal?.aborted ||
                !sameWorkspaceTrust(fallbackIntent.workspaceTrust, prePlanningTrust)
              ) {
                throw new ProviderTransportStartupError(
                  'workspace_trust_changed',
                  'not_delivered',
                  'Workspace trust changed before provider thread startup',
                );
              }
              const evidencedStatus = evidence
                ? { ...initialProviderStatus, ...evidence }
                : initialProviderStatus;
              const planning = planLegacyProviderFallback({
                ...fallbackIntent,
                status: evidencedStatus,
                workspaceTrust: prePlanningTrust,
              });
              const postPlanningTrust = await this.sessions.verifiedWorkspaceTrust(workspace);
              if (signal?.aborted || !sameWorkspaceTrust(prePlanningTrust, postPlanningTrust)) {
                throw new ProviderTransportStartupError(
                  'workspace_trust_changed',
                  'not_delivered',
                  'Workspace trust changed before provider thread startup',
                );
              }
              primaryScope = planning.primaryScope;
              fallback = planning.fallback;
              fallbackDeniedReason = planning.deniedReason;
              launchProviderStatus = evidencedStatus;
            }
          : undefined;
      let session: AgentSession;
      try {
        if (interactive) {
          session = await this.sessions.createInteractive(
            input.provider,
            input.cwd,
            input.prompt,
            selection,
            transport,
            executionId,
            turnId,
            signal,
            workspace,
            context?.providerStatus,
            input.continuation,
            expectedContinuationEvidence,
            beforeProviderThreadStart,
            reserve(selection, true, continuationScope),
          );
        } else if (context?.legacyIntent && context.providerStatus) {
          const legacyIntent = context.legacyIntent;
          const preProbeTrust = await this.sessions.verifiedWorkspaceTrust(workspace);
          const redetected = await this.sessions.redetectProvider(input.provider, signal, {
            cwd: input.cwd,
            workspaceTrust: preProbeTrust,
            includeLaunchScopeEvidence: true,
          });
          const preSpawnTrust = await this.sessions.verifiedWorkspaceTrust(workspace);
          if (
            !redetected ||
            signal?.aborted ||
            !sameProviderDetectionSnapshot(context.providerStatus, redetected) ||
            !sameWorkspaceTrust(legacyIntent.workspaceTrust, preProbeTrust) ||
            !sameWorkspaceTrust(legacyIntent.workspaceTrust, preSpawnTrust)
          ) {
            throw new V2ProviderStartupError(
              'provider_scope_revalidation_failed',
              'not_delivered',
              'provider_scope_revalidation_failed',
            );
          }
          const planning = planPinnedLegacyDispatch({
            ...legacyIntent,
            status: redetected,
            workspaceTrust: preSpawnTrust,
          });
          if (!planning.dispatch) {
            throw new V2ProviderStartupError(
              'provider_scope_unverified',
              'not_delivered',
              planning.deniedReason ?? 'fallback_scope_mismatch',
            );
          }
          session = this.sessions.create(
            input.provider,
            input.cwd,
            input.prompt,
            undefined,
            2,
            workspace,
            redetected,
            planning.dispatch.sandbox,
            planning.dispatch.frozenScope.model,
            reserve(
              selection,
              false,
              freezeProviderContinuationScope({
                status: redetected,
                cwd: input.cwd,
                workspaceTrust: preSpawnTrust,
              }),
            ),
          );
          launchProviderStatus = redetected;
        } else if (context?.legacyDispatch) {
          const preProbeTrust = await this.sessions.verifiedWorkspaceTrust(workspace);
          const redetected = await this.sessions.redetectProvider(input.provider, signal, {
            cwd: input.cwd,
            workspaceTrust: preProbeTrust,
            includeLaunchScopeEvidence: true,
          });
          const preSpawnTrust = await this.sessions.verifiedWorkspaceTrust(workspace);
          if (
            !redetected ||
            signal?.aborted ||
            !providerStatusMatchesFrozenScope(redetected, context.legacyDispatch.frozenScope) ||
            !sameWorkspaceTrust(context.legacyDispatch.frozenScope.workspaceTrust, preProbeTrust) ||
            !sameWorkspaceTrust(context.legacyDispatch.frozenScope.workspaceTrust, preSpawnTrust)
          ) {
            throw new V2ProviderStartupError(
              'provider_scope_revalidation_failed',
              'not_delivered',
              'provider_scope_revalidation_failed',
            );
          }
          session = this.sessions.create(
            input.provider,
            input.cwd,
            input.prompt,
            undefined,
            2,
            workspace,
            redetected,
            context.legacyDispatch.sandbox,
            context.legacyDispatch.frozenScope.model,
            reserve(
              selection,
              false,
              freezeProviderContinuationScope({
                status: redetected,
                cwd: input.cwd,
                workspaceTrust: preSpawnTrust,
              }),
            ),
          );
          launchProviderStatus = redetected;
        } else {
          if (input.continuation?.kind === 'fork') {
            throw new V2ProviderStartupError(
              'legacy_fork_unsupported',
              'not_delivered',
              'continuation_capability_not_selected',
            );
          }
          const preSpawnTrust = await this.sessions.verifiedWorkspaceTrust(workspace);
          if (signal?.aborted || !sameWorkspaceTrust(currentWorkspaceTrust, preSpawnTrust)) {
            throw new V2ProviderStartupError(
              'provider_scope_revalidation_failed',
              'not_delivered',
              'provider_scope_revalidation_failed',
            );
          }
          session = this.sessions.create(
            input.provider,
            input.cwd,
            input.prompt,
            input.continuation?.providerSessionId,
            2,
            workspace,
            context?.providerStatus,
            undefined,
            undefined,
            reserve(
              selection,
              false,
              continuationScope ??
                (context?.providerStatus
                  ? freezeProviderContinuationScope({
                      status: context.providerStatus,
                      cwd: input.cwd,
                      workspaceTrust: preSpawnTrust,
                    })
                  : undefined),
            ),
          );
        }
      } catch (error) {
        if (!(error instanceof ProviderTransportStartupError)) throw error;
        discardReservations();
        const reasonCode = safeReasonCode(error.reasonCode);
        const candidateFallback = fallback;
        const candidatePrimaryScope = primaryScope;
        const staticallyEligible =
          interactive &&
          reasonCode !== 'codex_continuation_scope_changed' &&
          error.deliveryState === 'not_delivered' &&
          !signal?.aborted &&
          context?.providerStatus !== undefined &&
          candidatePrimaryScope !== undefined &&
          candidateFallback !== undefined &&
          candidateFallback.selection.transport === candidateFallback.transport.id &&
          providerFallbackScopesEqual(candidatePrimaryScope, candidateFallback.frozenScope);
        if (!staticallyEligible) {
          throw new V2ProviderStartupError(
            reasonCode,
            error.deliveryState,
            fallbackDeniedReason ??
              (error.deliveryState === 'not_delivered'
                ? 'fallback_scope_mismatch'
                : error.deliveryState === 'ambiguous'
                  ? 'fallback_delivery_ambiguous'
                  : 'fallback_after_delivery_forbidden'),
          );
        }
        const currentTrust = await this.sessions.verifiedWorkspaceTrust(workspace);
        if (!sameWorkspaceTrust(candidatePrimaryScope.workspaceTrust, currentTrust)) {
          throw new V2ProviderStartupError(
            reasonCode,
            error.deliveryState,
            'fallback_scope_mismatch',
          );
        }
        const redetectedStatus = await this.sessions.redetectProvider(input.provider, signal, {
          cwd: input.cwd,
          workspaceTrust: currentTrust,
          includeLaunchScopeEvidence: true,
        });
        const preFallbackTrust = await this.sessions.verifiedWorkspaceTrust(workspace);
        if (!redetectedStatus) {
          throw new V2ProviderStartupError(
            reasonCode,
            error.deliveryState,
            'fallback_provider_redetect_failed',
          );
        }
        if (
          signal?.aborted ||
          !sameWorkspaceTrust(candidatePrimaryScope.workspaceTrust, preFallbackTrust)
        ) {
          throw new V2ProviderStartupError(
            reasonCode,
            error.deliveryState,
            'fallback_scope_mismatch',
          );
        }
        if (!providerStatusMatchesFrozenScope(redetectedStatus, candidatePrimaryScope)) {
          throw new V2ProviderStartupError(
            reasonCode,
            error.deliveryState,
            'fallback_provider_scope_changed',
          );
        }

        // This is deliberately not a loop: one verified pre-delivery app-server failure can start
        // one pinned legacy process, and a failure of that process is returned as-is.
        session = this.sessions.create(
          input.provider,
          input.cwd,
          input.prompt,
          undefined,
          2,
          workspace,
          redetectedStatus,
          'workspace-write',
          candidateFallback.frozenScope.model,
          reserve(
            candidateFallback.selection,
            false,
            freezeProviderContinuationScope({
              status: redetectedStatus,
              cwd: input.cwd,
              workspaceTrust: preFallbackTrust,
            }),
            safeRuntimeMetadata(candidateFallback.runtimeMetadata),
          ),
        );
        launchProviderStatus = redetectedStatus;
        activeSelection = candidateFallback.selection;
        activeInteractive = false;
        fallbackRuntimeMetadata = safeRuntimeMetadata({
          ...candidateFallback.runtimeMetadata,
          fallbackReason: reasonCode,
        });
      }
      const providerMetadata = activeInteractive
        ? this.sessions.interactiveProviderMetadata(session.id)
        : undefined;
      const runtimeMetadata =
        safeRuntimeMetadata(providerMetadata?.runtimeMetadata) ?? fallbackRuntimeMetadata;
      const actualContinuationEvidence =
        providerMetadata?.continuationEvidence ??
        (launchProviderStatus?.accountFingerprint && launchProviderStatus.selectedModel
          ? {
              accountFingerprint: launchProviderStatus.accountFingerprint,
              selectedModel: launchProviderStatus.selectedModel,
            }
          : undefined);
      if (
        input.continuation &&
        expectedContinuationEvidence &&
        (!actualContinuationEvidence ||
          actualContinuationEvidence.accountFingerprint !==
            expectedContinuationEvidence.accountFingerprint ||
          actualContinuationEvidence.selectedModel !== expectedContinuationEvidence.selectedModel)
      ) {
        await this.sessions.remove(session.id);
        throw new V2ProviderStartupError(
          'continuation_scope_mismatch',
          'delivered',
          'continuation_scope_mismatch',
        );
      }
      continuationScope = launchProviderStatus
        ? freezeProviderContinuationScope({
            status: launchProviderStatus,
            cwd: input.cwd,
            workspaceTrust: currentWorkspaceTrust,
            ...(actualContinuationEvidence ? { evidence: actualContinuationEvidence } : {}),
          })
        : undefined;
      const metadata: V2SessionMetadata = {
        sessionId: session.id,
        selection: activeSelection,
        executionId,
        rootExecutionId,
        ...(lineage ? { parentSessionId: lineage.parentSessionId } : {}),
        ...(lineage ? { parentExecutionId: lineage.parentExecutionId } : {}),
        continuationKind,
        turnId,
        events: new Map(),
        listeners: new Set(),
        replayBytes: 0,
        nextSequence: 0,
        nativeTools: new Map(),
        interactive: activeInteractive,
        status: v2Status(session.status),
        acceptedWork: activeInteractive ? 'not_accepted' : 'unknown',
        pendingInteractions: new Map(),
        ...(providerMetadata?.providerSessionId
          ? { providerSessionId: providerMetadata.providerSessionId }
          : {}),
        ...(runtimeMetadata ? { runtimeMetadata } : {}),
        ...(continuationScope ? { continuationScope } : {}),
        ...(continuationLease ? { continuationLease } : {}),
      };
      if (metadata.providerSessionId && continuationScope) {
        const reuseResumedSource =
          input.continuation?.kind === 'resume' &&
          metadata.providerSessionId === input.continuation.providerSessionId;
        if (metadata.providerSessionId !== continuationLease?.providerSessionId) {
          try {
            this.graph.acquireContinuation(
              session.provider,
              metadata.providerSessionId,
              executionId,
            );
          } catch (error) {
            await this.sessions.remove(session.id, 2);
            throw error;
          }
          continuationTargetLease = {
            provider: session.provider,
            providerSessionId: metadata.providerSessionId,
            leaseId: executionId,
          };
          metadata.continuationTargetLease = continuationTargetLease;
        }
        const bound = this.bindContinuation(
          session.provider,
          metadata.providerSessionId,
          session.id,
          continuationScope,
          executionId,
          reuseResumedSource,
        );
        if (!bound) {
          await this.sessions.remove(session.id);
          throw new V2ProviderStartupError(
            'continuation_binding_collision',
            'delivered',
            'continuation_binding_collision',
          );
        }
      }
      this.metadata.set(session.id, metadata);
      try {
        this.graph.update(this.durableRecord(session, metadata));
      } catch (error) {
        this.metadata.delete(session.id);
        await this.sessions.remove(session.id);
        throw error;
      }
      reservedSessionIds.delete(session.id);
      if (activeInteractive) this.attachInteractiveSource(session.id, metadata);
      else this.attachSource(session.id, metadata);
      retainContinuationLease = true;
      return this.project(session) as AgentSessionV2;
    } finally {
      if (continuationLease && !retainContinuationLease) {
        this.releaseContinuationLease(
          continuationLease.provider,
          continuationLease.providerSessionId,
          continuationLease.leaseId,
        );
      }
      if (continuationTargetLease && !retainContinuationLease) {
        this.releaseContinuationLease(
          continuationTargetLease.provider,
          continuationTargetLease.providerSessionId,
          continuationTargetLease.leaseId,
        );
      }
      if (!retainContinuationLease) discardReservations();
    }
  }

  get(id: string): AgentSessionV2 | undefined {
    this.prune();
    return this.graph.get(id)?.session;
  }

  list(query: SessionListV2Query = {}): SessionListV2Page {
    return this.graph.list(query);
  }

  history(
    id: string,
    query: SessionEventHistoryV2Query = {},
  ): SessionEventHistoryV2Page | undefined {
    return this.graph.history(id, query);
  }

  buildContinuation(
    parentSessionId: string,
    kind: 'resume' | 'fork',
    input: SessionContinuationInputV2,
  ): { request: CreateSessionV2Request; lineage: V2LineageContext } {
    const parent = this.get(parentSessionId);
    if (!parent) throw new V2ContinuationError('session_not_found', 'session not found');
    if (!isTerminalStatus(parent.status)) {
      throw new V2ContinuationError(
        'continuation_parent_active',
        'continuation requires a terminal parent session',
      );
    }
    if (!parent.providerSessionId) {
      throw new V2ContinuationError(
        'continuation_not_found',
        'parent has no provider-native session identifier',
      );
    }
    const record = this.graph.get(parentSessionId);
    if (!record?.continuationScope) {
      throw new V2ContinuationError(
        'continuation_binding_not_found',
        'parent has no durable continuation binding',
      );
    }
    const binding = this.continuationBindings.get(
      continuationKey(parent.provider, parent.providerSessionId),
    );
    if (!binding || binding.sessionId !== parentSessionId) {
      throw new V2ContinuationError(
        'continuation_binding_not_found',
        'parent no longer owns the provider-native continuation',
      );
    }
    return {
      request: {
        provider: parent.provider,
        cwd: parent.cwd,
        prompt: input.prompt,
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        continuation: { kind, providerSessionId: parent.providerSessionId },
      },
      lineage: {
        rootExecutionId: parent.rootExecutionId ?? parent.executionId,
        parentSessionId,
        parentExecutionId: parent.executionId,
        continuationKind: kind,
      },
    };
  }

  hasCapability(id: string, capabilityId: string): boolean {
    const metadata = this.metadata.get(id);
    return metadata?.selection.enabled.some((entry) => entry.id === capabilityId) ?? false;
  }

  isActive(id: string): boolean {
    const status = this.metadata.get(id)?.status;
    return status === 'starting' || status === 'active' || status === 'idle';
  }

  dispatch(command: AgentCommandV2): Promise<DispatchResult> {
    const metadata = this.metadata.get(command.sessionId);
    if (!metadata) {
      return Promise.resolve({
        ok: false,
        code: 'session_not_found',
        message: 'session not found',
      });
    }
    const capability = this.commandCapability(command);
    if (!this.hasCapability(command.sessionId, capability)) {
      return this.sessions.dispatch(command.sessionId, command, 'session_not_capable');
    }
    if (!this.commandMatchesSelection(metadata, capability, command)) {
      return this.sessions.dispatch(command.sessionId, command, 'command_out_of_bounds');
    }
    if (!this.commandMatchesState(metadata, command)) {
      return this.sessions.dispatch(
        command.sessionId,
        command,
        command.type === 'approval.respond' || command.type === 'question.respond'
          ? 'stale_interaction'
          : 'session_terminal',
      );
    }
    return this.sessions.dispatch(command.sessionId, command);
  }

  replayWindow(id: string): { earliestSequence: number; nextSequence: number } | undefined {
    const metadata = this.metadata.get(id);
    if (!metadata) return undefined;
    return {
      earliestSequence: metadata.events.keys().next().value ?? metadata.nextSequence,
      nextSequence: metadata.nextSequence,
    };
  }

  async cancel(id: string): Promise<boolean> {
    if (!this.metadata.has(id)) return false;
    return this.sessions.cancel(id, 2);
  }

  async remove(id: string): Promise<boolean> {
    const target = this.graph.get(id);
    if (!target) return false;
    const rootExecutionId = target.session.rootExecutionId ?? target.session.executionId;
    const lineageIds = this.storedSessions()
      .filter((session) => (session.rootExecutionId ?? session.executionId) === rootExecutionId)
      .map((session) => session.id);
    if (!this.graph.deleteLineage(id)) return false;
    for (const sessionId of lineageIds) {
      await this.sessions.remove(sessionId, 2);
      const metadata = this.metadata.get(sessionId);
      this.releaseMetadataContinuationLeases(metadata);
      metadata?.sourceUnsubscribe?.();
      this.metadata.delete(sessionId);
    }
    return true;
  }

  /** Replays the bounded normalized v2 window, then delivers live normalized events. */
  subscribe(
    id: string,
    sinceSequence: number,
    listener: (sequence: number, event: AgentEventV2Envelope) => void,
  ): (() => void) | undefined {
    const metadata = this.metadata.get(id);
    if (!metadata) return undefined;
    for (const [sequence, stored] of metadata.events) {
      if (sequence >= sinceSequence) listener(sequence, stored.event);
    }
    metadata.listeners.add(listener);
    return () => metadata.listeners.delete(listener);
  }

  claimResponder(id: string): string | undefined {
    const metadata = this.metadata.get(id);
    if (!metadata || metadata.responderLease) return undefined;
    const lease = randomBytes(32).toString('base64url');
    metadata.responderLease = lease;
    return lease;
  }

  hasResponderLease(id: string, candidate: string | undefined): boolean {
    const metadata = this.metadata.get(id);
    const lease = metadata?.responderLease;
    if (!lease || !candidate || !RESPONDER_LEASE_PATTERN.test(candidate)) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(lease));
  }

  releaseResponder(id: string, lease: string): void {
    const metadata = this.metadata.get(id);
    if (!metadata || !this.hasResponderLease(id, lease)) return;
    delete metadata.responderLease;
    void this.sessions.responderDisconnected(id);
  }

  markInteractionPublished(id: string, requestId: string): boolean {
    return this.sessions.markInteractionPublished(id, requestId);
  }

  private initialRecord(
    session: Readonly<AgentSession>,
    selection: CapabilitySelection,
    interactive: boolean,
    executionId: string,
    turnId: string,
    rootExecutionId: string,
    continuationKind: 'fresh' | 'resume' | 'fork',
    lineage?: V2LineageContext,
    continuationScope?: ProviderContinuationScope,
    runtimeMetadata?: ProviderRuntimeMetadataV2,
  ): DurableExecutionRecord {
    const projected = agentSessionV2Schema.parse({
      id: session.id,
      provider: session.provider,
      transport: selection.transport,
      cwd: session.cwd,
      status: 'starting',
      selection,
      executionId,
      rootExecutionId,
      ...(lineage ? { parentSessionId: lineage.parentSessionId } : {}),
      ...(lineage ? { parentExecutionId: lineage.parentExecutionId } : {}),
      continuationKind,
      currentTurnId: turnId,
      acceptedWork: interactive ? 'not_accepted' : 'unknown',
      startedAt: session.startedAt,
      ...(runtimeMetadata ? { runtimeMetadata } : {}),
      earliestSequence: 0,
    });
    return {
      session: projected,
      interactive,
      ...(continuationScope ? { continuationScope } : {}),
    };
  }

  private durableRecord(
    session: AgentSession,
    metadata: V2SessionMetadata,
  ): DurableExecutionRecord {
    return {
      session: this.project(session),
      interactive: metadata.interactive,
      ...(metadata.continuationScope ? { continuationScope: metadata.continuationScope } : {}),
    };
  }

  private hydrate(): void {
    for (const storedSession of this.storedSessions().sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt),
    )) {
      const record = this.graph.get(storedSession.id);
      if (!record) continue;
      const metadata: V2SessionMetadata = {
        sessionId: storedSession.id,
        selection: storedSession.selection,
        executionId: storedSession.executionId,
        rootExecutionId: storedSession.rootExecutionId ?? storedSession.executionId,
        ...(storedSession.parentSessionId
          ? { parentSessionId: storedSession.parentSessionId }
          : {}),
        ...(storedSession.parentExecutionId
          ? { parentExecutionId: storedSession.parentExecutionId }
          : {}),
        continuationKind: storedSession.continuationKind ?? 'fresh',
        turnId: storedSession.currentTurnId ?? storedSession.executionId,
        events: new Map(),
        listeners: new Set(),
        replayBytes: 0,
        nextSequence: storedSession.earliestSequence,
        nativeTools: new Map(),
        interactive: record.interactive,
        status: storedSession.status,
        acceptedWork: storedSession.acceptedWork,
        ...(storedSession.terminalReason ? { terminalReason: storedSession.terminalReason } : {}),
        pendingInteractions: new Map(),
        ...(storedSession.providerSessionId
          ? { providerSessionId: storedSession.providerSessionId }
          : {}),
        ...(storedSession.runtimeMetadata
          ? { runtimeMetadata: storedSession.runtimeMetadata }
          : {}),
        ...(record.continuationScope ? { continuationScope: record.continuationScope } : {}),
      };
      let cursor: string | undefined;
      do {
        const page = this.graph.history(storedSession.id, {
          ...(cursor ? { cursor } : {}),
          limit: 100,
        });
        if (!page) break;
        for (const event of page.events) {
          this.retainReplayEvent(metadata, event);
          this.applyEventState(metadata, event);
        }
        cursor = page.nextCursor;
      } while (cursor);
      metadata.status = storedSession.status;
      metadata.acceptedWork = storedSession.acceptedWork;
      if (storedSession.terminalReason) metadata.terminalReason = storedSession.terminalReason;
      this.metadata.set(storedSession.id, metadata);
      if (metadata.providerSessionId && metadata.continuationScope) {
        this.bindContinuation(
          storedSession.provider,
          metadata.providerSessionId,
          storedSession.id,
          metadata.continuationScope,
          undefined,
          true,
        );
      }
    }
  }

  private storedSessions(): AgentSessionV2[] {
    const sessions: AgentSessionV2[] = [];
    let cursor: string | undefined;
    do {
      const page = this.graph.list({ ...(cursor ? { cursor } : {}), limit: 100 });
      sessions.push(...page.sessions);
      cursor = page.nextCursor;
    } while (cursor);
    return sessions;
  }

  private project(session: AgentSession): AgentSessionV2 {
    const metadata = this.metadata.get(session.id);
    if (!metadata) throw new Error(`missing v2 metadata for session: ${session.id}`);
    if (metadata.interactive && this.sessions.isInteractive(session.id)) {
      metadata.acceptedWork = this.sessions.acceptedWork(session.id);
    }
    return agentSessionV2Schema.parse({
      id: session.id,
      provider: session.provider,
      transport: metadata.selection.transport,
      cwd: session.cwd,
      status: metadata.status,
      selection: metadata.selection,
      executionId: metadata.executionId,
      rootExecutionId: metadata.rootExecutionId,
      ...(metadata.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
      ...(metadata.parentExecutionId ? { parentExecutionId: metadata.parentExecutionId } : {}),
      continuationKind: metadata.continuationKind,
      currentTurnId: metadata.turnId,
      acceptedWork: metadata.acceptedWork,
      startedAt: session.startedAt,
      ...(session.completedAt === undefined ? {} : { completedAt: session.completedAt }),
      ...(metadata.terminalReason === undefined ? {} : { terminalReason: metadata.terminalReason }),
      ...(metadata.providerSessionId === undefined
        ? {}
        : { providerSessionId: metadata.providerSessionId }),
      ...(metadata.runtimeMetadata === undefined
        ? {}
        : { runtimeMetadata: metadata.runtimeMetadata }),
      earliestSequence: this.replayWindow(session.id)?.earliestSequence ?? 0,
    }) as AgentSessionV2;
  }

  private bindContinuation(
    provider: AgentSessionV2['provider'],
    providerSessionId: string,
    sessionId: string,
    scope: ProviderContinuationScope,
    leaseId?: string,
    allowExisting = false,
  ): boolean {
    const key = continuationKey(provider, providerSessionId);
    const existing = this.continuationBindings.get(key);
    if (existing && !providerContinuationScopesEqual(existing.scope, scope)) return false;
    if (existing && !allowExisting) return false;
    if (leaseId && existing?.leaseId && existing.leaseId !== leaseId) return false;
    const next = existing ?? { sessionId, scope };
    next.sessionId = sessionId;
    next.scope = scope;
    if (leaseId) next.leaseId = leaseId;
    this.continuationBindings.delete(key);
    while (!existing && this.continuationBindings.size >= MAX_CONTINUATION_BINDINGS) {
      const oldest = [...this.continuationBindings].find(([, binding]) => !binding.leaseId)?.[0];
      if (!oldest) return false;
      this.continuationBindings.delete(oldest);
    }
    this.continuationBindings.set(key, next);
    return true;
  }

  private releaseContinuationLease(
    provider: AgentSessionV2['provider'],
    providerSessionId: string,
    leaseId: string,
  ): void {
    const binding = this.continuationBindings.get(continuationKey(provider, providerSessionId));
    if (binding?.leaseId === leaseId) delete binding.leaseId;
    this.graph.releaseContinuation(provider, providerSessionId, leaseId);
  }

  private releaseMetadataContinuationLeases(metadata: V2SessionMetadata | undefined): void {
    if (!metadata) return;
    if (metadata.continuationLease) {
      this.releaseContinuationLease(
        metadata.continuationLease.provider,
        metadata.continuationLease.providerSessionId,
        metadata.continuationLease.leaseId,
      );
    }
    if (metadata.continuationTargetLease) {
      this.releaseContinuationLease(
        metadata.continuationTargetLease.provider,
        metadata.continuationTargetLease.providerSessionId,
        metadata.continuationTargetLease.leaseId,
      );
    }
    delete metadata.continuationLease;
    delete metadata.continuationTargetLease;
  }

  private attachSource(id: string, metadata: V2SessionMetadata): void {
    let ended = false;
    let unsubscribe: (() => void) | undefined;
    // eslint-disable-next-line prefer-const
    unsubscribe = this.sessions.subscribe(
      id,
      0,
      (_sourceSequence, sourceEvent) => {
        if (sourceEvent.type === 'session.completed' && sourceEvent.providerSessionId) {
          const providerSessionId = providerSessionIdV2Schema.safeParse(
            sourceEvent.providerSessionId,
          );
          if (providerSessionId.success) {
            metadata.providerSessionId = providerSessionId.data;
            if (metadata.continuationScope) {
              const provider =
                this.sessions.get(id, 2)?.provider ?? this.graph.get(id)?.session.provider;
              if (!provider) throw new Error(`missing provider for session: ${id}`);
              this.bindContinuation(
                provider,
                providerSessionId.data,
                id,
                metadata.continuationScope,
              );
            }
          }
        }
        for (const event of this.convert(id, metadata, sourceEvent)) {
          try {
            this.publish(metadata, event);
          } catch (error) {
            if (!isTerminal(event)) void this.sessions.cancel(id).catch(() => undefined);
            throw error;
          } finally {
            if (isTerminal(event)) {
              ended = true;
              this.releaseMetadataContinuationLeases(metadata);
              metadata.sourceUnsubscribe?.();
              metadata.sourceUnsubscribe = undefined;
            }
          }
        }
      },
      2,
    );
    if (!unsubscribe) throw new Error(`missing v2 runtime for session: ${id}`);
    metadata.sourceUnsubscribe = unsubscribe;
    if (ended) {
      unsubscribe();
      metadata.sourceUnsubscribe = undefined;
    }
  }

  private attachInteractiveSource(id: string, metadata: V2SessionMetadata): void {
    let ended = false;
    let unsubscribe: (() => void) | undefined;
    // eslint-disable-next-line prefer-const
    unsubscribe = this.sessions.subscribeInteractive(id, 0, (sourceIndex, sourceEvent) => {
      const session = this.sessions.get(id, 2);
      if (!session) return;
      const event = agentEventV2EnvelopeSchema.parse({
        ...(sourceEvent.type === 'session.started'
          ? {
              ...sourceEvent,
              provider: session.provider,
              transport: metadata.selection.transport,
              selection: metadata.selection,
            }
          : sourceEvent),
        sessionId: id,
        executionId: metadata.executionId,
        ...(metadata.parentExecutionId === undefined
          ? {}
          : { parentExecutionId: metadata.parentExecutionId }),
        // SessionManager indices remain absolute across its own sliding retention window. If a
        // provider burst raced creation, preserve that gap instead of renumbering retained events.
        sequence: sourceIndex,
        timestamp: new Date().toISOString(),
      });
      try {
        this.publish(metadata, event);
      } catch (error) {
        if (!isTerminal(event)) void this.sessions.cancel(id).catch(() => undefined);
        throw error;
      } finally {
        if (isTerminal(event)) {
          ended = true;
          this.releaseMetadataContinuationLeases(metadata);
          metadata.sourceUnsubscribe?.();
          metadata.sourceUnsubscribe = undefined;
        }
      }
    });
    if (!unsubscribe) throw new Error(`missing interactive v2 runtime for session: ${id}`);
    metadata.sourceUnsubscribe = unsubscribe;
    if (ended) {
      unsubscribe();
      metadata.sourceUnsubscribe = undefined;
    }
  }

  private publish(metadata: V2SessionMetadata, event: AgentEventV2Envelope): void {
    this.record(metadata, this.eventForPersistence(event));
    for (const listener of [...metadata.listeners]) {
      try {
        listener(event.sequence, event);
      } catch {
        // A subscriber owns only its connection. It cannot fail provider consumption or peers.
      }
    }
  }

  private eventForPersistence(event: AgentEventV2Envelope): AgentEventV2Envelope {
    if (event.type === 'session.cancelled' || event.type === 'session.interrupted') {
      return agentEventV2EnvelopeSchema.parse({
        ...event,
        reason: boundedTerminalReason(
          event.reason,
          event.type === 'session.cancelled' ? 'cancelled' : 'interrupted',
        ),
      }) as AgentEventV2Envelope;
    }
    if (
      event.type === 'content.completed' &&
      event.block.type === 'provider_extension' &&
      event.block.representation === 'bounded_data' &&
      !event.block.safeToPersist
    ) {
      return agentEventV2EnvelopeSchema.parse({
        ...event,
        block: {
          type: 'provider_extension',
          id: event.block.id,
          extensionName: event.block.extensionName,
          ...(event.block.extensionVersion === undefined
            ? {}
            : { extensionVersion: event.block.extensionVersion }),
          representation: 'safe_summary',
          safeSummary: event.block.safeSummary,
          reason: 'persistence_disallowed',
        },
      }) as AgentEventV2Envelope;
    }
    return event;
  }

  private record(metadata: V2SessionMetadata, event: AgentEventV2Envelope): void {
    this.graph.appendEvent(metadata.sessionId, event);
    this.retainReplayEvent(metadata, event);
    this.applyEventState(metadata, event);
    const session = this.sessions.get(metadata.sessionId, 2);
    if (session) this.graph.update(this.durableRecord(session, metadata));
  }

  private retainReplayEvent(metadata: V2SessionMetadata, event: AgentEventV2Envelope): void {
    const bytes = utf8ByteLength(JSON.stringify(event));
    while (
      metadata.events.size > 0 &&
      (metadata.events.size >= MAX_REPLAY_EVENTS || metadata.replayBytes + bytes > MAX_REPLAY_BYTES)
    ) {
      const oldestSequence = metadata.events.keys().next().value as number;
      const oldest = metadata.events.get(oldestSequence);
      metadata.events.delete(oldestSequence);
      metadata.replayBytes -= oldest?.bytes ?? 0;
    }
    metadata.events.set(event.sequence, { event, bytes });
    metadata.replayBytes += bytes;
    metadata.nextSequence = Math.max(metadata.nextSequence, event.sequence + 1);
  }

  private applyEventState(metadata: V2SessionMetadata, event: AgentEventV2Envelope): void {
    switch (event.type) {
      case 'session.status':
        metadata.status = event.status;
        break;
      case 'session.completed':
        metadata.status = 'completed';
        metadata.terminalReason = 'completed';
        metadata.pendingInteractions.clear();
        break;
      case 'session.failed':
        metadata.status = 'failed';
        metadata.terminalReason = event.code ?? 'failed';
        metadata.pendingInteractions.clear();
        break;
      case 'session.cancelled':
        metadata.status = 'cancelled';
        metadata.terminalReason = boundedTerminalReason(event.reason, 'cancelled');
        metadata.pendingInteractions.clear();
        break;
      case 'session.interrupted':
        metadata.status = 'interrupted';
        metadata.terminalReason = boundedTerminalReason(event.reason, 'interrupted');
        metadata.pendingInteractions.clear();
        break;
      case 'turn.started':
        metadata.turnId = event.turnId;
        metadata.status = 'active';
        break;
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.interrupted':
        metadata.status = 'idle';
        break;
      case 'approval.requested':
        metadata.pendingInteractions.set(event.requestId, {
          kind: 'approval',
          turnId: event.turnId,
        });
        break;
      case 'question.requested':
        metadata.pendingInteractions.set(event.requestId, {
          kind: 'question',
          turnId: event.turnId,
        });
        break;
      case 'approval.resolved':
      case 'question.resolved':
      case 'question.cancelled':
        metadata.pendingInteractions.delete(event.requestId);
        break;
      default:
        break;
    }
  }

  private commandCapability(command: AgentCommandV2): string {
    switch (command.type) {
      case 'input.follow_up':
        return 'session.input.follow_up';
      case 'input.steer':
        return 'session.input.steer';
      case 'session.interrupt':
        return 'session.interrupt';
      case 'approval.respond':
        return 'interaction.approval';
      case 'question.respond':
        return 'interaction.question';
    }
  }

  private commandMatchesSelection(
    metadata: V2SessionMetadata,
    capabilityId: string,
    command: AgentCommandV2,
  ): boolean {
    const constraints = metadata.selection.enabled.find(
      (entry) => entry.id === capabilityId,
    )?.constraints;
    if (!constraints) return false;
    if (command.type === 'input.follow_up' || command.type === 'input.steer') {
      if (constraints.kind !== 'text_input') return false;
      let characters = 0;
      for (const block of command.content) {
        if (block.type === 'text') characters += block.text.length;
        else if (block.type === 'image' || block.type === 'file') {
          if (!constraints.attachmentKinds.includes(block.type)) return false;
        } else characters += JSON.stringify(block.data).length;
      }
      return characters <= constraints.maxCharacters;
    }
    if (command.type === 'approval.respond' || command.type === 'question.respond') {
      return (
        constraints.kind === 'interaction' &&
        utf8ByteLength(JSON.stringify(command)) <= constraints.maxPayloadBytes
      );
    }
    return constraints.kind === 'acknowledgement';
  }

  private commandMatchesState(metadata: V2SessionMetadata, command: AgentCommandV2): boolean {
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(metadata.status)) return false;
    switch (command.type) {
      case 'input.follow_up':
        return metadata.status === 'idle';
      case 'input.steer':
      case 'session.interrupt':
        return metadata.status === 'active' && metadata.turnId === command.turnId;
      case 'approval.respond':
      case 'question.respond':
        // The supervisor owns the atomic interaction tuple. Let an identical post-resolution
        // retry reach SessionManager's command ledger; a new stale id reaches the supervisor and
        // deterministically returns stale_interaction without provider redispatch.
        return true;
    }
  }

  private convert(
    id: string,
    metadata: V2SessionMetadata,
    event: AgentEventEnvelope,
  ): AgentEventV2Envelope[] {
    const common = {
      sessionId: id,
      executionId: metadata.executionId,
      ...(metadata.parentExecutionId === undefined
        ? {}
        : { parentExecutionId: metadata.parentExecutionId }),
      sequence: metadata.nextSequence,
      timestamp: event.timestamp,
    };
    const turn = { turnId: metadata.turnId };
    const selected = (capabilityId: string) =>
      metadata.selection.enabled.some((entry) => entry.id === capabilityId);
    let converted: unknown;

    switch (event.type) {
      case 'session.started':
        converted = {
          ...common,
          type: 'session.started',
          provider: event.provider,
          transport: metadata.selection.transport,
          selection: metadata.selection,
        };
        break;
      case 'status':
        converted = { ...common, type: 'session.status', status: 'active' };
        break;
      case 'assistant.message':
        converted =
          utf8ByteLength(event.text) <= MAX_CONTENT_BYTES
            ? {
                ...common,
                ...turn,
                type: 'content.completed',
                block: { type: 'text', id: randomUUID(), text: event.text },
              }
            : this.extensionSummary(
                common,
                turn,
                'legacy.assistant.message',
                'assistant message exceeded the v2 content-block limit',
                'truncated',
              );
        break;
      case 'thinking.delta':
        // V1 has no stable content-block boundary for thinking deltas, so a core content.delta
        // would invent correlation that cannot ever be completed reliably.
        converted = this.extensionSummary(
          common,
          turn,
          'legacy.thinking',
          'legacy thinking observation has no stable v2 content-block correlation',
          selected('content.thinking') ? 'unsupported' : 'capability_drift',
        );
        break;
      case 'tool.started':
        converted =
          this.canEmitLegacyTool(metadata) &&
          event.toolCallId &&
          event.toolName.length > 0 &&
          utf8ByteLength(event.toolName) <= MAX_WIRE_STRING_BYTES
            ? this.toolStarted(common, turn, metadata, event)
            : this.extensionSummary(
                common,
                turn,
                'legacy.tool.started',
                event.toolCallId
                  ? `tool effects exceed the selected legacy observation subset: ${event.toolName}`
                  : `tool start had no stable correlation id: ${event.toolName}`,
                event.toolCallId ? 'capability_drift' : 'unsupported',
              );
        break;
      case 'tool.completed':
        converted =
          this.canEmitLegacyTool(metadata) && event.toolCallId
            ? this.toolCompleted(common, turn, metadata, event)
            : this.extensionSummary(
                common,
                turn,
                'legacy.tool.completed',
                event.toolCallId
                  ? `tool effects exceed the selected legacy observation subset: ${event.toolName ?? 'unknown tool'}`
                  : `tool completion had no stable correlation id: ${event.toolName ?? 'unknown tool'}`,
                event.toolCallId ? 'capability_drift' : 'unsupported',
              );
        break;
      case 'usage':
        converted =
          !validTokenCount(event.inputTokens) ||
          !validTokenCount(event.outputTokens) ||
          !validTokenCount(event.cachedInputTokens)
            ? this.extensionSummary(
                common,
                turn,
                'legacy.usage',
                'usage frame contained invalid token counts',
                'unsupported',
              )
            : selected('content.usage.tokens') &&
                (event.inputTokens !== undefined ||
                  event.outputTokens !== undefined ||
                  event.cachedInputTokens !== undefined)
              ? {
                  ...common,
                  ...turn,
                  type: 'usage.tokens',
                  scope: 'turn',
                  ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
                  ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
                  ...(event.cachedInputTokens === undefined
                    ? {}
                    : { cachedInputTokens: event.cachedInputTokens }),
                }
              : this.extensionSummary(
                  common,
                  turn,
                  event.cost === undefined ? 'legacy.usage' : 'legacy.usage.cost',
                  event.cost === undefined
                    ? 'unselected usage observation'
                    : 'usage frame contained cost data without selected token data',
                  'capability_drift',
                );
        break;
      case 'error':
        converted = {
          ...common,
          ...turn,
          type: 'error',
          ...(event.code === undefined
            ? {}
            : { code: truncateUtf8(event.code, MAX_WIRE_STRING_BYTES) || 'legacy_error' }),
          message: truncateUtf8(event.message, MAX_CONTENT_BYTES),
          recoverable: event.recoverable,
        };
        break;
      case 'session.completed':
        converted = { ...common, type: 'session.completed' };
        break;
      case 'session.failed':
        converted = {
          ...common,
          type: 'session.failed',
          message: truncateUtf8(event.message, MAX_CONTENT_BYTES),
        };
        break;
      case 'session.cancelled':
        converted = { ...common, type: 'session.cancelled' };
        break;
    }

    const primary = agentEventV2EnvelopeSchema.parse(converted);
    if (event.type === 'usage' && event.cost !== undefined && primary.type === 'usage.tokens') {
      const costSummary = agentEventV2EnvelopeSchema.parse(
        this.extensionSummary(
          { ...common, sequence: primary.sequence + 1 },
          turn,
          'legacy.usage.cost',
          'legacy usage included cost without a trustworthy currency',
          'capability_drift',
        ),
      );
      return [primary, costSummary];
    }
    return [primary];
  }

  private toolStarted(
    common: Record<string, unknown>,
    turn: { turnId: string },
    metadata: V2SessionMetadata,
    event: Extract<AgentEventEnvelope, { type: 'tool.started' }>,
  ): unknown {
    const correlation: ToolCorrelation = {
      toolCallId: randomUUID(),
      contentBlockId: randomUUID(),
      toolName: event.toolName,
    };
    metadata.nativeTools.set(event.toolCallId as string, correlation);
    return {
      ...common,
      ...turn,
      type: 'tool.started',
      ...correlation,
      possibleEffects: [
        'read',
        'filesystem_write',
        'command',
        'network',
        'external_side_effect',
        'destructive',
      ],
      effectsComplete: false,
    };
  }

  private toolCompleted(
    common: Record<string, unknown>,
    turn: { turnId: string },
    metadata: V2SessionMetadata,
    event: Extract<AgentEventEnvelope, { type: 'tool.completed' }>,
  ): unknown {
    const correlation = event.toolCallId ? metadata.nativeTools.get(event.toolCallId) : undefined;
    if (!correlation) {
      return this.extensionSummary(
        common,
        turn,
        'legacy.tool.completed',
        `tool completion had no stable correlation: ${event.toolName ?? 'unknown tool'}`,
        'unsupported',
      );
    }
    metadata.nativeTools.delete(event.toolCallId as string);
    return {
      ...common,
      ...turn,
      type: 'tool.completed',
      ...correlation,
      status: event.isError ? 'failed' : 'completed',
      summary: event.isError ? 'Tool reported an error' : 'Tool completed',
    };
  }

  private canEmitLegacyTool(metadata: V2SessionMetadata): boolean {
    const selected = metadata.selection.enabled.find((entry) => entry.id === 'content.tools');
    const constraints = selected?.constraints;
    return (
      constraints?.kind === 'effects' &&
      ALL_EFFECTS.every((effect) => constraints.allowedEffects.includes(effect))
    );
  }

  private extensionSummary(
    common: Record<string, unknown>,
    turn: { turnId: string },
    extensionName: string,
    summary: string,
    reason: 'unsupported' | 'capability_drift' | 'truncated',
  ): unknown {
    return {
      ...common,
      ...turn,
      type: 'extension.summary',
      extensionName,
      summary: boundedSummary(summary),
      reason,
    };
  }

  private prune(): void {
    for (const [id, metadata] of this.metadata) {
      if (!this.graph.get(id)) {
        this.releaseMetadataContinuationLeases(metadata);
        metadata.sourceUnsubscribe?.();
        this.metadata.delete(id);
      }
    }
  }
}
