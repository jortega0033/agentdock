import { existsSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createSessionRequestSchema, sessionIdParamSchema } from '@agent-dock/shared';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';
import type { SessionManager } from '../session-manager.js';

export function registerSessionRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager,
  registry: ProviderRegistry,
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
    if (resumeProviderSessionId && !(await providerImpl.detect()).capabilities.resume) {
      reply.code(400).send({ error: `provider does not support resume: ${provider}` });
      return;
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      reply.code(400).send({ error: `working directory does not exist: ${cwd}` });
      return;
    }

    const session = sessionManager.create(provider, cwd, prompt, resumeProviderSessionId);
    reply.code(201).send(session);
  });

  app.get('/sessions/:sessionId', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id' });
      return;
    }
    const session = sessionManager.get(params.data.sessionId);
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
    if (!sessionManager.get(params.data.sessionId)) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    reply.raw.write(':ok\n\n');

    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
    const sinceIndex = lastEventId ? Number(lastEventId) + 1 : 0;

    let ended = false;
    // Declared separately (not `const unsubscribe = subscribe(...)`) because the listener below
    // can run *synchronously inside* this call (replaying already-stored events) — referencing
    // `unsubscribe` from inside it before a combined declaration+assignment finished initializing
    // would throw. `let` here is deliberate, not a lint slip.
    let unsubscribe: (() => void) | undefined;
    // eslint-disable-next-line prefer-const
    unsubscribe = sessionManager.subscribe(
      params.data.sessionId,
      Number.isFinite(sinceIndex) ? sinceIndex : 0,
      (index, event) => {
        reply.raw.write(`id: ${index}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'session.completed' || event.type === 'session.failed' || event.type === 'session.cancelled') {
          ended = true;
          unsubscribe?.();
          reply.raw.end();
        }
      },
    );

    // If the session was already terminal, the listener above fired synchronously during
    // subscribe() (before `unsubscribe` was assigned) — clean it up now instead.
    if (ended) unsubscribe?.();
    else req.raw.on('close', () => unsubscribe?.());
  });

  app.post('/sessions/:sessionId/cancel', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id' });
      return;
    }
    const ok = await sessionManager.cancel(params.data.sessionId);
    if (!ok) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    reply.code(202).send({ status: 'cancelling' });
  });

  app.delete('/sessions/:sessionId', async (req, reply) => {
    const params = sessionIdParamSchema.safeParse(req.params);
    if (!params.success) {
      reply.code(400).send({ error: 'invalid session id' });
      return;
    }
    const ok = await sessionManager.remove(params.data.sessionId);
    if (!ok) {
      reply.code(404).send({ error: 'session not found' });
      return;
    }
    reply.code(204).send();
  });
}
