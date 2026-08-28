import { createConsoleLogger } from '@agent-dock/agent-runtime';
import { generateToken } from './auth-token.js';
import { assertNoLiveDaemon, discoveryFilePath, removeDiscoveryFile, writeDiscoveryFile } from './discovery-file.js';
import { buildProviderRegistry } from './providers.js';
import { buildServer } from './server.js';
import { SessionManager } from './session-manager.js';

async function main() {
  const logger = createConsoleLogger('daemon', process.env.AGENT_DOCK_LOG_LEVEL === 'debug' ? 'debug' : 'info');
  assertNoLiveDaemon();
  const registry = buildProviderRegistry(logger);
  const sessionManager = new SessionManager(registry, logger);
  const token = generateToken();
  const allowedDevOrigins = (process.env.AGENT_DOCK_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const app = buildServer({ registry, sessionManager, token, logger, allowedDevOrigins });

  const requestedPort = Number(process.env.AGENT_DOCK_PORT ?? '0');
  await app.listen({ port: requestedPort, host: '127.0.0.1' });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;

  const filePath = writeDiscoveryFile({ port, token, pid: process.pid, startedAt: new Date().toISOString() });
  logger.info('daemon listening', { url: `http://127.0.0.1:${port}`, discoveryFile: filePath });

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    await sessionManager.cancelAll();
    await app.close();
    removeDiscoveryFile();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('daemon failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});

export { discoveryFilePath };
