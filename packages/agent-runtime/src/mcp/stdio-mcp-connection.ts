import type { McpCatalogItemV2, McpToolInvocationResultV2 } from '@agent-dock/shared';
import { McpTransportError, StdioJsonRpcTransport } from './stdio-jsonrpc-transport.js';
import { buildBaseProcessEnvironment } from '../process/provider-environment.js';

/**
 * This client is dual-era per issue #139: it speaks the modern (2026-07-28, per-request `_meta`,
 * no handshake) protocol when a server supports it, and falls back to the legacy (`initialize`
 * handshake) protocol otherwise. Versions verified against the authoritative spec pages at
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning,
 * .../2026-07-28/basic/transports/stdio, and .../2026-07-28/server/discover -- not a summary.
 */
export const MCP_MODERN_PROTOCOL_VERSION = '2026-07-28';
/** The client's own supported legacy revisions, most-preferred first -- the client SHOULD send
 * its latest supported version, and a legacy server MAY counter-offer a different one of these
 * (spec: 2025-11-25 lifecycle, "Version Negotiation"). */
export const MCP_SUPPORTED_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18'] as const;
/** JSON-RPC 2.0's reserved "Method not found" code -- the only server response this client is
 * entitled to read as "this optional method doesn't exist here." Any other error code (auth
 * failure, malformed request, a genuine -32000-range server error) is a real failure and must
 * propagate, not collapse into a falsely-empty catalog (issue #139). */
const MCP_METHOD_NOT_FOUND = -32601;
/** MCP 2026-07-28's reserved `UnsupportedProtocolVersionError` code. A response carrying this
 * code -- unlike any other error -- still identifies the server as modern; the client must not
 * fall back to the legacy handshake on this specific error (spec: stdio backward compatibility). */
const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;

type McpEra = 'legacy' | 'modern';
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
export const MCP_LIST_TIMEOUT_MS = 15_000;
export const MCP_INVOKE_TIMEOUT_MS = 60_000;
/** Well under the wire schema's 10_000-item cap: a real bound, not the schema's outer limit. */
export const MCP_MAX_CATALOG_ITEMS_PER_KIND = 500;
export const MCP_MAX_INVOKE_RESULT_BYTES = 1024 * 1024;

export interface McpSpawnConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maxLength) : undefined;
}

/**
 * A tool with no annotations, or one that doesn't explicitly mark itself read-only, is treated as
 * destructive and side-effecting -- fail closed on an unknown-risk tool rather than assume safety
 * a real MCP server never actually declared (issue #56: "fail closed" is a stated acceptance
 * criterion, not just a description of error paths).
 */
function classifyTool(tool: McpToolDescriptor): { destructive: boolean; sideEffecting: boolean } {
  const readOnly = tool.annotations?.readOnlyHint === true;
  if (readOnly) return { destructive: false, sideEffecting: false };
  // The only way out of "destructive" is an explicit readOnlyHint above -- a server setting
  // `destructiveHint: false` without also declaring readOnlyHint must never be enough on its own
  // to skip the approval gate (a real bug this exact line had before: `!== false` treated an
  // explicit `false` as permission to downgrade, the opposite of fail-closed).
  return { destructive: true, sideEffecting: true };
}

/**
 * One live MCP session over a spawned stdio server process: the `initialize` handshake, bounded
 * `tools/resources/prompts` listing, and `tools/call` invocation. Tolerant of a server that never
 * implements resources/prompts (a real, common case): a `-32601 Method not found` response for
 * those two lists is treated as "this server has none," not a connection failure.
 */
export interface StdioMcpConnectionTimeouts {
  connectMs?: number;
  listMs?: number;
  invokeMs?: number;
}

export class StdioMcpConnection {
  private readonly transport: StdioJsonRpcTransport;
  private initialized = false;
  private readonly timeouts: Required<StdioMcpConnectionTimeouts>;
  /** Decided exactly once per connection by `negotiateEra()`, before any real dispatch ever
   * happens -- so there is nothing in flight to replay when it settles (issue #139). Cached for
   * this connection's lifetime; `StdioConnectionManager` already pools one connection per
   * (provider, serverId, cwd), which gives this the process-lifetime scope the spec asks for. */
  private era: McpEra | undefined;

  constructor(spawnConfig: McpSpawnConfig, cwd: string, timeouts: StdioMcpConnectionTimeouts = {}) {
    this.timeouts = {
      connectMs: timeouts.connectMs ?? MCP_CONNECT_TIMEOUT_MS,
      listMs: timeouts.listMs ?? MCP_LIST_TIMEOUT_MS,
      invokeMs: timeouts.invokeMs ?? MCP_INVOKE_TIMEOUT_MS,
    };
    // Sanitized, default-deny floor (issue #103) -- never the daemon's raw `process.env`, which
    // would otherwise hand every MCP server child AgentDock discovery tokens, state paths, and any
    // arbitrary AGENT_DOCK_* variable a downstream fork adds. The server's own declared `env`
    // entries (already bounded/validated in mcp-control.ts) layer on top, same as the provider CLI
    // path in packages/agent-runtime/src/process/provider-environment.ts.
    this.transport = new StdioJsonRpcTransport(spawnConfig.command, spawnConfig.args, {
      cwd,
      env: { ...buildBaseProcessEnvironment(), ...(spawnConfig.env ?? {}) },
    });
  }

  get pid(): number | undefined {
    return this.transport.pid;
  }

  private clientInfo(): { name: string; version: string } {
    return { name: 'agent-dock', version: '1' };
  }

  private modernMeta(): Record<string, unknown> {
    return {
      'io.modelcontextprotocol/protocolVersion': MCP_MODERN_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': this.clientInfo(),
      'io.modelcontextprotocol/clientCapabilities': {},
    };
  }

  /** A request under the negotiated era: modern requests carry `_meta` on every call (spec: "All
   * request metadata for the stdio transport is carried inline in the JSON-RPC message body");
   * legacy requests are the plain params this client already sent before #139. */
  private eraParams(params: Record<string, unknown>): Record<string, unknown> {
    return this.era === 'modern' ? { ...params, _meta: this.modernMeta() } : params;
  }

  async connect(): Promise<void> {
    if (this.initialized) return;
    if (this.era === undefined) await this.negotiateEra();
    if (this.era === 'modern') {
      // Modern is stateless by design (spec: "There is no negotiation handshake") -- the
      // discover probe already proved this server accepts a mutually supported version, so there
      // is no handshake left to perform before normal dispatch can carry `_meta`.
      this.initialized = true;
      return;
    }
    const result = await this.transport.request(
      'initialize',
      {
        protocolVersion: MCP_SUPPORTED_LEGACY_VERSIONS[0],
        capabilities: {},
        clientInfo: this.clientInfo(),
      },
      this.timeouts.connectMs,
    );
    const negotiatedVersion = (result as Record<string, unknown> | undefined)?.protocolVersion;
    if (
      typeof negotiatedVersion !== 'string' ||
      !(MCP_SUPPORTED_LEGACY_VERSIONS as readonly string[]).includes(negotiatedVersion)
    ) {
      // The server counter-offered a revision this client does not actually understand (spec:
      // "If the client does not support the version in the server's response, it SHOULD
      // disconnect") -- proceeding anyway would silently speak a protocol version nothing here
      // was verified against.
      throw new McpTransportError(
        'protocol_error',
        `MCP server negotiated an unsupported legacy protocol version: ${String(negotiatedVersion)}`,
      );
    }
    this.transport.notify('notifications/initialized');
    this.initialized = true;
  }

  /**
   * Determines the server's era exactly once, before any real dispatch, per the MCP 2026-07-28
   * stdio backward-compatibility algorithm (spec: .../basic/transports/stdio#backward-
   * compatibility): probe with `server/discover`. A `DiscoverResult` or a recognized
   * `UnsupportedProtocolVersionError` (-32022) both mean the server is modern -- the fallback to
   * legacy must never trigger on either. Any other error, or no response within the bounded
   * connect timeout, means legacy: the probe adds no new process/spawn, it is one more request on
   * the connection this class already owns.
   */
  private async negotiateEra(): Promise<void> {
    let result: unknown;
    try {
      result = await this.transport.request(
        'server/discover',
        { _meta: this.modernMeta() },
        this.timeouts.connectMs,
      );
    } catch (error) {
      if (
        error instanceof McpTransportError &&
        error.code === 'protocol_error' &&
        error.jsonRpcCode === MCP_UNSUPPORTED_PROTOCOL_VERSION
      ) {
        this.assertModernVersionSupported(this.offeredVersions(error.jsonRpcData));
        this.era = 'modern';
        return;
      }
      // The fallback MUST NOT be keyed to one specific error code: a legacy server answers an
      // unknown pre-initialize method with an implementation-defined error (commonly -32601 or
      // -32602), or a timeout above already threw a distinct 'timeout' McpTransportError here.
      this.era = 'legacy';
      return;
    }
    const supportedVersions = this.discoverResultVersions(result);
    if (supportedVersions === undefined) {
      // A response arrived but does not look like a real DiscoverResult -- "anything else
      // identifies a legacy server," not a crash and not a guessed modern version.
      this.era = 'legacy';
      return;
    }
    this.assertModernVersionSupported(supportedVersions);
    this.era = 'modern';
  }

  private discoverResultVersions(result: unknown): string[] | undefined {
    if (!result || typeof result !== 'object') return undefined;
    const supportedVersions = (result as Record<string, unknown>).supportedVersions;
    if (!Array.isArray(supportedVersions) || !supportedVersions.every((v) => typeof v === 'string'))
      return undefined;
    return supportedVersions as string[];
  }

  private offeredVersions(data: unknown): string[] {
    if (!data || typeof data !== 'object') return [];
    const supported = (data as Record<string, unknown>).supported;
    return Array.isArray(supported) ? supported.filter((v): v is string => typeof v === 'string') : [];
  }

  private assertModernVersionSupported(offered: readonly string[]): void {
    if (offered.includes(MCP_MODERN_PROTOCOL_VERSION)) return;
    throw new McpTransportError(
      'protocol_error',
      `MCP server does not support a compatible protocol version (offered: ${offered.join(', ') || 'none'})`,
    );
  }

  private async listOptional(method: string, resultKey: string): Promise<unknown[]> {
    try {
      const result = (await this.transport.request(
        method,
        this.eraParams({}),
        this.timeouts.listMs,
      )) as Record<string, unknown> | undefined;
      const items = result?.[resultKey];
      return Array.isArray(items) ? items.slice(0, MCP_MAX_CATALOG_ITEMS_PER_KIND) : [];
    } catch (error) {
      // A server that never implements an optional listing method reports "method not found";
      // this connection has none of that kind, which is a legitimate empty result, not a failure.
      // Any other error code (auth, malformed request, a genuine server error) is a real failure.
      if (
        error instanceof McpTransportError &&
        error.code === 'protocol_error' &&
        error.jsonRpcCode === MCP_METHOD_NOT_FOUND
      )
        return [];
      throw error;
    }
  }

  async listCatalog(): Promise<McpCatalogItemV2[]> {
    if (!this.initialized) await this.connect();
    const [tools, resources, prompts] = await Promise.all([
      this.listOptional('tools/list', 'tools'),
      this.listOptional('resources/list', 'resources'),
      this.listOptional('prompts/list', 'prompts'),
    ]);
    const items: McpCatalogItemV2[] = [];
    for (const raw of tools) {
      const tool = raw as McpToolDescriptor;
      const name = boundedText(tool.name, 256);
      if (!name) continue;
      const { destructive, sideEffecting } = classifyTool(tool);
      items.push({
        kind: 'tool',
        id: name,
        name,
        description: boundedText(tool.description, 4_096),
        destructive,
        sideEffecting,
        inputSchema: tool.inputSchema,
      });
    }
    for (const raw of resources) {
      const resource = raw as { name?: string; uri?: string; description?: string };
      const name = boundedText(resource.name, 256);
      const uri = boundedText(resource.uri, 4_096);
      if (!name || !uri) continue;
      items.push({ kind: 'resource', id: uri, name, description: boundedText(resource.description, 4_096), uri });
    }
    for (const raw of prompts) {
      const prompt = raw as { name?: string; description?: string; arguments?: Array<{ name?: string }> };
      const name = boundedText(prompt.name, 256);
      if (!name) continue;
      const argumentNames = Array.isArray(prompt.arguments)
        ? prompt.arguments
            .map((argument) => boundedText(argument.name, 256))
            .filter((value): value is string => value !== undefined)
            .slice(0, 128)
        : [];
      items.push({ kind: 'prompt', id: name, name, description: boundedText(prompt.description, 4_096), argumentNames });
    }
    return items;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Pick<McpToolInvocationResultV2, 'status' | 'output' | 'safeSummary'>> {
    if (!this.initialized) await this.connect();
    let result: unknown;
    try {
      result = await this.transport.request(
        'tools/call',
        this.eraParams({ name: toolName, arguments: args }),
        this.timeouts.invokeMs,
      );
    } catch (error) {
      if (error instanceof McpTransportError) {
        return { status: 'failed', safeSummary: `MCP tool invocation ${error.code}: ${error.message.slice(0, 512)}` };
      }
      throw error;
    }
    const serialized = JSON.stringify(result ?? null);
    if (Buffer.byteLength(serialized, 'utf8') > MCP_MAX_INVOKE_RESULT_BYTES) {
      return { status: 'failed', safeSummary: 'MCP tool result exceeded the maximum allowed size' };
    }
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
    if (record?.isError === true) {
      return { status: 'failed', safeSummary: 'MCP server reported the tool call as an error', output: record.content };
    }
    return { status: 'completed', output: record?.content ?? result };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  get crashSignal(): Promise<void> {
    return this.transport.crashSignal;
  }
}
