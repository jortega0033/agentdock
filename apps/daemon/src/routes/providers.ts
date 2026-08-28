import type { FastifyInstance } from 'fastify';
import { providerIdSchema } from '@agent-dock/shared';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';

export function registerProviderRoutes(app: FastifyInstance, registry: ProviderRegistry): void {
  app.get('/providers', async () => ({ providers: await registry.detectAll() }));

  app.get('/providers/:providerId', async (req, reply) => {
    const parsed = providerIdSchema.safeParse((req.params as Record<string, unknown>).providerId);
    if (!parsed.success) {
      reply.code(400).send({ error: 'unknown provider id' });
      return;
    }
    const provider = registry.get(parsed.data);
    if (!provider) {
      reply.code(404).send({ error: 'provider not registered' });
      return;
    }
    reply.send(await provider.detect());
  });
}
