import type { FastifyInstance } from 'fastify';
import { AGENT_DOCK_PROTOCOL_VERSION } from '@agent-dock/shared';

export function registerHealthRoute(app: FastifyInstance, startedAt: number): void {
  app.get('/health', async () => ({
    status: 'ok' as const,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    protocolVersion: AGENT_DOCK_PROTOCOL_VERSION,
  }));
}
