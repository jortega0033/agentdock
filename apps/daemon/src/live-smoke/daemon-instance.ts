import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsoleLogger, type Logger } from '@agent-dock/agent-runtime';
import { buildProviderRegistry } from '../providers.js';
import { buildServer } from '../server.js';
import { SessionManager } from '../session-manager.js';
import { FileSessionStore } from '../session-store.js';
import { WorkspaceTrustStore } from '../workspace-trust-store.js';
import { AuditStore } from '../audit-store.js';
import { generateToken } from '../auth-token.js';

export interface LiveSmokeDaemonInstance {
  baseUrl: string;
  token: string;
  logger: Logger;
  close(): Promise<void>;
}

/**
 * Builds and starts a real daemon -- the actual `buildServer`/`SessionManager`/provider registry
 * this repo ships, not a stand-in -- rooted entirely under its own temp state directory on an
 * ephemeral port. Deliberately does not touch the real desktop app's discovery file or state
 * directory: a live smoke run must never collide with (or be mistaken for) the user's real running
 * daemon.
 */
export async function startLiveSmokeDaemon(): Promise<LiveSmokeDaemonInstance> {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'agent-dock-live-smoke-daemon-'));
  const logger = createConsoleLogger('live-smoke', 'info');
  const registry = buildProviderRegistry(logger);
  const trustStore = new WorkspaceTrustStore(join(stateDirectory, 'workspace-trust-v1.json'));
  const auditStore = new AuditStore(join(stateDirectory, 'audit-v1.jsonl'));
  const sessionStore = new FileSessionStore(join(stateDirectory, 'sessions-v1'));
  const sessionManager = new SessionManager(registry, logger, sessionStore, {
    auditStore,
    trustStore,
    providerStateDirectory: stateDirectory,
  });
  const token = generateToken();
  const app = buildServer({ registry, sessionManager, token, logger, auditStore, trustStore });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    logger,
    async close() {
      try {
        sessionManager.beginShutdown();
        await sessionManager.cancelAll().catch(() => {});
        await app.close().catch(() => {});
      } finally {
        // Temp-directory cleanup must run even if session/server shutdown above throws
        // unexpectedly -- issue #65 requires this harness to never leak temporary state.
        await rm(stateDirectory, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  };
}
