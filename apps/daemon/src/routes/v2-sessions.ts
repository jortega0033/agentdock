import { existsSync, statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  createSessionV2RequestSchema,
  cancelSessionV2ResponseSchema,
  negotiateCapabilities,
  sessionIdParamSchema,
  type AgentEventV2Envelope,
} from '@agent-dock/shared';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';
import type { SessionManager } from '../session-manager.js';
import {
  legacyCapabilityRecords,
  legacyRuntimeScope,
  legacyTransports,
} from '../v2-legacy-provider.js';
import { V2SessionFacade } from '../v2-session-facade.js';

function invalidRequest(reply: FastifyReply, details: unknown): void {
  reply.code(400).send({ error: 'invalid request body', code: 'invalid_request', details });
}

function parseLastEventId(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed < Number.MAX_SAFE_INTEGER ? parsed + 1 : undefined;
}

function isTerminal(event: AgentEventV2Envelope): boolean {
  return (
    event.type === 'session.completed' ||
    event.type === 'session.failed' ||
    event.type === 'session.cancelled' ||
    event.type === 'session.interrupted'
  );
}

export function registerV2SessionRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager,
  registry: ProviderRegistry,
): void {
  const sessions = new V2SessionFacade(sessionManager);

  app.post(
    '/v2/sessions',
    {
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const rawPrompt = (req.body as { prompt?: unknown } | null | undefined)?.prompt;
      if (typeof rawPrompt === 'string' && rawPrompt.length > 200_000) {
        reply.code(413).send({ error: 'payload too large', code: 'payload_too_large' });
        return;
      }

      const parsed = createSessionV2RequestSchema.safeParse(req.body);
      if (!parsed.success) {
        invalidRequest(reply, parsed.error.flatten());
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

      const status = await provider.detect();
      const negotiation = negotiateCapabilities({
        request: parsed.data.capabilities,
        runtimeScope: legacyRuntimeScope(status),
        supportRecords: legacyCapabilityRecords(status),
        transports: legacyTransports(),
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

      reply.code(201).send(sessions.create(parsed.data, negotiation.selection));
    },
  );

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

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    reply.raw.write(':ok\n\n');

    let ended = false;
    let unsubscribe: (() => void) | undefined;
    // As in the v1 route, replay can invoke this listener synchronously before subscribe returns.
    // eslint-disable-next-line prefer-const
    unsubscribe = sessions.subscribe(params.data.sessionId, sinceSequence, (sequence, event) => {
      reply.raw.write(`id: ${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (isTerminal(event)) {
        ended = true;
        unsubscribe?.();
        reply.raw.end();
      }
    });

    if (!unsubscribe) {
      reply.raw.end();
      return;
    }
    const current = sessions.get(params.data.sessionId);
    const currentIsTerminal =
      !current || ['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status);
    if (ended || currentIsTerminal) {
      unsubscribe();
      if (!ended) reply.raw.end();
    } else req.raw.on('close', () => unsubscribe?.());
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
    if (!(await sessions.remove(session.id))) {
      reply.code(404).send({ error: 'session not found', code: 'session_not_found' });
      return;
    }
    reply.code(204).send();
  });
}
