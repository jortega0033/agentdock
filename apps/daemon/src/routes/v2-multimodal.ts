import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  attachmentIdV2Schema,
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
  // Issue #132: the first byte-level retrieval route this store has ever needed -- every prior
  // consumer either only ever needed the metadata list above, or (`referenceForDispatch()`) is a
  // trusted in-process caller reading the file directly, never a route. Content-Disposition stays
  // `attachment` unconditionally: nothing staged through this store today is safe to render inline
  // in a browsing context (tool output can contain anything a command printed).
  app.get('/v2/attachments/:id/content', async (req, reply) => {
    const parsed = attachmentIdV2Schema.safeParse((req.params as { id?: unknown }).id);
    if (!parsed.success)
      return fail(reply, 400, 'invalid_attachment_request', 'Invalid attachment id');
    try {
      const { metadata, stream } = store.openContent(parsed.data);
      reply
        .header('content-type', metadata.mimeType)
        .header(
          'content-disposition',
          `attachment; filename="${metadata.fileName.replace(/"/g, '')}"`,
        )
        .header('content-length', String(metadata.size));
      return reply.send(stream);
    } catch (error) {
      attachmentFailure(reply, error);
      return undefined;
    }
  });
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
  app.delete('/v2/attachments/:id', async (req, reply) => {
    const parsed = attachmentIdV2Schema.safeParse((req.params as { id?: unknown }).id);
    if (!parsed.success)
      return fail(reply, 400, 'invalid_attachment_request', 'Invalid attachment id');
    // Deletion is idempotent and unconditional -- explicit user-triggered release, same as
    // `apps/daemon/src/worktree-manager.ts`'s cleanup route, not gated on reference/session state.
    await store.deleteAttachments([parsed.data]);
    reply.code(204).send();
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
