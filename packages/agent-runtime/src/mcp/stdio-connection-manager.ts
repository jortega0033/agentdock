import type { McpCatalogItemV2, McpToolInvocationResultV2, ProviderId } from '@agent-dock/shared';
import { McpTransportError } from './stdio-jsonrpc-transport.js';
import { StdioMcpConnection, type McpSpawnConfig, type StdioMcpConnectionTimeouts } from './stdio-mcp-connection.js';

export const MCP_MAX_CONCURRENT_CONNECTIONS = 8;
export const MCP_CONNECTION_IDLE_TIMEOUT_MS = 10 * 60_000;

interface PoolEntry {
  connection: StdioMcpConnection;
  connecting: Promise<void>;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout>;
}

export interface StdioConnectionManagerOptions {
  maxConnections?: number;
  idleTimeoutMs?: number;
  /** Test seam: fast connect/list/invoke timeouts so timeout tests don't take real minutes. */
  connectionTimeouts?: StdioMcpConnectionTimeouts;
}

function poolKey(provider: ProviderId, serverId: string, cwd: string): string {
  return `${provider} ${serverId} ${cwd}`;
}

/**
 * The one place a real MCP stdio server process gets created, reused, and torn down. A single
 * shared instance is meant to live for the daemon's whole process lifetime (see
 * `mcp-control.ts`'s default), so `catalog()` followed immediately by `invoke()` for the same
 * server -- the normal shape of one user action, per `routes/v2-mcp.ts`'s invoke route calling
 * `catalog()` first to classify the tool -- reuses one live connection instead of spawning twice.
 * Every path that removes an entry (idle timeout, explicit close, crash, capacity eviction, full
 * shutdown) always awaits `StdioMcpConnection.close()`, which always reaps the process tree
 * (issue #56: "Child processes are always reaped").
 */
export class StdioConnectionManager {
  private readonly pool = new Map<string, PoolEntry>();
  private readonly maxConnections: number;
  private readonly idleTimeoutMs: number;
  private readonly connectionTimeouts: StdioMcpConnectionTimeouts;

  constructor(options: StdioConnectionManagerOptions = {}) {
    this.maxConnections = options.maxConnections ?? MCP_MAX_CONCURRENT_CONNECTIONS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? MCP_CONNECTION_IDLE_TIMEOUT_MS;
    this.connectionTimeouts = options.connectionTimeouts ?? {};
  }

  private async evictOldestIfAtCapacity(): Promise<void> {
    if (this.pool.size < this.maxConnections) return;
    let oldestKey: string | undefined;
    let oldestUsedAt = Infinity;
    for (const [key, entry] of this.pool) {
      if (entry.lastUsedAt < oldestUsedAt) {
        oldestUsedAt = entry.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) await this.closeEntry(oldestKey);
  }

  private async closeEntry(key: string): Promise<void> {
    const entry = this.pool.get(key);
    if (!entry) return;
    this.pool.delete(key);
    clearTimeout(entry.idleTimer);
    await entry.connection.close().catch(() => {});
  }

  private touchIdleTimer(key: string, entry: PoolEntry): void {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      void this.closeEntry(key);
    }, this.idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  private async getConnection(
    provider: ProviderId,
    serverId: string,
    cwd: string,
    spawnConfig: McpSpawnConfig,
  ): Promise<StdioMcpConnection> {
    const key = poolKey(provider, serverId, cwd);
    const existing = this.pool.get(key);
    if (existing) {
      try {
        await existing.connecting;
        existing.lastUsedAt = Date.now();
        this.touchIdleTimer(key, existing);
        return existing.connection;
      } catch {
        await this.closeEntry(key);
      }
    }
    await this.evictOldestIfAtCapacity();
    const connection = new StdioMcpConnection(spawnConfig, cwd, this.connectionTimeouts);
    const connecting = connection.connect();
    const entry: PoolEntry = {
      connection,
      connecting,
      lastUsedAt: Date.now(),
      idleTimer: setTimeout(() => {}, 0),
    };
    this.pool.set(key, entry);
    this.touchIdleTimer(key, entry);
    void connection.crashSignal.then(() => {
      void this.closeEntry(key);
    });
    try {
      await connecting;
    } catch (error) {
      await this.closeEntry(key);
      throw error;
    }
    return connection;
  }

  async getCatalog(
    provider: ProviderId,
    serverId: string,
    cwd: string,
    spawnConfig: McpSpawnConfig,
  ): Promise<McpCatalogItemV2[]> {
    const connection = await this.getConnection(provider, serverId, cwd, spawnConfig);
    try {
      return await connection.listCatalog();
    } catch (error) {
      if (error instanceof McpTransportError) await this.closeFor(provider, serverId, cwd);
      throw error;
    }
  }

  async invoke(
    provider: ProviderId,
    serverId: string,
    cwd: string,
    spawnConfig: McpSpawnConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Pick<McpToolInvocationResultV2, 'status' | 'output' | 'safeSummary'>> {
    const connection = await this.getConnection(provider, serverId, cwd, spawnConfig);
    try {
      return await connection.callTool(toolName, args);
    } catch (error) {
      if (error instanceof McpTransportError) await this.closeFor(provider, serverId, cwd);
      throw error;
    }
  }

  /** Forces the next `getCatalog`/`invoke` for this server to spawn a fresh connection -- used for
   * an explicit reload, a config edit/disable, and workspace-trust revocation. */
  async closeFor(provider: ProviderId, serverId: string, cwd: string): Promise<void> {
    await this.closeEntry(poolKey(provider, serverId, cwd));
  }

  /** True only while a live, pooled connection for this server exists -- test/observability seam
   * for proving reuse (issue #56 requires catalog-then-invoke to share one process) and reaping. */
  hasConnection(provider: ProviderId, serverId: string, cwd: string): boolean {
    return this.pool.has(poolKey(provider, serverId, cwd));
  }

  /** Reaps every live MCP server process. Called on daemon shutdown. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.pool.keys()].map((key) => this.closeEntry(key)));
  }
}
