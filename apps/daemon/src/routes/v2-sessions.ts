import { existsSync, statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  agentCommandV2Schema,
  type CreateSessionV2Request,
  commandAcknowledgementV2Schema,
  createSessionV2RequestSchema,
  cancelSessionV2ResponseSchema,
  negotiateCapabilities,
  sessionContinuationInputV2Schema,
  sessionEventHistoryV2QuerySchema,
  sessionIdParamSchema,
  sessionListV2QuerySchema,
} from '@agent-dock/shared';
import type { ProviderRegistry, WorkspaceTrustEvidence } from '@agent-dock/agent-runtime';
import type { SessionManager } from '../session-manager.js';
import type { WorkspaceTrustStore } from '../workspace-trust-store.js';
import { resolveWorkspaceIdentity, revalidateWorkspaceIdentity } from '../workspace-identity.js';
import {
  isWorkspaceDirty,
  WorkspaceExecutionLeaseError,
  WorkspaceExecutionLeaseManager,
  workspaceLeaseMode,
  type WorkspaceExecutionLease,
} from '../workspace-execution-lease.js';
import { capabilityRequestForContinuation, resolveProviderV2Manifest } from '../provider-v2.js';
import { BoundedV2SseWriter } from '../v2-sse-writer.js';
import {
  V2ProviderStartupError,
  V2SessionFacade,
  type V2LineageContext,
} from '../v2-session-facade.js';

function invalidRequest(reply: FastifyReply, details: unknown): void {
  reply.code(400).send({ error: 'invalid request body', code: 'invalid_request', details });
}

function normalizePaginationQuery(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const query = value as Record<string, unknown>;
  if (query.limit === undefined) return query;
  if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit)) return query;
  return { ...query, limit: Number(query.limit) };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function sendPersistedSessionError(
  reply: FastifyReply,
  error: unknown,
  codeOverride?: string,
): boolean {
  const code = codeOverride ?? errorCode(error);
  if (!code) return false;
  const status =
    code === 'storage_full'
      ? 507
      : code === 'session_capacity_exceeded'
        ? 429
        : code === 'invalid_cursor'
          ? 400
          : code === 'session_not_found' ||
              code === 'continuation_not_found' ||
              code === 'continuation_binding_not_found'
            ? 404
            : code === 'continuation_in_use' ||
                code === 'continuation_binding_collision' ||
                code === 'continuation_parent_active' ||
                code === 'active_lineage' ||
                code === 'continuation_scope_mismatch'
              ? 409
              : code === 'continuation_capability_not_selected' ||
                  code === 'legacy_fork_unsupported'
                ? 422
                : undefined;
  if (status === undefined) return false;
  reply.code(status).send({
    error: error instanceof Error ? error.message : code,
    code,
  });
  return true;
}

function parseLastEventId(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed < Number.MAX_SAFE_INTEGER ? parsed + 1 : undefined;
}

type RequestedTransportMode = 'auto' | 'app-server' | 'exec' | 'sdk' | 'cli';

function requestedTransportMode(provider: string): RequestedTransportMode | undefined {
  if (provider === 'codex') {
    const value = process.env.AGENT_DOCK_CODEX_TRANSPORT ?? 'auto';
    return value === 'auto' || value === 'app-server' || value === 'exec' ? value : undefined;
  }
  if (provider === 'claude') {
    const value = process.env.AGENT_DOCK_CLAUDE_TRANSPORT ?? 'auto';
    return value === 'auto' || value === 'sdk' || value === 'cli' ? value : undefined;
  }
  return undefined;
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

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      cleanup();
      resolve({ aborted: true });
    };
    const cleanup = (): void => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve({ aborted: false, value });
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function registerV2SessionRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager,
  registry: ProviderRegistry,
  trustStore?: WorkspaceTrustStore,
): void {
  const sessions = new V2SessionFacade(sessionManager);
  const executionLeases = new WorkspaceExecutionLeaseManager();

  const startSession = async (
    req: FastifyRequest,
    reply: FastifyReply,
    override?: { input: CreateSessionV2Request; lineage: V2LineageContext },
  ): Promise<void> => {
    const rawInput = override?.input ?? req.body;
    const rawPrompt = (rawInput as { prompt?: unknown } | null | undefined)?.prompt;
    if (typeof rawPrompt === 'string' && rawPrompt.length > 200_000) {
      reply.code(413).send({ error: 'payload too large', code: 'payload_too_large' });
      return;
    }

    const parsed = createSessionV2RequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      invalidRequest(reply, parsed.error.flatten());
      return;
    }
    if (!override && parsed.data.continuation) {
      reply.code(400).send({
        error: 'raw provider continuation identifiers are not accepted on this route',
        code: 'raw_continuation_forbidden',
      });
      return;
    }

    const provider = registry.get(parsed.data.provider);
    if (!provider) {
      reply.code(400).send({
        error: `unsupported provider: ${parsed.data.provider}`,
        code: 'unsupported_provider',
      });
      return;
    }
    if (!existsSync(parsed.data.cwd) || !statSync(parsed.data.cwd).isDirectory()) {
      reply.code(400).send({
        error: `working directory does not exist: ${parsed.data.cwd}`,
        code: 'invalid_working_directory',
      });
      return;
    }

    const controller = new AbortController();
    const abortStart = () => controller.abort();
    const abortDisconnectedStart = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    const abortShutdownStart = () => controller.abort();
    req.raw.once('aborted', abortStart);
    reply.raw.once('close', abortDisconnectedStart);
    sessionManager.shutdownSignal.addEventListener('abort', abortShutdownStart, { once: true });
    if (req.raw.aborted || reply.raw.destroyed || sessionManager.shutdownSignal.aborted) {
      controller.abort();
    }
    try {
      if (controller.signal.aborted) return;
      const workspace = trustStore
        ? await resolveWorkspaceIdentity(parsed.data.cwd).catch(() => undefined)
        : undefined;
      if (trustStore) {
        if (!workspace) {
          reply.code(400).send({
            error: 'workspace could not be resolved',
            code: 'invalid_working_directory',
          });
          return;
        }
        const trust = await trustStore.inspect(workspace);
        if (trust.state !== 'trusted') {
          reply.code(409).send({
            error: 'workspace is not trusted',
            code: 'workspace_untrusted',
            details: trust,
          });
          return;
        }
      }

      const canonicalCwd = workspace?.canonicalPath ?? parsed.data.cwd;
      const workspaceTrust = await sessionManager.verifiedWorkspaceTrust(workspace);
      if (controller.signal.aborted) return;
      if (workspace && workspaceTrust.state !== 'trusted') {
        reply.code(409).send({
          error: 'workspace trust changed',
          code: 'workspace_untrusted',
        });
        return;
      }
      const detected = await raceAbort(
        provider.detect({
          cwd: canonicalCwd,
          workspaceTrust,
          signal: controller.signal,
          includeLaunchScopeEvidence: false,
        }),
        controller.signal,
      );
      if (detected.aborted) return;
      const transportMode = requestedTransportMode(parsed.data.provider);
      if (
        (parsed.data.provider === 'codex' || parsed.data.provider === 'claude') &&
        transportMode === undefined
      ) {
        reply.code(422).send({
          error: 'requested provider transport is unavailable',
          code: 'provider_transport_unavailable',
        });
        return;
      }
      let manifest;
      try {
        manifest = resolveProviderV2Manifest(provider, detected.value);
      } catch {
        reply.code(422).send({
          error: 'requested provider transport is unavailable',
          code: 'provider_transport_unavailable',
        });
        return;
      }
      const forcedInteractiveTransport =
        (parsed.data.provider === 'codex' && transportMode === 'app-server') ||
        (parsed.data.provider === 'claude' && transportMode === 'sdk');
      if (forcedInteractiveTransport && !manifest.interactive) {
        reply.code(422).send({
          error: 'requested provider transport is unavailable',
          code: 'provider_transport_unavailable',
        });
        return;
      }
      const capabilityRequest = capabilityRequestForContinuation(
        parsed.data.capabilities,
        parsed.data.continuation,
      );
      const negotiation = negotiateCapabilities({
        request: capabilityRequest,
        runtimeScope: manifest.runtimeScope,
        supportRecords: manifest.supportRecords,
        transports: manifest.transports,
      });
      if (!negotiation.success) {
        if (negotiation.code === 'required_capability_unavailable') {
          reply.code(422).send({
            error: 'required capabilities unavailable',
            code: negotiation.code,
            details: { unavailableRequired: negotiation.unavailableRequired },
          });
          return;
        }
        throw new Error('invalid legacy v2 capability manifest');
      }

      const transport = manifest.transports.find(
        (candidate) => candidate.id === negotiation.selection.transport,
      );
      if (!transport) throw new Error('negotiation selected an unknown provider transport');
      if (
        trustStore &&
        workspace &&
        (!(await revalidateWorkspaceIdentity(workspace)) ||
          (await trustStore.inspect(workspace)).state !== 'trusted')
      ) {
        reply.code(409).send({
          error: 'workspace trust changed',
          code: 'workspace_untrusted',
        });
        return;
      }
      if (controller.signal.aborted) return;
      const currentWorkspaceTrust = await sessionManager.verifiedWorkspaceTrust(workspace);
      if (
        workspace &&
        (currentWorkspaceTrust.state !== 'trusted' ||
          !sameWorkspaceTrust(workspaceTrust, currentWorkspaceTrust))
      ) {
        reply.code(409).send({
          error: 'workspace trust changed',
          code: 'workspace_untrusted',
        });
        return;
      }
      const fallbackIntent =
        manifest.interactive && parsed.data.provider === 'codex'
          ? {
              request: capabilityRequest,
              cwd: canonicalCwd,
              workspaceTrust: currentWorkspaceTrust,
              requestedTransportMode: transportMode,
              primaryManifest: manifest,
              primarySelection: negotiation.selection,
              continuation: parsed.data.continuation,
            }
          : undefined;
      const legacyIntent =
        !manifest.interactive && parsed.data.provider === 'codex' && transportMode === 'auto'
          ? {
              request: capabilityRequest,
              cwd: canonicalCwd,
              workspaceTrust: currentWorkspaceTrust,
              manifest,
              selection: negotiation.selection,
              continuation: parsed.data.continuation,
            }
          : undefined;
      let session;
      let executionLease: WorkspaceExecutionLease | undefined;
      try {
        if (workspace) {
          executionLease = executionLeases.acquire({
            workspaceId: workspace.workspaceId,
            mode: workspaceLeaseMode(negotiation.selection),
            dirty: await isWorkspaceDirty(workspace),
            allowDirtyShare: parsed.data.allowDirtyWorkspaceShare === true,
          });
        }
        session = await sessions.create(
          { ...parsed.data, cwd: canonicalCwd },
          negotiation.selection,
          transport,
          manifest.interactive,
          controller.signal,
          workspace,
          {
            providerStatus: detected.value,
            ...(fallbackIntent ? { fallbackIntent } : {}),
            ...(legacyIntent ? { legacyIntent } : {}),
          },
          override?.lineage,
        );
      } catch (error) {
        executionLease?.release();
        if (error instanceof WorkspaceExecutionLeaseError) {
          reply.code(409).send({ error: error.message, code: error.code });
          return;
        }
        if (sendPersistedSessionError(reply, error)) return;
        if (!(error instanceof V2ProviderStartupError)) throw error;
        if (sendPersistedSessionError(reply, error, error.reasonCode)) return;
        if (error.reasonCode === 'provider_scope_unverified') {
          reply.code(422).send({
            error: 'provider launch scope could not be verified',
            code: 'provider_scope_unverified',
            details: { reason: error.fallbackReason },
          });
          return;
        }
        reply.code(502).send({
          error: error.message,
          code: error.code,
          details: {
            reason: error.reasonCode,
            deliveryState: error.deliveryState,
            fallback: error.fallbackReason,
          },
        });
        return;
      }
      if (executionLease) releaseExecutionLeaseOnTerminal(sessions, session.id, executionLease);
      if (controller.signal.aborted || req.raw.aborted || reply.raw.destroyed) {
        await sessions.cancel(session.id);
        return;
      }
      reply.code(201).send(session);
    } finally {
      req.raw.off('aborted', abortStart);
      reply.raw.off('close', abortDisconnectedStart);
      sessionManager.shutdownSignal.removeEventListener('abort', abortShutdownStart);
    }
  };

  app.post(
    '/v2/sessions',
    {
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    (req, reply) => startSession(req, reply),
  );

  app.get('/v2/sessions', async (req, reply) => {
    const parsed = sessionListV2QuerySchema.safeParse(normalizePaginationQuery(req.query));
    if (!parsed.success) {
      invalidRequest(reply, parsed.error.flatten());
      return;
    }
    try {
      reply.send(await sessions.list(parsed.data));
    } catch (error) {
      if (!sendPersistedSessionError(reply, error)) throw error;
    }
  });

  app.get('/v2/sessions/:sessionId', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id', code: 'invalid_session_id' });
      return;
    }
    const session = sessions.get(params.data.sessionId);
    if (!session) {
      reply.code(404).send({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    reply.send(session);
  });

  app.get('/v2/sessions/:sessionId/history', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id', code: 'invalid_session_id' });
      return;
    }
    const parsed = sessionEventHistoryV2QuerySchema.safeParse(normalizePaginationQuery(req.query));
    if (!parsed.success) {
      invalidRequest(reply, parsed.error.flatten());
      return;
    }
    try {
      const history = await sessions.history(params.data.sessionId, parsed.data);
      if (!history) {
        reply.code(404).send({ error: 'session not found', code: 'session_not_found' });
        return;
      }
      reply.send(history);
    } catch (error) {
      if (!sendPersistedSessionError(reply, error)) throw error;
    }
  });

  app.get('/v2/sessions/:sessionId/events', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id', code: 'invalid_session_id' });
      return;
    }
    if (!sessions.get(params.data.sessionId)) {
      reply.code(404).send({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    const sinceSequence = parseLastEventId(req.headers['last-event-id']);
    if (sinceSequence === undefined) {
      reply.code(400).send({ error: 'invalid Last-Event-ID', code: 'invalid_last_event_id' });
      return;
    }
    const responderHeader = req.headers['x-agentdock-responder'];
    if (responderHeader !== undefined && responderHeader !== '1') {
      reply.code(400).send({ error: 'invalid responder header', code: 'invalid_request' });
      return;
    }
    const responder = responderHeader === '1';
    const replayWindow = sessions.replayWindow(params.data.sessionId);
    if (!replayWindow) {
      reply.code(404).send({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    if (
      sinceSequence < replayWindow.earliestSequence ||
      sinceSequence > replayWindow.nextSequence
    ) {
      reply.code(409).send({
        error: 'requested event history is unavailable',
        code: 'replay_gap',
        details: replayWindow,
      });
      return;
    }
    const responderLease = responder ? sessions.claimResponder(params.data.sessionId) : undefined;
    if (responder && !responderLease) {
      reply.code(409).send({
        error: 'session already has an active responder',
        code: 'responder_already_connected',
      });
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      ...(responderLease === undefined ? {} : { 'X-AgentDock-Responder-Lease': responderLease }),
    });
    let unsubscribe: (() => void) | undefined;
    let cleanupRequested = false;
    let responderReleased = false;
    const cleanup = (): void => {
      if (responderLease !== undefined && !responderReleased) {
        responderReleased = true;
        sessions.releaseResponder(params.data.sessionId, responderLease);
      }
      if (!unsubscribe) {
        cleanupRequested = true;
        return;
      }
      const release = unsubscribe;
      unsubscribe = undefined;
      release();
    };
    const writer = new BoundedV2SseWriter(reply.raw, cleanup, (event) => {
      if (
        responder &&
        (event.type === 'approval.requested' || event.type === 'question.requested')
      ) {
        sessions.markInteractionPublished(params.data.sessionId, event.requestId);
      }
    });
    reply.raw.once('close', () => writer.close());
    writer.start();

    // Replay can synchronously close the writer before subscribe returns its disposer.
    unsubscribe = sessions.subscribe(params.data.sessionId, sinceSequence, (_sequence, event) => {
      writer.write(event);
    });

    if (!unsubscribe) {
      writer.close();
      return;
    }
    if (cleanupRequested) {
      cleanup();
      return;
    }
    const current = sessions.get(params.data.sessionId);
    const currentIsTerminal =
      !current || ['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status);
    if (currentIsTerminal) writer.finishReplay();
  });

  for (const kind of ['resume', 'fork'] as const) {
    app.post(
      `/v2/sessions/:sessionId/${kind}`,
      {
        config: {
          rateLimit: { max: 30, timeWindow: '1 minute' },
        },
      },
      async (req, reply) => {
        const params = sessionIdParamSchema.safeParse(req.params);
        if (!params.success) {
          reply.code(400).send({ error: 'invalid session id', code: 'invalid_session_id' });
          return;
        }
        const rawPrompt = (req.body as { prompt?: unknown } | null | undefined)?.prompt;
        if (typeof rawPrompt === 'string' && rawPrompt.length > 200_000) {
          reply.code(413).send({ error: 'payload too large', code: 'payload_too_large' });
          return;
        }
        const input = sessionContinuationInputV2Schema.safeParse(req.body);
        if (!input.success) {
          invalidRequest(reply, input.error.flatten());
          return;
        }
        try {
          const continuation = sessions.buildContinuation(params.data.sessionId, kind, input.data);
          await startSession(req, reply, {
            input: continuation.request,
            lineage: continuation.lineage,
          });
        } catch (error) {
          if (!sendPersistedSessionError(reply, error)) throw error;
        }
      },
    );
  }

  app.post('/v2/sessions/:sessionId/commands', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id', code: 'invalid_session_id' });
      return;
    }
    const parsed = agentCommandV2Schema.safeParse(req.body);
    if (!parsed.success) {
      invalidRequest(reply, parsed.error.flatten());
      return;
    }
    if (parsed.data.sessionId !== params.data.sessionId) {
      reply.code(400).send({
        error: 'command session id does not match the route',
        code: 'session_id_mismatch',
      });
      return;
    }
    if (
      (parsed.data.type === 'approval.respond' || parsed.data.type === 'question.respond') &&
      !sessions.hasResponderLease(
        params.data.sessionId,
        typeof req.headers['x-agentdock-responder-lease'] === 'string'
          ? req.headers['x-agentdock-responder-lease']
          : undefined,
      )
    ) {
      reply.code(403).send({
        error: 'interaction response requires the active responder lease',
        code: 'responder_lease_required',
      });
      return;
    }

    const result = await sessions.dispatch(parsed.data);
    if (result.ok) {
      reply.code(202).send(commandAcknowledgementV2Schema.parse(result.acknowledgement));
      return;
    }
    const status =
      result.code === 'session_not_found'
        ? 404
        : result.code === 'session_backpressure'
          ? 429
          : 409;
    reply.code(status).send({ error: result.message, code: result.code });
  });

  app.post('/v2/sessions/:sessionId/cancel', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id', code: 'invalid_session_id' });
      return;
    }
    const session = sessions.get(params.data.sessionId);
    if (!session) {
      reply.code(404).send({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    if (!sessions.hasCapability(session.id, 'session.cancel')) {
      reply
        .code(409)
        .send({ error: 'session.cancel was not selected', code: 'capability_not_selected' });
      return;
    }
    if (!(await sessions.cancel(session.id))) {
      reply.code(404).send({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    reply
      .code(202)
      .send(cancelSessionV2ResponseSchema.parse({ status: 'cancelling', sessionId: session.id }));
  });

  app.delete('/v2/sessions/:sessionId', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id', code: 'invalid_session_id' });
      return;
    }
    const session = sessions.get(params.data.sessionId);
    if (!session) {
      reply.code(404).send({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    if (sessions.isActive(session.id) && !sessions.hasCapability(session.id, 'session.cancel')) {
      reply
        .code(409)
        .send({ error: 'session.cancel was not selected', code: 'capability_not_selected' });
      return;
    }
    try {
      if (!(await sessions.remove(session.id))) {
        reply.code(404).send({ error: 'session not found', code: 'session_not_found' });
        return;
      }
    } catch (error) {
      if (!sendPersistedSessionError(reply, error)) throw error;
      return;
    }
    reply.code(204).send();
  });
}

function releaseExecutionLeaseOnTerminal(
  sessions: V2SessionFacade,
  sessionId: string,
  lease: WorkspaceExecutionLease,
): void {
  let unsubscribe: (() => void) | undefined;
  let terminalDuringReplay = false;
  unsubscribe = sessions.subscribe(sessionId, 0, (_sequence, event) => {
    if (
      event.type !== 'session.completed' &&
      event.type !== 'session.failed' &&
      event.type !== 'session.cancelled' &&
      event.type !== 'session.interrupted'
    ) {
      return;
    }
    lease.release();
    if (unsubscribe) {
      const release = unsubscribe;
      unsubscribe = undefined;
      release();
    } else {
      terminalDuringReplay = true;
    }
  });
  if (!unsubscribe) {
    lease.release();
    return;
  }
  if (terminalDuringReplay) {
    const release = unsubscribe;
    unsubscribe = undefined;
    release();
  }
}
