import { createConsoleLogger } from '@agent-dock/agent-runtime';
import { generateToken } from './auth-token.js';
import {
  DEFAULT_APP_ID,
  assertNoLiveDaemon,
  discoveryFilePath,
  removeDiscoveryFile,
  writeDiscoveryFile,
} from './discovery-file.js';
import { buildProviderRegistry } from './providers.js';
import { buildServer } from './server.js';
import { SessionManager } from './session-manager.js';

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([promise.then(() => true), timedOut]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function main() {
  const logger = createConsoleLogger(
    'daemon',
    process.env.AGENT_DOCK_LOG_LEVEL === 'debug' ? 'debug' : 'info',
  );
  // Namespaces the discovery rendezvous per application (AD-02) so two different products built
  // on this boilerplate can each run their own daemon at once instead of colliding on one
  // machine-global path. The reference desktop app never sets this: it only matters for a fork
  // that wants to coexist with another AgentDock-based app on the same machine.
  const appId = process.env.AGENT_DOCK_APP_ID?.trim() || DEFAULT_APP_ID;
  assertNoLiveDaemon(appId);
  const registry = buildProviderRegistry(logger);
  const sessionManager = new SessionManager(registry, logger);
  const token = generateToken();

  const app = buildServer({ registry, sessionManager, token, logger });

  const requestedPort = Number(process.env.AGENT_DOCK_PORT ?? '0');
  await app.listen({ port: requestedPort, host: '127.0.0.1' });

  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;

  const filePath = writeDiscoveryFile(
    { port, token, pid: process.pid, startedAt: new Date().toISOString() },
    appId,
  );
  logger.info('daemon listening', {
    url: `http://127.0.0.1:${port}`,
    appId,
    discoveryFile: filePath,
  });

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    sessionManager.beginShutdown();
    await sessionManager.cancelAll();
    const closing = app.close().catch((error: unknown) => {
      logger.warn('daemon HTTP shutdown failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    if (!(await settlesWithin(closing, 5_000))) {
      logger.warn('daemon HTTP shutdown exceeded deadline; closing active sockets');
      app.server.closeAllConnections();
      await settlesWithin(closing, 1_000);
    }
    removeDiscoveryFile(appId);
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
