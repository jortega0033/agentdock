import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditReadResponseV2Schema } from '@agent-dock/shared';
import type { AuditStore } from '../audit-store.js';

const auditQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sessionId: z.string().uuid().optional(),
  })
  .strict();

export function registerV2AuditRoutes(app: FastifyInstance, auditStore: AuditStore): void {
  app.get(
    '/v2/audit',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = auditQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        reply.code(400).send({ error: 'invalid audit query', code: 'invalid_request' });
        return;
      }
      reply.send(auditReadResponseV2Schema.parse(await auditStore.read(parsed.data)));
    },
  );
}
