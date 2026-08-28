import type { FastifyInstance } from 'fastify';

export function registerHealthRoute(app: FastifyInstance, startedAt: number): void {
  app.get('/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  }));
}
