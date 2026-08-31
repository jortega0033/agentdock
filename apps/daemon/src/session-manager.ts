import { randomUUID } from 'node:crypto';
import {
  isApprovalDecisionAllowed,
  permissionKey,
  utf8ByteLength,
  type AgentCommandV2,
  type AgentEvent,
  type AgentEventEnvelope,
  type AgentEventV2,
  type AgentSession,
  type CapabilitySelection,
  type CommandAcknowledgementV2,
  type AuditActorV2,
  type ApprovalDecisionV2,
  type PermissionActionV2,
  type ProviderId,
  type ProviderStatus,
  type ProviderTransportV2,
  type SessionContinuationV2,
} from '@agent-dock/shared';
import {
  InteractiveSessionError,
  type AcceptedWorkState,
  type InteractiveProviderSessionHandle,
  type Logger,
  type ProviderRuntimeMetadata,
  type ProviderContinuationEvidence,
  type ProviderDetectionOptions,
  type ProviderRegistry,
  type ProviderSessionHandle,
  type StartSessionOptions,
  type WorkspaceTrustEvidence,
} from '@agent-dock/agent-runtime';
import { MemorySessionStore, type SessionStore } from './session-store.js';
import type { AuditStore } from './audit-store.js';
import {
  InteractionState,
  type InteractionResolutionReason,
  type PendingInteraction,
} from './interaction-state.js';
import { evaluatePermissionPolicy, normalizeApprovalAction } from './permission-policy.js';
import type { WorkspaceTrustStore } from './workspace-trust-store.js';
import { revalidateWorkspaceIdentity, type WorkspaceIdentity } from './workspace-identity.js';

interface RuntimeStateBase {
  protocolVersion: 1 | 2;
  workspace?: WorkspaceIdentity;
  /** Resolves only after the provider stream terminates and its supervisor has reaped the host. */
  done: Promise<void>;
}

interface LegacyRuntimeState extends RuntimeStateBase {
  kind: 'legacy';
  handle: ProviderSessionHandle;
  events: AgentEventEnvelope[];
  listeners: Set<(index: number, event: AgentEventEnvelope) => void>;
  nextSequence: number;
}

interface CommandRecord {
  canonicalPayload: string;
  result: Promise<DispatchResult>;
}

interface StoredInteractiveEvent {
  event: AgentEventV2;
  bytes: number;
}

interface InteractiveRuntimeState extends RuntimeStateBase {
  kind: 'interactive';
  protocolVersion: 2;
  handle: InteractiveProviderSessionHandle;
  events: Map<number, StoredInteractiveEvent>;
  replayBytes: number;
  nextEventIndex: number;
  listeners: Set<(index: number, event: AgentEventV2) => void>;
  acceptedWork: AcceptedWorkState;
  dispatchTail: Promise<void>;
  pendingCommands: number;
  pendingCommandBytes: number;
  commandLedger: Map<string, CommandRecord>;
  reservedInteractionCommands: Map<string, string>;
  interactions: InteractionState;
  approvalActions: Map<string, PermissionActionV2>;
  sessionGrants: Set<string>;
  transport: string;
  providerSessionId?: string;
  runtimeMetadata?: Readonly<ProviderRuntimeMetadata>;
  continuationEvidence?: Readonly<ProviderContinuationEvidence>;
}

interface PendingInteractiveStart {
  protocolVersion: 2;
  controller: AbortController;
  done: Promise<void>;
  workspaceId?: string;
  workspaceEpoch?: number;
}

type RuntimeState = LegacyRuntimeState | InteractiveRuntimeState;

export type DispatchFailureCode =
  | 'audit_failure'
  | 'command_id_conflict'
  | 'command_out_of_bounds'
  | 'command_rejected'
  | 'session_backpressure'
  | 'session_not_capable'
  | 'session_not_found'
  | 'session_terminal'
  | 'stale_interaction'
  | 'workspace_untrusted';

export interface SessionManagerSecurityOptions {
  auditStore?: AuditStore;
  trustStore?: WorkspaceTrustStore;
  interactionTimeoutMs?: number;
  providerStateDirectory?: string;
}

export class WorkspaceAccessError extends Error {
  readonly code = 'workspace_untrusted';

  constructor(message = 'workspace is untrusted or its incarnation changed') {
    super(message);
    this.name = 'WorkspaceAccessError';
  }
}

export type DispatchResult =
  | { ok: true; acknowledgement: CommandAcknowledgementV2 }
  | { ok: false; code: DispatchFailureCode; message: string };

const MAX_STORED_EVENTS_PER_SESSION = 5_000;
const MAX_STORED_EVENT_BYTES_PER_SESSION = 16 * 1024 * 1024;
const MAX_RETAINED_COMPLETED_SESSIONS = 50;
const MAX_PENDING_COMMANDS = 64;
const MAX_PENDING_COMMAND_BYTES = 1024 * 1024;
const MAX_COMMAND_LEDGER_ENTRIES = 1_024;
const INTERACTIVE_CLOSE_TIMEOUT_MS = 5_000;
const PROVIDER_REDETECT_TIMEOUT_MS = 5_000;
// Interactive shutdown can spend one close interval resolving outstanding interactions, one on
// graceful transport close, and one on the mandatory force-close/reap fallback. Keep the daemon's
// outer bound above all three so it never exits while a conforming supervisor is still reaping.
const SESSION_SHUTDOWN_TIMEOUT_MS = INTERACTIVE_CLOSE_TIMEOUT_MS * 3 + 1_000;

function isSessionActive(session: AgentSession): boolean {
  return session.status === 'starting' || session.status === 'running';
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
  );
}

function canonicalCommand(command: AgentCommandV2): string {
  return JSON.stringify(canonicalValue(command));
}

/** Owns provider lifecycles and the command serialization boundary for every daemon session. */
export class SessionManager {
  private readonly runtime = new Map<string, RuntimeState>();
  private readonly pendingInteractiveStarts = new Map<string, PendingInteractiveStart>();
  private readonly completedOrder: string[] = [];
  private readonly shutdownController = new AbortController();
  private readonly blockedWorkspaces = new Set<string>();
  private readonly workspaceRevocationEpochs = new Map<string, number>();
  private shuttingDown = false;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly logger: Logger,
    private readonly store: SessionStore = new MemorySessionStore(),
    private readonly security: SessionManagerSecurityOptions = {},
  ) {}

  /** Existing one-shot path. Its process and event contract deliberately remains unchanged. */
  create(
    provider: ProviderId,
    cwd: string,
    prompt: string,
    resumeProviderSessionId?: string,
    protocolVersion: 1 | 2 = 1,
    workspace?: WorkspaceIdentity,
    providerStatus?: ProviderStatus,
    sandbox?: StartSessionOptions['sandbox'],
    model?: string,
  ): AgentSession {
    if (this.shuttingDown) throw new Error('session manager is shutting down');
    if (workspace && this.blockedWorkspaces.has(workspace.workspaceId)) {
      throw new WorkspaceAccessError();
    }
    const providerImpl = this.registry.get(provider);
    if (!providerImpl) throw new Error(`no provider registered for id: ${provider}`);

    const id = randomUUID();
    const session = this.newSession(id, provider, cwd, prompt);
    this.store.create(session);
    const handle = providerImpl.startSession({
      sessionId: id,
      cwd,
      prompt,
      resumeProviderSessionId,
      ...(providerStatus ? { providerStatus } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(model ? { model } : {}),
    });
    const runtime: LegacyRuntimeState = {
      kind: 'legacy',
      handle,
      protocolVersion,
      events: [],
      listeners: new Set(),
      nextSequence: 0,
      ...(workspace ? { workspace } : {}),
      done: Promise.resolve(),
    };
    this.runtime.set(id, runtime);
    runtime.done = this.consumeLegacy(id, runtime);
    this.logCreated(session, !!resumeProviderSessionId, 'legacy');
    return session;
  }

  /** Rich v2 path: one supervised provider host per AgentDock session. */
  async createInteractive(
    provider: ProviderId,
    cwd: string,
    prompt: string,
    selection: CapabilitySelection,
    transport: ProviderTransportV2,
    executionId: string,
    turnId: string,
    signal?: AbortSignal,
    workspace?: WorkspaceIdentity,
    providerStatus?: ProviderStatus,
    continuation?: SessionContinuationV2,
    expectedContinuationEvidence?: Readonly<ProviderContinuationEvidence>,
    beforeProviderThreadStart?: (
      evidence: Readonly<ProviderContinuationEvidence> | undefined,
    ) => Promise<void>,
  ): Promise<AgentSession> {
    if (this.shuttingDown) {
      throw new InteractiveSessionError('session_terminal', 'session manager is shutting down');
    }
    const workspaceEpoch = workspace
      ? this.currentWorkspaceEpoch(workspace.workspaceId)
      : undefined;
    if (workspace) await this.assertWorkspaceTrusted(workspace, workspaceEpoch);
    const providerImpl = this.registry.get(provider);
    if (!providerImpl?.startInteractiveSession) {
      throw new Error(`provider has no interactive transport: ${provider}`);
    }
    const detectedProviderStatus = providerStatus ?? (await providerImpl.detect());
    if (detectedProviderStatus.id !== provider) {
      throw new Error(`detected provider status does not match requested provider: ${provider}`);
    }
    const workspaceTrust: WorkspaceTrustEvidence = workspace
      ? {
          state: 'trusted',
          workspaceId: workspace.workspaceId,
          incarnation: workspace.incarnation,
          trustEpoch: workspaceEpoch as number,
        }
      : { state: 'untrusted' };
    const id = randomUUID();
    const session = this.newSession(id, provider, cwd, prompt);
    this.store.create(session);
    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) relayAbort();
    else signal?.addEventListener('abort', relayAbort, { once: true });
    let finishPending!: () => void;
    const pending: PendingInteractiveStart = {
      protocolVersion: 2,
      controller,
      ...(workspace
        ? { workspaceId: workspace.workspaceId, workspaceEpoch: workspaceEpoch as number }
        : {}),
      done: new Promise<void>((resolve) => {
        finishPending = resolve;
      }),
    };
    this.pendingInteractiveStarts.set(id, pending);

    try {
      const handle = await providerImpl.startInteractiveSession({
        sessionId: id,
        cwd,
        prompt,
        selection,
        transport,
        executionId,
        turnId,
        interactionOwner: 'daemon',
        signal: controller.signal,
        providerStatus: detectedProviderStatus,
        workspaceTrust,
        ...(this.security.providerStateDirectory
          ? { providerStateDirectory: this.security.providerStateDirectory }
          : {}),
        beforeWorkDelivery: async () => {
          if (controller.signal.aborted || this.shuttingDown) {
            throw new InteractiveSessionError('session_aborted', 'session start was cancelled');
          }
          if (workspace) await this.assertWorkspaceTrusted(workspace, workspaceEpoch);
          if (controller.signal.aborted || this.shuttingDown) {
            throw new InteractiveSessionError('session_aborted', 'session start was cancelled');
          }
        },
        ...(beforeProviderThreadStart ? { beforeProviderThreadStart } : {}),
        ...(detectedProviderStatus.selectedModel
          ? { model: detectedProviderStatus.selectedModel }
          : {}),
        ...(continuation ? { continuation } : {}),
        ...(expectedContinuationEvidence ? { expectedContinuationEvidence } : {}),
      });
      const workspaceStillTrusted = workspace
        ? await this.workspaceIsTrusted(workspace, workspaceEpoch)
        : true;
      if (controller.signal.aborted || this.shuttingDown || !workspaceStillTrusted) {
        await handle.close();
        if (!workspaceStillTrusted) throw new WorkspaceAccessError();
        throw new InteractiveSessionError('session_terminal', 'session start was cancelled');
      }
      const runtime: InteractiveRuntimeState = {
        kind: 'interactive',
        protocolVersion: 2,
        handle,
        events: new Map(),
        replayBytes: 0,
        nextEventIndex: 0,
        listeners: new Set(),
        acceptedWork: 'not_accepted',
        dispatchTail: Promise.resolve(),
        pendingCommands: 0,
        pendingCommandBytes: 0,
        commandLedger: new Map(),
        reservedInteractionCommands: new Map(),
        interactions: new InteractionState(
          (interaction) => {
            void this.expireInteraction(id, interaction, 'timeout');
          },
          undefined,
          this.security.interactionTimeoutMs,
        ),
        approvalActions: new Map(),
        sessionGrants: new Set(),
        transport: transport.id,
        ...(handle.providerSessionId ? { providerSessionId: handle.providerSessionId } : {}),
        ...(handle.runtimeMetadata ? { runtimeMetadata: { ...handle.runtimeMetadata } } : {}),
        ...(handle.continuationEvidence
          ? { continuationEvidence: { ...handle.continuationEvidence } }
          : {}),
        ...(workspace ? { workspace } : {}),
        done: Promise.resolve(),
      };
      this.runtime.set(id, runtime);
      void handle.accepted.then(
        (acceptedWork) => {
          if (this.runtime.get(id) === runtime && runtime.acceptedWork !== 'accepted') {
            runtime.acceptedWork = acceptedWork;
          }
        },
        () => {
          if (this.runtime.get(id) === runtime && runtime.acceptedWork !== 'accepted') {
            runtime.acceptedWork = 'unknown';
          }
        },
      );
      runtime.done = this.consumeInteractive(id, runtime);
      this.logCreated(session, false, 'interactive');
      return session;
    } catch (error) {
      this.store.delete(id);
      throw error;
    } finally {
      signal?.removeEventListener('abort', relayAbort);
      this.pendingInteractiveStarts.delete(id);
      finishPending();
    }
  }

  private newSession(id: string, provider: ProviderId, cwd: string, prompt: string): AgentSession {
    return {
      id,
      provider,
      cwd,
      prompt,
      status: 'starting',
      startedAt: new Date().toISOString(),
    };
  }

  private logCreated(session: AgentSession, resumed: boolean, transport: string): void {
    this.logger.info('session created', {
      sessionId: session.id,
      provider: session.provider,
      resumed,
      transport,
    });
  }

  private async consumeLegacy(id: string, runtime: LegacyRuntimeState): Promise<void> {
    this.mutateSession(id, (session) => {
      session.status = 'running';
    });
    for await (const event of runtime.handle.events) {
      this.mutateSession(id, (session) => this.applyLegacyStatus(session, event));
      const sequence = runtime.nextSequence++;
      const envelope: AgentEventEnvelope = {
        ...event,
        sequence,
        timestamp: new Date().toISOString(),
      };
      if (runtime.events.length < MAX_STORED_EVENTS_PER_SESSION) {
        runtime.events.push(envelope);
      } else {
        this.logger.warn('session event history full; further events will not be replayable', {
          sessionId: id,
        });
      }
      this.notifyLegacyListeners(id, runtime, sequence, envelope);
    }
    this.markCompleted(id);
  }

  private async consumeInteractive(id: string, runtime: InteractiveRuntimeState): Promise<void> {
    this.mutateSession(id, (session) => {
      session.status = 'running';
    });
    for await (const sourceEvent of runtime.handle.events) {
      const event = await this.prepareInteractiveEvent(id, runtime, sourceEvent);
      if (!event) continue;
      this.mutateSession(id, (session) => this.applyInteractiveStatus(session, event));
      const index = runtime.nextEventIndex;
      runtime.nextEventIndex += 1;
      this.recordInteractiveEvent(runtime, index, event);
      for (const listener of [...runtime.listeners]) {
        try {
          listener(index, event);
        } catch {
          this.logger.warn('interactive session listener failed', {
            sessionId: id,
          });
        }
      }
    }
    this.markCompleted(id);
  }

  private async prepareInteractiveEvent(
    id: string,
    runtime: InteractiveRuntimeState,
    event: AgentEventV2,
  ): Promise<AgentEventV2 | undefined> {
    if (event.type === 'approval.requested' || event.type === 'question.requested') {
      const registered = runtime.interactions.register({
        requestId: event.requestId,
        turnId: event.turnId,
        kind: event.type === 'approval.requested' ? 'approval' : 'question',
        providerDeadlineAtMs: Date.parse(event.deadlineAt),
      });
      if (!registered) {
        this.logger.warn('provider interaction id was already pending', {
          sessionId: id,
          requestId: event.requestId,
        });
        return undefined;
      }
      if (event.type === 'question.requested') return event;

      const action = normalizeApprovalAction(event);
      runtime.approvalActions.set(event.requestId, action);
      const trustState = await this.runtimeTrustState(runtime);
      const policy = evaluatePermissionPolicy(action, {
        trustState,
        grants: runtime.sessionGrants,
      });
      if (policy.outcome === 'allow') {
        await this.resolveAutomaticApproval(id, runtime, event, action, 'allow_once', 'policy');
        return undefined;
      }
      if (policy.outcome === 'deny') {
        await this.resolveAutomaticApproval(id, runtime, event, action, 'deny', 'policy');
        return undefined;
      }
      return {
        ...event,
        permission: action,
        allowedDecisions: policy.allowedDecisions,
      };
    }

    if (event.type === 'approval.resolved') {
      const pending = runtime.interactions.get(event.requestId);
      if (pending?.state !== 'resolving') {
        const claimed = runtime.interactions.claim(event.requestId, {
          turnId: event.turnId,
          kind: 'approval',
        });
        const action = runtime.approvalActions.get(event.requestId);
        if (claimed && action) {
          try {
            await this.appendApprovalAudit(
              id,
              runtime,
              event,
              action,
              event.decision === 'allowed' ? 'allow_once' : 'deny',
              event.actor,
            );
          } catch {
            this.logger.warn('failed to audit a provider-side approval resolution', {
              sessionId: id,
              requestId: event.requestId,
            });
          }
        }
        if (claimed) runtime.interactions.settle(event.requestId);
        runtime.approvalActions.delete(event.requestId);
      }
    } else if (event.type === 'question.resolved' || event.type === 'question.cancelled') {
      const pending = runtime.interactions.get(event.requestId);
      if (pending?.state !== 'resolving') runtime.interactions.removeResolved(event.requestId);
    }
    return event;
  }

  private async resolveAutomaticApproval(
    id: string,
    runtime: InteractiveRuntimeState,
    event: Extract<AgentEventV2, { type: 'approval.requested' }>,
    action: PermissionActionV2,
    decision: 'allow_once' | 'deny',
    actor: AuditActorV2,
  ): Promise<void> {
    const claimed = runtime.interactions.claim(event.requestId, {
      turnId: event.turnId,
      kind: 'approval',
    });
    if (!claimed) return;
    let providerDecision = decision;
    let auditRecorded = false;
    const workspaceEpoch = runtime.workspace
      ? this.currentWorkspaceEpoch(runtime.workspace.workspaceId)
      : undefined;
    try {
      await this.appendApprovalAudit(id, runtime, event, action, decision, actor);
      auditRecorded = true;
    } catch {
      providerDecision = 'deny';
      this.logger.warn('approval audit failed; denying provider request', {
        sessionId: id,
        requestId: event.requestId,
      });
    }
    if (
      providerDecision === 'allow_once' &&
      runtime.workspace &&
      !(await this.workspaceIsTrusted(runtime.workspace, workspaceEpoch))
    ) {
      providerDecision = 'deny';
      if (auditRecorded) {
        try {
          // The first row records the requested allow. The same request ID plus this later policy
          // denial records the effective outcome when revocation wins the race.
          await this.appendApprovalAudit(id, runtime, event, action, 'deny', 'policy');
        } catch {
          this.logger.warn('approval correction audit failed', {
            sessionId: id,
            requestId: event.requestId,
          });
        }
      }
    }
    try {
      await runtime.handle.send({
        type: 'approval.respond',
        commandId: randomUUID(),
        sessionId: id,
        turnId: event.turnId,
        requestId: event.requestId,
        decision: providerDecision,
      });
    } finally {
      runtime.interactions.settle(event.requestId);
      runtime.approvalActions.delete(event.requestId);
    }
  }

  private async appendApprovalAudit(
    id: string,
    runtime: InteractiveRuntimeState,
    event: Pick<Extract<AgentEventV2, { type: 'approval.requested' }>, 'requestId' | 'turnId'>,
    action: PermissionActionV2,
    decision: ApprovalDecisionV2,
    actor: AuditActorV2,
  ): Promise<void> {
    const audit = this.security.auditStore;
    if (!audit) {
      if (runtime.workspace) throw new Error('secured approval audit store is unavailable');
      return;
    }
    const session = this.store.get(id);
    if (!session || !runtime.workspace) throw new Error('approval audit context is incomplete');
    await audit.append({
      schemaVersion: 1,
      entryId: randomUUID(),
      recordedAt: new Date().toISOString(),
      sessionId: id,
      turnId: event.turnId,
      requestId: event.requestId,
      providerId: session.provider,
      transport: runtime.transport,
      workspaceFingerprint: runtime.workspace.incarnation,
      action,
      permissionKey: permissionKey(action),
      decision,
      actor,
    });
  }

  private async auditFailClosedApproval(
    id: string,
    runtime: InteractiveRuntimeState,
    interaction: PendingInteraction,
    reason: InteractionResolutionReason,
  ): Promise<void> {
    if (interaction.kind !== 'approval') return;
    const action = runtime.approvalActions.get(interaction.requestId);
    if (!action) return;
    const actor: AuditActorV2 =
      reason === 'trust_revoked' || reason === 'overflow' ? 'policy' : reason;
    try {
      await this.appendApprovalAudit(id, runtime, interaction, action, 'deny', actor);
    } catch {
      // The provider-facing denial already won the race; audit recovery cannot reverse it, and
      // provider-controlled exception text is never copied into logs.
      this.logger.warn('failed to audit a fail-closed approval', {
        sessionId: id,
        requestId: interaction.requestId,
      });
    }
  }

  private async runtimeTrustState(
    runtime: InteractiveRuntimeState,
  ): Promise<'trusted' | 'untrusted' | 'revoking'> {
    const workspace = runtime.workspace;
    if (!workspace) return 'trusted';
    if (this.blockedWorkspaces.has(workspace.workspaceId)) return 'revoking';
    return (await this.workspaceIsTrusted(workspace)) ? 'trusted' : 'untrusted';
  }

  private async expireInteraction(
    id: string,
    interaction: PendingInteraction,
    reason: 'disconnect' | 'timeout' | 'trust_revoked',
  ): Promise<void> {
    const runtime = this.runtime.get(id);
    if (!runtime || runtime.kind !== 'interactive') return;
    const claimed =
      interaction.kind === 'question'
        ? [interaction, ...runtime.interactions.claimTurn(interaction.turnId)]
        : [interaction];
    try {
      await runtime.handle.resolveInteraction(interaction.requestId, reason);
    } catch {
      this.logger.warn('failed to resolve an expired interaction', {
        sessionId: id,
        requestId: interaction.requestId,
      });
    } finally {
      for (const record of claimed) {
        await this.auditFailClosedApproval(id, runtime, record, reason);
      }
      for (const record of claimed) {
        runtime.interactions.settle(record.requestId);
        runtime.approvalActions.delete(record.requestId);
      }
    }
  }

  private recordInteractiveEvent(
    runtime: InteractiveRuntimeState,
    index: number,
    event: AgentEventV2,
  ): void {
    const bytes = utf8ByteLength(JSON.stringify(event));
    while (
      runtime.events.size > 0 &&
      (runtime.events.size >= MAX_STORED_EVENTS_PER_SESSION ||
        runtime.replayBytes + bytes > MAX_STORED_EVENT_BYTES_PER_SESSION)
    ) {
      const oldestIndex = runtime.events.keys().next().value as number;
      const oldest = runtime.events.get(oldestIndex);
      runtime.events.delete(oldestIndex);
      runtime.replayBytes -= oldest?.bytes ?? 0;
    }
    if (bytes > MAX_STORED_EVENT_BYTES_PER_SESSION) return;
    runtime.events.set(index, { event, bytes });
    runtime.replayBytes += bytes;
  }

  private notifyLegacyListeners(
    id: string,
    runtime: LegacyRuntimeState,
    sequence: number,
    event: AgentEventEnvelope,
  ): void {
    for (const listener of [...runtime.listeners]) {
      try {
        listener(sequence, event);
      } catch {
        this.logger.warn('session listener failed', {
          sessionId: id,
        });
      }
    }
  }

  private markCompleted(id: string): void {
    this.completedOrder.push(id);
    this.evictOldestCompletedIfOverCap();
  }

  private evictOldestCompletedIfOverCap(): void {
    while (this.completedOrder.length > MAX_RETAINED_COMPLETED_SESSIONS) {
      const staleId = this.completedOrder.shift();
      if (staleId === undefined) break;
      if (!this.runtime.has(staleId)) continue;
      this.runtime.delete(staleId);
      this.store.delete(staleId);
    }
  }

  private mutateSession(id: string, fn: (session: AgentSession) => void): void {
    const session = this.store.get(id);
    if (!session) return;
    fn(session);
    this.store.update(id, session);
  }

  private applyLegacyStatus(session: AgentSession, event: AgentEvent): void {
    switch (event.type) {
      case 'session.completed':
        session.status = 'completed';
        session.completedAt = new Date().toISOString();
        session.providerSessionId = event.providerSessionId ?? session.providerSessionId;
        break;
      case 'session.failed':
        session.status = 'failed';
        session.completedAt = new Date().toISOString();
        session.error = event.message;
        break;
      case 'session.cancelled':
        session.status = 'cancelled';
        session.completedAt = new Date().toISOString();
        break;
      default:
        break;
    }
  }

  private applyInteractiveStatus(session: AgentSession, event: AgentEventV2): void {
    switch (event.type) {
      case 'session.completed':
        session.status = 'completed';
        session.completedAt = new Date().toISOString();
        break;
      case 'session.failed':
        session.status = 'failed';
        session.completedAt = new Date().toISOString();
        session.error = event.message;
        break;
      case 'session.cancelled':
        session.status = 'cancelled';
        session.completedAt = new Date().toISOString();
        break;
      case 'session.interrupted':
        session.status = 'failed';
        session.completedAt = new Date().toISOString();
        session.error = event.reason ?? 'session interrupted';
        break;
      default:
        break;
    }
  }

  get(id: string, protocolVersion?: 1 | 2): AgentSession | undefined {
    if (!this.ownedBy(id, protocolVersion)) return undefined;
    return this.store.get(id);
  }

  list(protocolVersion?: 1 | 2): AgentSession[] {
    return this.store.list().filter((session) => this.ownedBy(session.id, protocolVersion));
  }

  subscribe(
    id: string,
    sinceIndex: number,
    listener: (index: number, event: AgentEventEnvelope) => void,
    protocolVersion?: 1 | 2,
  ): (() => void) | undefined {
    if (!this.ownedBy(id, protocolVersion)) return undefined;
    const runtime = this.runtime.get(id);
    if (!runtime || runtime.kind !== 'legacy') return undefined;
    for (let index = sinceIndex; index < runtime.events.length; index += 1) {
      listener(index, runtime.events[index] as AgentEventEnvelope);
    }
    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  }

  subscribeInteractive(
    id: string,
    sinceIndex: number,
    listener: (index: number, event: AgentEventV2) => void,
  ): (() => void) | undefined {
    const runtime = this.runtime.get(id);
    if (!runtime || runtime.kind !== 'interactive') return undefined;
    for (const [index, stored] of runtime.events) {
      if (index >= sinceIndex) listener(index, stored.event);
    }
    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  }

  isInteractive(id: string): boolean {
    return this.runtime.get(id)?.kind === 'interactive';
  }

  acceptedWork(id: string): AcceptedWorkState {
    const runtime = this.runtime.get(id);
    return runtime?.kind === 'interactive' ? runtime.acceptedWork : 'unknown';
  }

  interactiveProviderMetadata(id: string):
    | {
        providerSessionId?: string;
        runtimeMetadata?: Readonly<ProviderRuntimeMetadata>;
        continuationEvidence?: Readonly<ProviderContinuationEvidence>;
      }
    | undefined {
    const runtime = this.runtime.get(id);
    if (!runtime || runtime.kind !== 'interactive') return undefined;
    return {
      ...(runtime.providerSessionId ? { providerSessionId: runtime.providerSessionId } : {}),
      ...(runtime.runtimeMetadata ? { runtimeMetadata: { ...runtime.runtimeMetadata } } : {}),
      ...(runtime.continuationEvidence
        ? { continuationEvidence: { ...runtime.continuationEvidence } }
        : {}),
    };
  }

  async verifiedWorkspaceTrust(workspace?: WorkspaceIdentity): Promise<WorkspaceTrustEvidence> {
    if (!workspace) return { state: 'untrusted' };
    const trustEpoch = this.currentWorkspaceEpoch(workspace.workspaceId);
    if (!(await this.workspaceIsTrusted(workspace, trustEpoch))) return { state: 'untrusted' };
    return {
      state: 'trusted',
      workspaceId: workspace.workspaceId,
      incarnation: workspace.incarnation,
      trustEpoch,
    };
  }

  /** Re-detects a provider behind a bounded, abort-aware daemon gate. */
  async redetectProvider(
    provider: ProviderId,
    signal?: AbortSignal,
    options?: Omit<ProviderDetectionOptions, 'signal'>,
  ): Promise<ProviderStatus | undefined> {
    const providerImpl = this.registry.get(provider);
    if (!providerImpl || signal?.aborted) return undefined;
    return new Promise((resolve) => {
      let settled = false;
      const controller = new AbortController();
      const finish = (status: ProviderStatus | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', aborted);
        resolve(status);
      };
      const aborted = (): void => {
        controller.abort(signal?.reason);
        finish(undefined);
      };
      const timeout = setTimeout(() => {
        controller.abort(new Error('provider re-detection timed out'));
        finish(undefined);
      }, PROVIDER_REDETECT_TIMEOUT_MS);
      timeout.unref?.();
      signal?.addEventListener('abort', aborted, { once: true });
      providerImpl.detect({ ...options, signal: controller.signal }).then(
        (status) => finish(status),
        () => finish(undefined),
      );
    });
  }

  markInteractionPublished(id: string, requestId: string): boolean {
    const runtime = this.runtime.get(id);
    return runtime?.kind === 'interactive' ? runtime.interactions.markPublished(requestId) : false;
  }

  async responderDisconnected(id: string): Promise<void> {
    const runtime = this.runtime.get(id);
    if (!runtime || runtime.kind !== 'interactive') return;
    await this.resolveClaimedInteractions(
      id,
      runtime,
      runtime.interactions.claimAll(),
      'disconnect',
    );
  }

  /** Synchronous first step of revocation: no new command can cross this workspace boundary. */
  blockWorkspace(workspaceId: string): void {
    if (this.blockedWorkspaces.has(workspaceId)) return;
    this.blockedWorkspaces.add(workspaceId);
    this.workspaceRevocationEpochs.set(workspaceId, this.currentWorkspaceEpoch(workspaceId) + 1);
    for (const pending of this.pendingInteractiveStarts.values()) {
      if (pending.workspaceId === workspaceId) pending.controller.abort();
    }
  }

  allowWorkspace(workspaceId: string): void {
    this.blockedWorkspaces.delete(workspaceId);
  }

  async revokeWorkspace(workspaceId: string): Promise<void> {
    this.blockWorkspace(workspaceId);
    const affected = [...this.runtime.entries()].filter(
      ([, runtime]) => runtime.workspace?.workspaceId === workspaceId,
    );
    for (const [id, runtime] of affected) {
      if (runtime.kind === 'interactive') {
        runtime.sessionGrants.clear();
        await this.resolveClaimedInteractions(
          id,
          runtime,
          runtime.interactions.claimAll(),
          'trust_revoked',
        );
      }
    }
    await Promise.allSettled(
      affected.map(([id, runtime]) => this.closeRuntime(id, runtime, 'trust_revoked')),
    );
    await Promise.allSettled(affected.map(([, runtime]) => runtime.done));
  }

  private async resolveClaimedInteractions(
    id: string,
    runtime: InteractiveRuntimeState,
    claimed: PendingInteraction[],
    reason: InteractionResolutionReason,
  ): Promise<void> {
    const resolvedQuestionTurns = new Set<string>();
    for (const interaction of claimed) {
      if (interaction.kind === 'question') {
        if (resolvedQuestionTurns.has(interaction.turnId)) continue;
        resolvedQuestionTurns.add(interaction.turnId);
      }
      try {
        await runtime.handle.resolveInteraction(interaction.requestId, reason);
      } catch {
        this.logger.warn('failed to resolve a pending interaction', {
          sessionId: id,
          requestId: interaction.requestId,
        });
      } finally {
        await this.auditFailClosedApproval(id, runtime, interaction, reason);
      }
    }
    for (const interaction of claimed) {
      runtime.interactions.settle(interaction.requestId);
      runtime.approvalActions.delete(interaction.requestId);
    }
  }

  dispatch(
    id: string,
    command: AgentCommandV2,
    newCommandFailure?: DispatchFailureCode,
  ): Promise<DispatchResult> {
    const runtime = this.runtime.get(id);
    if (!runtime) return Promise.resolve(this.dispatchFailure('session_not_found'));
    if (runtime.kind !== 'interactive') {
      return Promise.resolve(this.dispatchFailure('session_not_capable'));
    }

    const canonicalPayload = canonicalCommand(command);
    const existing = runtime.commandLedger.get(command.commandId);
    if (existing) {
      return existing.canonicalPayload === canonicalPayload
        ? existing.result
        : Promise.resolve(this.dispatchFailure('command_id_conflict'));
    }
    // State and capability gates apply only to new commands. A byte-equivalent retry must
    // return its recorded result even if the first dispatch already changed session state.
    if (newCommandFailure) {
      return Promise.resolve(this.dispatchFailure(newCommandFailure));
    }
    const interactionRequestId =
      command.type === 'approval.respond' || command.type === 'question.respond'
        ? command.requestId
        : undefined;
    if (interactionRequestId) {
      const admissionFailure = this.interactionCommandAdmissionFailure(runtime, command);
      if (admissionFailure || runtime.reservedInteractionCommands.has(interactionRequestId)) {
        return Promise.resolve(this.dispatchFailure(admissionFailure ?? 'stale_interaction'));
      }
    }
    if (runtime.commandLedger.size >= MAX_COMMAND_LEDGER_ENTRIES) {
      return Promise.resolve(this.dispatchFailure('session_backpressure'));
    }
    const bytes = utf8ByteLength(canonicalPayload);
    if (
      runtime.pendingCommands >= MAX_PENDING_COMMANDS ||
      runtime.pendingCommandBytes + bytes > MAX_PENDING_COMMAND_BYTES
    ) {
      return Promise.resolve(this.dispatchFailure('session_backpressure'));
    }

    runtime.pendingCommands += 1;
    runtime.pendingCommandBytes += bytes;
    if (interactionRequestId) {
      runtime.reservedInteractionCommands.set(interactionRequestId, command.commandId);
    }
    const result = runtime.dispatchTail
      .then(() => this.dispatchNow(id, runtime, command))
      .finally(() => {
        runtime.pendingCommands -= 1;
        runtime.pendingCommandBytes -= bytes;
        if (
          interactionRequestId &&
          runtime.reservedInteractionCommands.get(interactionRequestId) === command.commandId
        ) {
          runtime.reservedInteractionCommands.delete(interactionRequestId);
        }
      });
    runtime.commandLedger.set(command.commandId, { canonicalPayload, result });
    runtime.dispatchTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async dispatchNow(
    id: string,
    runtime: InteractiveRuntimeState,
    command: AgentCommandV2,
  ): Promise<DispatchResult> {
    const session = this.store.get(id);
    if (!session || !isSessionActive(session) || this.runtime.get(id) !== runtime) {
      return this.dispatchFailure('session_terminal');
    }
    if (runtime.workspace && !(await this.workspaceIsTrusted(runtime.workspace))) {
      if (command.type === 'approval.respond' || command.type === 'question.respond') {
        const claimed = runtime.interactions.claim(command.requestId, {
          turnId: command.turnId,
          kind: command.type === 'approval.respond' ? 'approval' : 'question',
        });
        if (claimed) await this.expireInteraction(id, claimed, 'trust_revoked');
      }
      return this.dispatchFailure('workspace_untrusted');
    }
    try {
      if (command.type === 'approval.respond') {
        return await this.dispatchApproval(id, runtime, command);
      }
      if (command.type === 'question.respond') {
        const interaction = runtime.interactions.claim(command.requestId, {
          turnId: command.turnId,
          kind: 'question',
        });
        if (!interaction) return this.dispatchFailure('stale_interaction');
        try {
          await runtime.handle.send(command);
          runtime.interactions.settle(command.requestId);
        } catch (error) {
          if (error instanceof InteractiveSessionError && error.code === 'command_rejected') {
            runtime.interactions.release(command.requestId);
          } else {
            runtime.interactions.settle(command.requestId);
          }
          throw error;
        }
      } else if (command.type === 'session.interrupt') {
        const pending = runtime.interactions.claimAll();
        try {
          await runtime.handle.interrupt();
        } finally {
          await Promise.all(
            pending.map((interaction) =>
              this.auditFailClosedApproval(id, runtime, interaction, 'interrupt'),
            ),
          );
          for (const interaction of pending) {
            runtime.interactions.settle(interaction.requestId);
            runtime.approvalActions.delete(interaction.requestId);
          }
        }
      } else await runtime.handle.send(command);
      runtime.acceptedWork = 'accepted';
      return this.acknowledgement(command);
    } catch (error) {
      if (error instanceof InteractiveSessionError && error.code === 'stale_interaction') {
        return this.dispatchFailure('stale_interaction');
      }
      if (error instanceof InteractiveSessionError && error.code === 'session_terminal') {
        return this.dispatchFailure('session_terminal');
      }
      return this.dispatchFailure('command_rejected');
    }
  }

  private async dispatchApproval(
    id: string,
    runtime: InteractiveRuntimeState,
    command: Extract<AgentCommandV2, { type: 'approval.respond' }>,
  ): Promise<DispatchResult> {
    const action = runtime.approvalActions.get(command.requestId);
    const pending = runtime.interactions.get(command.requestId);
    if (
      !action ||
      !pending ||
      pending.state === 'resolving' ||
      pending.turnId !== command.turnId ||
      pending.kind !== 'approval'
    ) {
      return this.dispatchFailure('stale_interaction');
    }
    if (!isApprovalDecisionAllowed(action, command.decision)) {
      return this.dispatchFailure('command_rejected');
    }
    if (
      !runtime.interactions.claim(command.requestId, {
        turnId: command.turnId,
        kind: 'approval',
      })
    ) {
      return this.dispatchFailure('stale_interaction');
    }

    let auditFailed = false;
    let auditRecorded = false;
    const workspaceEpoch = runtime.workspace
      ? this.currentWorkspaceEpoch(runtime.workspace.workspaceId)
      : undefined;
    try {
      await this.appendApprovalAudit(id, runtime, command, action, command.decision, 'user');
      auditRecorded = true;
    } catch {
      auditFailed = true;
      this.logger.warn('approval audit failed', {
        sessionId: id,
        requestId: command.requestId,
      });
    }

    const allowRequested = command.decision !== 'deny';
    const workspaceStillTrusted = runtime.workspace
      ? await this.workspaceIsTrusted(runtime.workspace, workspaceEpoch)
      : true;
    if (allowRequested && !workspaceStillTrusted && auditRecorded) {
      try {
        await this.appendApprovalAudit(id, runtime, command, action, 'deny', 'policy');
      } catch {
        auditFailed = true;
        this.logger.warn('approval correction audit failed', {
          sessionId: id,
          requestId: command.requestId,
        });
      }
    }
    const providerDecision =
      allowRequested && !auditFailed && workspaceStillTrusted ? 'allow_once' : 'deny';
    try {
      await runtime.handle.send({ ...command, decision: providerDecision });
      if (providerDecision === 'allow_once' && command.decision === 'allow_session') {
        runtime.sessionGrants.add(permissionKey(action));
      }
    } finally {
      runtime.interactions.settle(command.requestId);
      runtime.approvalActions.delete(command.requestId);
    }
    if (allowRequested && auditFailed) return this.dispatchFailure('audit_failure');
    if (allowRequested && !workspaceStillTrusted) {
      return this.dispatchFailure('workspace_untrusted');
    }
    runtime.acceptedWork = 'accepted';
    return this.acknowledgement(command);
  }

  private acknowledgement(command: AgentCommandV2): DispatchResult {
    return {
      ok: true,
      acknowledgement: {
        status: 'accepted',
        commandId: command.commandId,
        sessionId: command.sessionId,
        turnId: command.turnId,
      },
    };
  }

  private dispatchFailure(code: DispatchFailureCode): DispatchResult {
    const messages: Record<DispatchFailureCode, string> = {
      audit_failure: 'approval audit failed; the action was denied',
      command_id_conflict: 'command id was reused with a different payload',
      command_out_of_bounds: 'command exceeds the frozen capability constraints',
      command_rejected: 'provider rejected the command',
      session_backpressure: 'session command queue is full',
      session_not_capable: 'session transport does not accept commands',
      session_not_found: 'session not found',
      session_terminal: 'commands cannot reach a terminal session',
      stale_interaction: 'interaction is stale or belongs to another session or turn',
      workspace_untrusted: 'workspace is untrusted or its incarnation changed',
    };
    return { ok: false, code, message: messages[code] };
  }

  async cancel(id: string, protocolVersion?: 1 | 2): Promise<boolean> {
    if (!this.ownedBy(id, protocolVersion)) return false;
    const session = this.store.get(id);
    const pending = this.pendingInteractiveStarts.get(id);
    if (session && pending && isSessionActive(session)) {
      pending.controller.abort();
      await this.waitForPending(pending, INTERACTIVE_CLOSE_TIMEOUT_MS);
      return true;
    }
    const runtime = this.runtime.get(id);
    if (!session || !runtime || !isSessionActive(session)) return false;
    await this.closeRuntime(id, runtime, 'cancel');
    return true;
  }

  async remove(id: string, protocolVersion?: 1 | 2): Promise<boolean> {
    if (!this.ownedBy(id, protocolVersion)) return false;
    const session = this.store.get(id);
    if (!session) return false;
    const pending = this.pendingInteractiveStarts.get(id);
    if (pending && isSessionActive(session)) {
      pending.controller.abort();
      await this.waitForPending(pending, INTERACTIVE_CLOSE_TIMEOUT_MS);
    }
    const runtime = this.runtime.get(id);
    if (runtime && isSessionActive(session)) {
      await this.closeRuntime(id, runtime, 'cancel');
      if (runtime.kind === 'interactive') {
        await this.waitForDone(runtime, INTERACTIVE_CLOSE_TIMEOUT_MS);
      }
    }
    this.runtime.delete(id);
    this.store.delete(id);
    const orderIndex = this.completedOrder.indexOf(id);
    if (orderIndex !== -1) this.completedOrder.splice(orderIndex, 1);
    return true;
  }

  private ownedBy(id: string, protocolVersion: 1 | 2 | undefined): boolean {
    const ownedProtocol =
      this.runtime.get(id)?.protocolVersion ??
      this.pendingInteractiveStarts.get(id)?.protocolVersion;
    return protocolVersion === undefined || ownedProtocol === protocolVersion;
  }

  async cancelAll(timeoutMs = SESSION_SHUTDOWN_TIMEOUT_MS, protocolVersion?: 1 | 2): Promise<void> {
    const pendingStarts = [...this.pendingInteractiveStarts.values()].filter(
      (pending) => protocolVersion === undefined || pending.protocolVersion === protocolVersion,
    );
    for (const pending of pendingStarts) pending.controller.abort();
    const activeRuntimes = this.store
      .list()
      .filter((session) => isSessionActive(session) && this.ownedBy(session.id, protocolVersion))
      .map((session) => ({ id: session.id, runtime: this.runtime.get(session.id) }))
      .filter(
        (entry): entry is { id: string; runtime: RuntimeState } => entry.runtime !== undefined,
      );
    const closeReason = this.shuttingDown ? 'shutdown' : 'cancel';
    const stopping = Promise.allSettled(
      activeRuntimes.map(({ id, runtime }) => this.closeRuntime(id, runtime, closeReason)),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([
        stopping.then(() =>
          Promise.allSettled([
            ...activeRuntimes.map(({ runtime }) => runtime.done),
            ...pendingStarts.map((pending) => pending.done),
          ]),
        ),
        timedOut,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Stops new work before daemon shutdown and aborts every startup handshake already in flight. */
  beginShutdown(): void {
    this.shuttingDown = true;
    this.shutdownController.abort();
    for (const pending of this.pendingInteractiveStarts.values()) pending.controller.abort();
  }

  get shutdownSignal(): AbortSignal {
    return this.shutdownController.signal;
  }

  private interactionCommandAdmissionFailure(
    runtime: InteractiveRuntimeState,
    command: AgentCommandV2,
  ): 'command_rejected' | 'stale_interaction' | undefined {
    if (command.type !== 'approval.respond' && command.type !== 'question.respond')
      return undefined;
    const pending = runtime.interactions.get(command.requestId);
    if (
      pending === undefined ||
      pending.state === 'resolving' ||
      pending.turnId !== command.turnId ||
      pending.kind !== (command.type === 'approval.respond' ? 'approval' : 'question')
    ) {
      return 'stale_interaction';
    }
    if (command.type === 'approval.respond') {
      const action = runtime.approvalActions.get(command.requestId);
      if (!action) return 'stale_interaction';
      if (!isApprovalDecisionAllowed(action, command.decision)) return 'command_rejected';
    }
    return undefined;
  }

  private currentWorkspaceEpoch(workspaceId: string): number {
    return this.workspaceRevocationEpochs.get(workspaceId) ?? 0;
  }

  private workspaceEpochIsCurrent(workspaceId: string, expectedEpoch: number): boolean {
    return (
      !this.blockedWorkspaces.has(workspaceId) &&
      this.currentWorkspaceEpoch(workspaceId) === expectedEpoch
    );
  }

  private async assertWorkspaceTrusted(
    workspace: WorkspaceIdentity,
    expectedEpoch = this.currentWorkspaceEpoch(workspace.workspaceId),
  ): Promise<void> {
    if (!(await this.workspaceIsTrusted(workspace, expectedEpoch))) {
      throw new WorkspaceAccessError();
    }
  }

  private async workspaceIsTrusted(
    workspace: WorkspaceIdentity,
    expectedEpoch = this.currentWorkspaceEpoch(workspace.workspaceId),
  ): Promise<boolean> {
    if (
      !workspace.reusable ||
      !this.workspaceEpochIsCurrent(workspace.workspaceId, expectedEpoch)
    ) {
      return false;
    }
    if (!(await revalidateWorkspaceIdentity(workspace))) return false;
    if (!this.workspaceEpochIsCurrent(workspace.workspaceId, expectedEpoch)) return false;
    const trustStore = this.security.trustStore;
    if (!trustStore) return false;
    const trusted = (await trustStore.inspect(workspace)).state === 'trusted';
    return trusted && this.workspaceEpochIsCurrent(workspace.workspaceId, expectedEpoch);
  }

  private async closeRuntime(
    id: string,
    runtime: RuntimeState,
    reason: 'cancel' | 'shutdown' | 'trust_revoked',
  ): Promise<void> {
    if (runtime.kind === 'legacy') return runtime.handle.cancel();
    runtime.sessionGrants.clear();
    await this.resolveClaimedInteractions(id, runtime, runtime.interactions.claimAll(), reason);
    await runtime.handle.close();
  }

  private async waitForDone(runtime: RuntimeState, timeoutMs: number): Promise<void> {
    await Promise.race([
      runtime.done,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private async waitForPending(pending: PendingInteractiveStart, timeoutMs: number): Promise<void> {
    await Promise.race([
      pending.done,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
