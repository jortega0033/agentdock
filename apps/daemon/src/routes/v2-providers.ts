import type { FastifyInstance } from 'fastify';
import {
  providerIdSchema,
  providerStatusV2Schema,
  providersV2ResponseSchema,
} from '@agent-dock/shared';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';
import { toProviderStatusV2 } from '../provider-v2.js';

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
}
