import { existsSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  providerIdSchema,
  providerModelCatalogV2ResponseSchema,
  providerStatusV2Schema,
  providersV2ResponseSchema,
} from '@agent-dock/shared';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';
import { ProviderTransportStartupError } from '@agent-dock/agent-runtime';
import { z } from 'zod';
import { toProviderStatusV2 } from '../provider-v2.js';

const modelCatalogQuerySchema = z.object({ cwd: z.string().min(1).max(32_768) }).strict();

export function registerV2ProviderRoutes(app: FastifyInstance, registry: ProviderRegistry): void {
  app.get('/v2/providers', async () => {
    const providers = await Promise.all(
      registry
        .list()
        .map(async (provider) => toProviderStatusV2(provider, await provider.detect())),
    );
    return providersV2ResponseSchema.parse({ providers });
  });

  app.get('/v2/providers/:providerId', async (req, reply) => {
    const parsed = providerIdSchema.safeParse((req.params as Record<string, unknown>).providerId);
    if (!parsed.success) {
      reply.code(400).send({ error: 'unknown provider id', code: 'invalid_provider_id' });
      return;
    }

    const provider = registry.get(parsed.data);
    if (!provider) {
      reply.code(404).send({ error: 'provider not registered', code: 'provider_not_found' });
      return;
    }

    reply.send(providerStatusV2Schema.parse(toProviderStatusV2(provider, await provider.detect())));
  });

  app.get(
    '/v2/providers/:providerId/models',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const providerId = providerIdSchema.safeParse(
        (req.params as Record<string, unknown>).providerId,
      );
      if (!providerId.success) {
        reply.code(400).send({ error: 'unknown provider id', code: 'invalid_provider_id' });
        return;
      }
      const query = modelCatalogQuerySchema.safeParse(req.query);
      if (!query.success) {
        reply.code(400).send({ error: 'invalid model catalog request', code: 'invalid_request' });
        return;
      }
      const provider = registry.get(providerId.data);
      if (!provider) {
        reply.code(404).send({ error: 'provider not registered', code: 'provider_not_found' });
        return;
      }
      if (!existsSync(query.data.cwd) || !statSync(query.data.cwd).isDirectory()) {
        reply.code(400).send({
          error: `working directory does not exist: ${query.data.cwd}`,
          code: 'invalid_working_directory',
        });
        return;
      }
      if (!provider.fetchModelCatalog) {
        reply.code(409).send({
          error: 'provider does not expose a model catalog',
          code: 'operation_unsupported',
        });
        return;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.raw.once('aborted', abort);
      try {
        const models = await provider.fetchModelCatalog({
          cwd: query.data.cwd,
          signal: controller.signal,
        });
        reply.send(providerModelCatalogV2ResponseSchema.parse({ models }));
      } catch (error) {
        if (error instanceof ProviderTransportStartupError) {
          reply.code(502).send({
            error: error.message,
            code: error.reasonCode,
          });
          return;
        }
        throw error;
      } finally {
        req.raw.off('aborted', abort);
      }
    },
  );
}
