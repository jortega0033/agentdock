import { existsSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createSessionRequestSchema, sessionIdParamSchema } from '@agent-dock/shared';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';
import type { SessionManager } from '../session-manager.js';
import type { WorkspaceTrustStore } from '../workspace-trust-store.js';
import { resolveWorkspaceIdentity, revalidateWorkspaceIdentity } from '../workspace-identity.js';
import { BoundedV1SseWriter } from '../v1-sse-writer.js';

const TERMINAL_SESSION_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function registerSessionRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager,
  registry: ProviderRegistry,
  trustStore?: WorkspaceTrustStore,
): void {
  app.post('/sessions', async (req, reply) => {
    const parsed = createSessionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid request body', details: parsed.error.flatten() });
      return;
    }
    const { provider, cwd, prompt, resumeProviderSessionId } = parsed.data;

    const providerImpl = registry.get(provider);
    if (!providerImpl) {
      reply.code(400).send({ error: `unsupported provider: ${provider}` });
      return;
    }
    const workspace = trustStore
      ? await resolveWorkspaceIdentity(cwd).catch(() => undefined)
      : undefined;
    if (trustStore) {
      if (!workspace) {
        reply.code(400).send({ error: 'workspace could not be resolved' });
        return;
      }
      if ((await trustStore.inspect(workspace)).state !== 'trusted') {
        reply.code(409).send({ error: 'workspace is not trusted', code: 'workspace_untrusted' });
        return;
      }
    }
    if (resumeProviderSessionId && !(await providerImpl.detect()).capabilities.resume) {
      reply.code(400).send({ error: `provider does not support resume: ${provider}` });
      return;
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      reply.code(400).send({ error: `working directory does not exist: ${cwd}` });
      return;
    }

    if (
      trustStore &&
      workspace &&
      (!(await revalidateWorkspaceIdentity(workspace)) ||
        (await trustStore.inspect(workspace)).state !== 'trusted')
    ) {
      reply.code(409).send({ error: 'workspace trust changed', code: 'workspace_untrusted' });
      return;
    }

    const session = sessionManager.create(
      provider,
      workspace?.canonicalPath ?? cwd,
      prompt,
      resumeProviderSessionId,
      1,
      workspace,
    );
    reply.code(201).send(session);
  });

  app.get('/sessions/:sessionId', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id' });
      return;
    }
    const session = sessionManager.get(params.data.sessionId, 1);
    if (!session) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    reply.send(session);
  });

  app.get('/sessions/:sessionId/events', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id' });
      return;
    }
    if (!sessionManager.get(params.data.sessionId, 1)) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
    const sinceIndex = lastEventId ? Number(lastEventId) + 1 : 0;

    let unsubscribe: (() => void) | undefined;
    let cleanupRequested = false;
    const cleanup = (): void => {
      if (!unsubscribe) {
        cleanupRequested = true;
        return;
      }
      const release = unsubscribe;
      unsubscribe = undefined;
      release();
    };
    // Bounded, backpressure-aware writer (see v1-sse-writer.ts): enqueues synchronously, honors
    // `reply.raw.write`'s drain signal, and disconnects only this one slow subscriber -- never the
    // provider session -- on overflow.
    const writer = new BoundedV1SseWriter(reply.raw, cleanup);
    reply.raw.once('close', () => writer.close());
    writer.start();

    // Replay can synchronously close the writer before subscribe returns its disposer.
    unsubscribe = sessionManager.subscribe(
      params.data.sessionId,
      Number.isFinite(sinceIndex) ? sinceIndex : 0,
      (_index, event) => writer.write(event),
      1,
    );

    if (!unsubscribe) {
      // Lost the race against a concurrent DELETE that ran between the existence check above and
      // subscribe(): the session's runtime state is already gone. Without this, the already-200
      // response would stay open forever with no data and no close (the exact race the daemon
      // audit flagged for this route).
      writer.close();
      return;
    }
    if (cleanupRequested) {
      cleanup();
      return;
    }
    // A client reconnecting with Last-Event-ID past the terminal event (already has it) replays
    // nothing, so the writer never sees a terminal frame to close on; without this the connection
    // would stay open forever once the runtime has no more events left to ever emit.
    const current = sessionManager.get(params.data.sessionId, 1);
    if (!current || TERMINAL_SESSION_STATUSES.has(current.status)) writer.finishReplay();
  });

  app.post('/sessions/:sessionId/cancel', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id' });
      return;
    }
    const ok = await sessionManager.cancel(params.data.sessionId, 1);
    if (!ok) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    reply.code(202).send({ status: 'cancelling' });
  });

  // Narrow, single-purpose route (not a generic process-control endpoint) so Electron's shutdown
  // path can ask the daemon to cancel every in-flight session over HTTP, which Windows can
  // deliver reliably, unlike a real SIGTERM to the daemon process itself (child.kill() maps to
  // TerminateProcess on Windows, so the daemon's own SIGTERM handler never runs there; see
  // apps/desktop/electron/main.ts#killDaemon and SECURITY.md). AD-12.
  app.post('/sessions/cancel-all', async (_req, reply) => {
    await sessionManager.cancelAll(5_000, 1);
    reply.code(202).send({ status: 'cancelling' });
  });

  app.delete('/sessions/:sessionId', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id' });
      return;
    }
    const ok = await sessionManager.remove(params.data.sessionId, 1);
    if (!ok) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    reply.code(204).send();
  });
}
