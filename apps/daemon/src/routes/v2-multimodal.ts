import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  attachmentListV2Schema,
  attachmentMetadataV2Schema,
  attachmentReferenceRequestV2Schema,
  attachmentUploadHeadersV2Schema,
  structuredWorkflowRequestV2Schema,
  structuredWorkflowResultV2Schema,
} from '@agent-dock/shared';
import { AttachmentStore, AttachmentStoreError } from '../attachment-store.js';
import { validateStructuredOutput } from '../structured-output.js';
import type { SessionManager } from '../session-manager.js';

function fail(reply: FastifyReply, status: number, code: string, error: string): void {
  reply.code(status).send({ code, error });
}
function attachmentFailure(reply: FastifyReply, error: unknown): void {
  if (error instanceof AttachmentStoreError)
    return fail(
      reply,
      error.code === 'attachment_not_found' ? 404 : 413,
      error.code,
      error.message,
    );
  fail(reply, 500, 'attachment_failed', 'Attachment operation failed');
}

export function registerV2MultimodalRoutes(
  app: FastifyInstance,
  store: AttachmentStore,
  sessions: SessionManager,
): void {
  app.post(
    '/v2/attachments',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, bodyLimit: 25 * 1024 * 1024 + 1 },
    async (req, reply) => {
      let fileName: string;
      try {
        fileName = decodeURIComponent(String(req.headers['x-agentdock-filename'] ?? ''));
      } catch {
        return fail(reply, 400, 'invalid_attachment_request', 'Invalid attachment filename');
      }
      const parsed = attachmentUploadHeadersV2Schema.safeParse({
        fileName,
        declaredSize: Number(req.headers['content-length']),
        ...(req.headers['x-agentdock-session-id']
          ? { sessionId: String(req.headers['x-agentdock-session-id']) }
          : {}),
      });
      if (
        !parsed.success ||
        !req.body ||
        typeof (req.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function'
      )
        return fail(reply, 400, 'invalid_attachment_request', 'Invalid attachment upload');
      if (parsed.data.sessionId && !sessions.get(parsed.data.sessionId))
        return fail(reply, 404, 'session_not_found', 'Session not found');
      try {
        reply
          .code(201)
          .send(
            attachmentMetadataV2Schema.parse(
              await store.stage({ ...parsed.data, stream: req.body as AsyncIterable<Uint8Array> }),
            ),
          );
      } catch (error) {
        attachmentFailure(reply, error);
      }
    },
  );
  app.get('/v2/attachments', async (_req, reply) =>
    reply.send(attachmentListV2Schema.parse({ attachments: store.list() })),
  );
  app.post('/v2/attachments/reference', async (req, reply) => {
    const parsed = attachmentReferenceRequestV2Schema.safeParse(req.body);
    if (!parsed.success)
      return fail(reply, 400, 'invalid_attachment_request', 'Invalid attachment reference request');
    if (!sessions.get(parsed.data.sessionId))
      return fail(reply, 404, 'session_not_found', 'Session not found');
    try {
      reply.send(
        attachmentListV2Schema.parse({
          attachments: await store.reference(parsed.data.attachmentIds, parsed.data.sessionId),
        }),
      );
    } catch (error) {
      attachmentFailure(reply, error);
    }
  });
  app.post('/v2/workflows/structured/validate', async (req, reply) => {
    const parsed = structuredWorkflowRequestV2Schema.safeParse(req.body);
    if (!parsed.success)
      return fail(
        reply,
        400,
        'invalid_structured_workflow',
        'Schema exceeds the 64 KiB, depth 16, or 1,024-node limits',
      );
    reply.send(
      structuredWorkflowResultV2Schema.parse(
        validateStructuredOutput(parsed.data.schema, parsed.data.output),
      ),
    );
  });
}
