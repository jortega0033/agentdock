import { closeAllMcpConnections, createConsoleLogger } from '@agent-dock/agent-runtime';
import { join } from 'node:path';
import { AuditStore } from './audit-store.js';
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
import { SessionAdmissionController, resolveMaxActiveSessions } from './session-admission.js';
import { FileSessionStore } from './session-store.js';
import { FileExecutionGraphStore } from './execution-graph-store.js';
import { stateDirectory } from './state-directory.js';
import { SubagentGraphStore } from './subagent-graph-store.js';
import { OwnedWorktreeManager } from './worktree-manager.js';
import { AttachmentStore } from './attachment-store.js';
import { WorkspaceTrustStore } from './workspace-trust-store.js';

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
  const durableStateDirectory = stateDirectory({ appId });
  const subagentStore = new SubagentGraphStore(join(durableStateDirectory, 'subagents-v1.json'));
  const trustStore = new WorkspaceTrustStore(
    join(durableStateDirectory, 'workspace-trust-v1.json'),
  );
  const worktreeManager = new OwnedWorktreeManager(
    join(durableStateDirectory, 'worktrees'),
    join(durableStateDirectory, 'worktrees-v1.json'),
    undefined,
    trustStore,
  );
  await worktreeManager.load();
  const attachmentStore = new AttachmentStore(
    join(durableStateDirectory, 'attachments-v1'),
    join(durableStateDirectory, 'attachments-v1.json'),
  );
  await attachmentStore.load();
  const auditStore = new AuditStore(join(durableStateDirectory, 'audit-v1.jsonl'));
  const sessionStoreDirectory = join(durableStateDirectory, 'sessions-v1');
  const sessionStore = new FileSessionStore(sessionStoreDirectory);
  const executionGraphStore = new FileExecutionGraphStore(
    join(durableStateDirectory, 'execution-graph-v1'),
    {
      additionalQuotaPaths: [sessionStoreDirectory],
      onLineageRemoving: (records) => {
        for (const record of records) sessionStore.delete(record.session.id);
      },
    },
  );
  const sessionRecovery = sessionStore.getRecoveryReport();
  const graphRecovery = executionGraphStore.recoveryReport();
  if (
    sessionRecovery.quarantinedFiles.length > 0 ||
    sessionRecovery.interruptedSessionIds.length > 0 ||
    graphRecovery.quarantinedPaths.length > 0 ||
    graphRecovery.interruptedSessionIds.length > 0
  ) {
    logger.warn('durable session recovery required repairs', {
      quarantinedSessionRecords: sessionRecovery.quarantinedFiles.length,
      quarantinedExecutionRecords: graphRecovery.quarantinedPaths.length,
      interruptedCompatibilitySessions: sessionRecovery.interruptedSessionIds.length,
      interruptedExecutions: graphRecovery.interruptedSessionIds.length,
    });
  }
  // Fails fast (throws, caught by main().catch() below) on an out-of-range or non-integer value
  // rather than silently clamping, so a misconfigured deployment never launches with a capacity
  // limit it never intended.
  const admission = new SessionAdmissionController({
    maxActiveSessions: resolveMaxActiveSessions(process.env.AGENT_DOCK_MAX_ACTIVE_SESSIONS),
  });
  const sessionManager = new SessionManager(registry, logger, sessionStore, {
    auditStore,
    trustStore,
    providerStateDirectory: durableStateDirectory,
    executionGraphStore,
    subagentStore,
    admission,
  });
  const token = generateToken();

  const app = buildServer({
    registry,
    sessionManager,
    token,
    logger,
    auditStore,
    trustStore,
    subagentStore,
    worktreeManager,
    attachmentStore,
  });

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
    await closeAllMcpConnections().catch(() => {
      logger.warn('MCP connection cleanup failed');
    });
    const closing = app.close().catch(() => {
      logger.warn('daemon HTTP shutdown failed');
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

main().catch(() => {
  console.error('daemon failed to start');
  process.exit(1);
});

export { discoveryFilePath };
