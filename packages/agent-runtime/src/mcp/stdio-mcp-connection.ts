import type { McpCatalogItemV2, McpToolInvocationResultV2 } from '@agent-dock/shared';
import { McpTransportError, StdioJsonRpcTransport } from './stdio-jsonrpc-transport.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
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

  constructor(spawnConfig: McpSpawnConfig, cwd: string, timeouts: StdioMcpConnectionTimeouts = {}) {
    this.timeouts = {
      connectMs: timeouts.connectMs ?? MCP_CONNECT_TIMEOUT_MS,
      listMs: timeouts.listMs ?? MCP_LIST_TIMEOUT_MS,
      invokeMs: timeouts.invokeMs ?? MCP_INVOKE_TIMEOUT_MS,
    };
    this.transport = new StdioJsonRpcTransport(spawnConfig.command, spawnConfig.args, {
      cwd,
      env: spawnConfig.env ? { ...process.env, ...spawnConfig.env } : undefined,
    });
  }

  get pid(): number | undefined {
    return this.transport.pid;
  }

  async connect(): Promise<void> {
    if (this.initialized) return;
    await this.transport.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'agent-dock', version: '1' },
      },
      this.timeouts.connectMs,
    );
    this.transport.notify('notifications/initialized');
    this.initialized = true;
  }

  private async listOptional(method: string, resultKey: string): Promise<unknown[]> {
    try {
      const result = (await this.transport.request(method, {}, this.timeouts.listMs)) as
        | Record<string, unknown>
        | undefined;
      const items = result?.[resultKey];
      return Array.isArray(items) ? items.slice(0, MCP_MAX_CATALOG_ITEMS_PER_KIND) : [];
    } catch (error) {
      // A server that never implements an optional listing method reports "method not found";
      // this connection has none of that kind, which is a legitimate empty result, not a failure.
      if (error instanceof McpTransportError && error.code === 'protocol_error') return [];
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
      result = await this.transport.request('tools/call', { name: toolName, arguments: args }, this.timeouts.invokeMs);
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
