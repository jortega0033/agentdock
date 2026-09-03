import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  McpCatalogV2,
  McpConfigureRequestV2,
  McpOAuthStatusV2,
  McpServerActionRequestV2,
  McpServerDescriptorV2,
  McpServerListV2,
  McpToolInvocationRequestV2,
  McpToolInvocationResultV2,
  ProviderId,
} from '@agent-dock/shared';
import { execCapture, type ExecResult } from './process/exec-capture.js';
import { buildLegacyProviderEnvironment } from './process/provider-environment.js';
import type { WorkspaceTrustEvidence } from './types.js';
import { StdioConnectionManager } from './mcp/stdio-connection-manager.js';
import type { McpSpawnConfig } from './mcp/stdio-mcp-connection.js';

export { StdioConnectionManager } from './mcp/stdio-connection-manager.js';
export type { McpSpawnConfig } from './mcp/stdio-mcp-connection.js';
export { McpTransportError } from './mcp/stdio-jsonrpc-transport.js';

/**
 * One shared pool for the daemon's whole process lifetime, reused by every
 * `ProviderCliMcpControlPlane` instance that doesn't get its own injected for testing (see
 * `ProviderCliMcpControlPlaneOptions.stdioConnections`). A module-level singleton, not a
 * constructor parameter threaded through `ClaudeProvider`/`CodexProvider`, because both adapters
 * are constructed with only a logger today and every real MCP server connection this pool ever
 * owns must still be reachable from one place for daemon shutdown (`closeAllMcpConnections`)
 * regardless of which adapter's plane happened to open it.
 */
const sharedStdioConnections = new StdioConnectionManager();

/** Reaps every live MCP server process this daemon process ever opened. Call on daemon shutdown. */
export function closeAllMcpConnections(): Promise<void> {
  return sharedStdioConnections.closeAll();
}

export interface McpControlContext {
  cwd: string;
  workspaceTrust: WorkspaceTrustEvidence;
  executablePath?: string;
}

export class ProviderControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ProviderControlError';
  }
}

export interface ProviderMcpControlPlane {
  list(context: McpControlContext): Promise<McpServerListV2>;
  configure(input: McpConfigureRequestV2, context: McpControlContext): Promise<McpServerListV2>;
  act(input: McpServerActionRequestV2, context: McpControlContext): Promise<McpServerListV2>;
  catalog(serverId: string, context: McpControlContext): Promise<McpCatalogV2>;
  startOAuth(serverId: string, context: McpControlContext): Promise<McpOAuthStatusV2>;
  invoke(input: McpToolInvocationRequestV2, context: McpControlContext): Promise<McpToolInvocationResultV2>;
}

export interface ProviderCliMcpControlPlaneOptions {
  provider: ProviderId;
  executableName: string;
  run?: (command: string, args: string[], options: { cwd: string }) => Promise<ExecResult>;
  /** Injectable for tests; defaults to the module-level `sharedStdioConnections` pool. */
  stdioConnections?: StdioConnectionManager;
}

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): UnknownRecord | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 4_096 ? value : undefined;
const texts = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length <= 128 && value.every((item) => typeof item === 'string' && item.length <= 1_024)
    ? value
    : undefined;

function baseDescriptor(
  provider: ProviderId,
  name: string,
  scope: McpServerDescriptorV2['scope'],
  transport: McpServerDescriptorV2['transport'],
  enabled: boolean,
  fields: McpServerDescriptorV2['configFields'],
): McpServerDescriptorV2 {
  return {
    id: name,
    provider,
    name,
    ownership: scope === 'project' || scope === 'local' ? 'project' : 'provider',
    scope,
    transport,
    enabled,
    required: false,
    connectionStatus: enabled ? 'unknown' : 'disabled',
    authStatus: 'unknown',
    catalog: { tools: 0, resources: 0, prompts: 0 },
    capabilities: {
      connect: false,
      reload: true,
      configure: transport !== 'legacy_sse_read_only',
      oauth: provider === 'codex' && transport === 'streamable_http',
      // Only an enabled stdio server actually connects and lists a real catalog today (issue
      // #56); HTTP/SSE transports remain explicitly unadvertised here regardless of `enabled`.
      tools: transport === 'stdio' && enabled,
      resources: transport === 'stdio' && enabled,
      prompts: transport === 'stdio' && enabled,
    },
    configFields: fields,
    sessionIds: [],
  };
}

function normalizedConfig(
  provider: ProviderId,
  name: string,
  raw: UnknownRecord,
  scope: McpServerDescriptorV2['scope'],
): McpServerDescriptorV2 {
  const transportRecord = record(raw.transport);
  const transportType = text(transportRecord?.type) ?? text(raw.type);
  const command = text(transportRecord?.command) ?? text(raw.command);
  const args = texts(transportRecord?.args) ?? texts(raw.args);
  const url = text(transportRecord?.url) ?? text(raw.url);
  const transport =
    transportType === 'sse'
      ? 'legacy_sse_read_only'
      : url || transportType === 'http' || transportType === 'streamable_http'
        ? 'streamable_http'
        : 'stdio';
  const fields: McpServerDescriptorV2['configFields'] = [];
  if (command) fields.push({ key: 'command', classification: 'public', present: true, source: scope === 'project' ? 'project' : 'provider', value: command });
  if (args) fields.push({ key: 'args', classification: 'public', present: true, source: scope === 'project' ? 'project' : 'provider', value: args });
  if (url) fields.push({ key: 'url', classification: 'unknown', present: true, source: scope === 'project' ? 'project' : 'provider' });
  for (const key of ['env', 'headers', 'bearer_token_env_var']) {
    if (raw[key] !== undefined || transportRecord?.[key] !== undefined) {
      fields.push({ key, classification: key === 'bearer_token_env_var' ? 'secret' : 'unknown', present: true, source: scope === 'project' ? 'project' : 'provider' });
    }
  }
  return { ...baseDescriptor(provider, name, scope, transport, raw.enabled !== false, fields), id: `${scope}:${name}` };
}

async function readClaudeConfig(path: string, scope: McpServerDescriptorV2['scope'], projectPath?: string): Promise<McpServerDescriptorV2[]> {
  let parsed: unknown;
  try {
    const contents = await readFile(path, 'utf8');
    if (Buffer.byteLength(contents, 'utf8') > 1_000_000) return [];
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }
  const root = record(parsed);
  const project = projectPath ? record(record(root?.projects)?.[projectPath]) : undefined;
  const servers = record((project ?? root)?.mcpServers);
  if (!servers || Object.keys(servers).length > 2_000) return [];
  return Object.entries(servers).flatMap(([name, value]) => {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(name)) return [];
    const config = record(value);
    return config ? [normalizedConfig('claude', name, config, scope)] : [];
  });
}

async function inspectClaudeProjectConfig(cwd: string): Promise<McpServerDescriptorV2[]> {
  const [project, user, local] = await Promise.all([
    readClaudeConfig(join(cwd, '.mcp.json'), 'project'),
    readClaudeConfig(join(homedir(), '.claude.json'), 'user'),
    readClaudeConfig(join(homedir(), '.claude.json'), 'local', cwd),
  ]);
  const unique = new Map<string, McpServerDescriptorV2>();
  for (const server of [...project, ...user, ...local]) unique.set(server.id, server);
  return [...unique.values()];
}

function parseCodexList(stdout: string): McpServerDescriptorV2[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ProviderControlError('provider_response_invalid', 'Codex returned invalid MCP configuration data');
  }
  if (!Array.isArray(parsed) || parsed.length > 2_000) {
    throw new ProviderControlError('provider_response_invalid', 'Codex returned an invalid MCP server list');
  }
  return parsed.flatMap((item) => {
    const value = record(item);
    const name = text(value?.name);
    if (!value || !name || !/^[A-Za-z0-9._:-]{1,256}$/.test(name)) return [];
    return [normalizedConfig('codex', name, value, 'user')];
  });
}

const MAX_ENV_VARS = 64;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Extracts a real, spawnable `{command, args, env}` from a raw (unredacted) config record --
 * never from `normalizedConfig()`'s output, which deliberately drops `env` values entirely (see
 * `mcpConfigFieldV2Schema`'s superRefine: only `command`/`args` may ever carry a public value).
 * This function is the one place this repo reads an MCP server's real environment variables, and
 * it never returns them to a caller outside this module.
 */
function rawStdioSpawnConfig(raw: UnknownRecord): McpSpawnConfig | undefined {
  const transportRecord = record(raw.transport);
  const command = text(transportRecord?.command) ?? text(raw.command);
  if (!command) return undefined;
  const args = texts(transportRecord?.args) ?? texts(raw.args) ?? [];
  const envRecord = record(transportRecord?.env) ?? record(raw.env);
  const env: Record<string, string> = {};
  if (envRecord) {
    for (const [key, value] of Object.entries(envRecord)) {
      if (Object.keys(env).length >= MAX_ENV_VARS) break;
      if (!ENV_KEY_PATTERN.test(key) || typeof value !== 'string' || value.length > 8_192) continue;
      env[key] = value;
    }
  }
  return { command, args, env };
}

/** Re-reads Claude's own config file for one exact `scope:name` server id -- the same files
 * `inspectClaudeProjectConfig` reads, but returning the real spawn config instead of a redacted
 * descriptor. */
async function resolveClaudeStdioSpawnConfig(
  serverId: string,
  cwd: string,
): Promise<McpSpawnConfig | undefined> {
  const [scope, ...nameParts] = serverId.split(':');
  const name = nameParts.join(':');
  if (!name) return undefined;
  const path =
    scope === 'project'
      ? join(cwd, '.mcp.json')
      : join(homedir(), '.claude.json');
  let parsed: unknown;
  try {
    const contents = await readFile(path, 'utf8');
    if (Buffer.byteLength(contents, 'utf8') > 1_000_000) return undefined;
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  const root = record(parsed);
  const project = scope === 'local' ? record(record(root?.projects)?.[cwd]) : undefined;
  const servers = record((project ?? root)?.mcpServers);
  const entry = record(servers?.[name]);
  return entry ? rawStdioSpawnConfig(entry) : undefined;
}

/** Reads one Codex MCP server's real spawn config via `codex mcp get <name> --json` --
 * `codex mcp list --json` (used by `parseCodexList`) never includes `env`. */
async function resolveCodexStdioSpawnConfig(
  serverId: string,
  run: NonNullable<ProviderCliMcpControlPlaneOptions['run']>,
  executable: string,
  cwd: string,
): Promise<McpSpawnConfig | undefined> {
  const [, ...nameParts] = serverId.split(':');
  const name = nameParts.join(':');
  if (!name) return undefined;
  const result = await run(executable, ['mcp', 'get', name, '--json'], { cwd });
  if (result.timedOut || result.code !== 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  const root = record(parsed);
  if (!root) return undefined;
  return rawStdioSpawnConfig(root);
}

function revisionOf(servers: readonly McpServerDescriptorV2[]): string {
  let hash = 2_166_136_261;
  const source = JSON.stringify(servers);
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `mcp-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Provider-owned CLI/config adapter. It never reads credential stores or accepts secret values. */
export class ProviderCliMcpControlPlane implements ProviderMcpControlPlane {
  private readonly run: NonNullable<ProviderCliMcpControlPlaneOptions['run']>;
  private readonly stdioConnections: StdioConnectionManager;

  constructor(private readonly options: ProviderCliMcpControlPlaneOptions) {
    // Sanitized by default (issue #53): a provider CLI control invocation never silently inherits
    // the daemon's full process.env.
    this.run =
      options.run ??
      ((command, args, runOptions) =>
        execCapture(command, args, {
          cwd: runOptions.cwd,
          timeoutMs: 15_000,
          env: buildLegacyProviderEnvironment(process.env, { provider: options.provider }),
        }));
    this.stdioConnections = options.stdioConnections ?? sharedStdioConnections;
  }

  /** Only enabled `stdio` servers are actually connectable in this slice (issue #56); HTTP and a
   * disabled entry keep returning the pre-existing empty/unsupported behavior below. */
  private connectableStdioServer(
    servers: readonly McpServerDescriptorV2[],
    serverId: string,
  ): McpServerDescriptorV2 | undefined {
    const server = servers.find((candidate) => candidate.id === serverId);
    if (!server) throw new ProviderControlError('mcp_server_not_found', 'MCP server was not found');
    return server.transport === 'stdio' && server.enabled ? server : undefined;
  }

  private async resolveSpawnConfig(
    serverId: string,
    context: McpControlContext,
  ): Promise<McpSpawnConfig | undefined> {
    return this.options.provider === 'claude'
      ? resolveClaudeStdioSpawnConfig(serverId, context.cwd)
      : resolveCodexStdioSpawnConfig(serverId, this.run, this.executable(context), context.cwd);
  }

  private executable(context: McpControlContext): string {
    return context.executablePath ?? this.options.executableName;
  }

  private async command(args: string[], context: McpControlContext): Promise<ExecResult> {
    const result = await this.run(this.executable(context), args, { cwd: context.cwd });
    if (result.timedOut) throw new ProviderControlError('provider_timeout', 'Provider MCP command timed out');
    if (result.code !== 0) throw new ProviderControlError('provider_command_failed', 'Provider rejected the MCP command');
    return result;
  }

  async list(context: McpControlContext): Promise<McpServerListV2> {
    const servers = this.options.provider === 'codex'
      ? parseCodexList((await this.command(['mcp', 'list', '--json'], context)).stdout)
      : await inspectClaudeProjectConfig(context.cwd);
    return { servers, revision: revisionOf(servers) };
  }

  async configure(input: McpConfigureRequestV2, context: McpControlContext): Promise<McpServerListV2> {
    if (context.workspaceTrust.state !== 'trusted') throw new ProviderControlError('workspace_untrusted', 'MCP configuration changes require a trusted workspace');
    if (input.action === 'enable' || input.action === 'disable' || input.action === 'edit') {
      throw new ProviderControlError('operation_unsupported', `${input.action} is not supported by this provider CLI`);
    }
    if (input.action === 'remove') {
      const current = (await this.list(context)).servers.find((server) => server.id === input.serverId);
      if (!current) throw new ProviderControlError('mcp_server_not_found', 'MCP server was not found');
      await this.command([
        'mcp', 'remove',
        ...(this.options.provider === 'claude' && current.scope !== 'unknown' && current.scope !== 'managed' ? ['--scope', current.scope] : []),
        current.name,
      ], context);
      return this.list(context);
    }
    if (input.action !== 'add') {
      throw new ProviderControlError('operation_unsupported', 'Unsupported MCP configuration action');
    }
    const scopeArgs = this.options.provider === 'claude' ? ['--scope', input.scope] : [];
    const args = input.config.transport === 'stdio'
      ? this.options.provider === 'claude'
        ? ['mcp', 'add', ...scopeArgs, '--transport', 'stdio', input.name, '--', input.config.command, ...input.config.args]
        : ['mcp', 'add', input.name, '--', input.config.command, ...input.config.args]
      : this.options.provider === 'claude'
        ? ['mcp', 'add', ...scopeArgs, '--transport', 'http', input.name, input.config.url]
        : ['mcp', 'add', input.name, '--url', input.config.url];
    await this.command(args, context);
    return this.list(context);
  }

  async act(input: McpServerActionRequestV2, context: McpControlContext): Promise<McpServerListV2> {
    if (input.action === 'disconnect') {
      await this.stdioConnections.closeFor(this.options.provider, input.serverId, context.cwd);
      return this.list(context);
    }
    if (input.action !== 'reload') throw new ProviderControlError('operation_unsupported', `${input.action} is not supported by this provider CLI`);
    // A reload can only mean "the config on disk changed" -- an already-open connection to the
    // old command/args/env must never silently keep serving stale state (issue #56: "Reap MCP
    // process trees on ... reload").
    await this.stdioConnections.closeFor(this.options.provider, input.serverId, context.cwd);
    return this.list(context);
  }

  async catalog(serverId: string, context: McpControlContext): Promise<McpCatalogV2> {
    if (context.workspaceTrust.state !== 'trusted') {
      throw new ProviderControlError('workspace_untrusted', 'MCP catalog access requires a trusted workspace');
    }
    const list = await this.list(context);
    const revision = revisionOf(list.servers);
    const server = this.connectableStdioServer(list.servers, serverId);
    if (!server) return { serverId, items: [], revision };
    const spawnConfig = await this.resolveSpawnConfig(serverId, context);
    if (!spawnConfig) return { serverId, items: [], revision };
    const items = await this.stdioConnections.getCatalog(this.options.provider, serverId, context.cwd, spawnConfig);
    return { serverId, items, revision };
  }

  async startOAuth(serverId: string): Promise<McpOAuthStatusV2> {
    return { serverId, status: 'unsupported', safeSummary: this.options.provider === 'claude' ? 'Claude Agent SDK MCP OAuth requires a host token and is not supported' : 'Provider-owned browser OAuth is unavailable through this transport' };
  }

  async invoke(input: McpToolInvocationRequestV2, context: McpControlContext): Promise<McpToolInvocationResultV2> {
    const unsupported: McpToolInvocationResultV2 = {
      serverId: input.serverId,
      toolId: input.toolId,
      status: 'failed',
      safeSummary: 'Direct MCP tool invocation is not supported by this provider transport',
    };
    if (context.workspaceTrust.state !== 'trusted') {
      throw new ProviderControlError('workspace_untrusted', 'MCP tool invocation requires a trusted workspace');
    }
    const list = await this.list(context);
    const server = this.connectableStdioServer(list.servers, input.serverId);
    if (!server) return unsupported;
    const spawnConfig = await this.resolveSpawnConfig(input.serverId, context);
    if (!spawnConfig) return unsupported;
    const result = await this.stdioConnections.invoke(
      this.options.provider,
      input.serverId,
      context.cwd,
      spawnConfig,
      input.toolId,
      input.arguments,
    );
    return { serverId: input.serverId, toolId: input.toolId, ...result };
  }
}

export interface InMemoryMcpFixture {
  servers: McpServerDescriptorV2[];
  catalogs?: McpCatalogV2[];
  oauth?: Record<string, McpOAuthStatusV2>;
  invoke?: (input: McpToolInvocationRequestV2) => Promise<McpToolInvocationResultV2>;
}

/** Deterministic fake control surface used by provider conformance and security route tests. */
export class InMemoryProviderMcpControlPlane implements ProviderMcpControlPlane {
  private servers: McpServerDescriptorV2[];
  private readonly catalogs = new Map<string, McpCatalogV2>();
  private revision = 1;

  constructor(private readonly provider: ProviderId, private readonly fixture: InMemoryMcpFixture) {
    this.servers = structuredClone(fixture.servers);
    for (const catalog of fixture.catalogs ?? []) this.catalogs.set(catalog.serverId, structuredClone(catalog));
  }

  private result(): McpServerListV2 {
    return { servers: structuredClone(this.servers), revision: `fixture-${this.revision}` };
  }

  async list(): Promise<McpServerListV2> {
    return this.result();
  }

  async configure(input: McpConfigureRequestV2, context: McpControlContext): Promise<McpServerListV2> {
    if (context.workspaceTrust.state !== 'trusted') throw new ProviderControlError('workspace_untrusted', 'MCP configuration changes require a trusted workspace');
    if (input.action === 'add') {
      if (this.servers.some((server) => server.id === input.name)) throw new ProviderControlError('mcp_server_exists', 'MCP server already exists');
      this.servers.push(baseDescriptor(this.provider, input.name, input.scope, input.config.transport, true, input.config.transport === 'stdio' ? [
        { key: 'command', classification: 'public', present: true, source: 'provider', value: input.config.command },
        { key: 'args', classification: 'public', present: true, source: 'provider', value: input.config.args },
      ] : [{ key: 'url', classification: 'unknown', present: true, source: 'provider' }]));
    } else {
      const index = this.servers.findIndex((server) => server.id === input.serverId);
      if (index < 0) throw new ProviderControlError('mcp_server_not_found', 'MCP server was not found');
      if (input.action === 'remove') this.servers.splice(index, 1);
      else if (input.action === 'enable' || input.action === 'disable') {
        this.servers[index] = { ...this.servers[index]!, enabled: input.action === 'enable', connectionStatus: input.action === 'enable' ? 'disconnected' : 'disabled' };
      } else if (input.action === 'edit') {
        if (this.servers[index]!.transport === 'legacy_sse_read_only') throw new ProviderControlError('operation_unsupported', 'Legacy SSE configuration is read-only');
        const current = this.servers[index]!;
        this.servers[index] = baseDescriptor(this.provider, input.name ?? current.name, current.scope, input.config.transport, current.enabled, input.config.transport === 'stdio' ? [
          { key: 'command', classification: 'public', present: true, source: 'provider', value: input.config.command },
          { key: 'args', classification: 'public', present: true, source: 'provider', value: input.config.args },
        ] : [{ key: 'url', classification: 'unknown', present: true, source: 'provider' }]);
      } else {
        throw new ProviderControlError('operation_unsupported', 'Unsupported MCP configuration action');
      }
    }
    this.revision += 1;
    return this.result();
  }

  async act(input: McpServerActionRequestV2): Promise<McpServerListV2> {
    const index = this.servers.findIndex((server) => server.id === input.serverId);
    if (index < 0) throw new ProviderControlError('mcp_server_not_found', 'MCP server was not found');
    const current = this.servers[index]!;
    this.servers[index] = { ...current, connectionStatus: input.action === 'disconnect' ? 'disconnected' : 'ready' };
    this.revision += 1;
    return this.result();
  }

  async catalog(serverId: string): Promise<McpCatalogV2> {
    if (!this.servers.some((server) => server.id === serverId)) throw new ProviderControlError('mcp_server_not_found', 'MCP server was not found');
    return structuredClone(this.catalogs.get(serverId) ?? { serverId, items: [], revision: `fixture-${this.revision}` });
  }

  async startOAuth(serverId: string): Promise<McpOAuthStatusV2> {
    if (!this.servers.some((server) => server.id === serverId)) throw new ProviderControlError('mcp_server_not_found', 'MCP server was not found');
    return structuredClone(this.fixture.oauth?.[serverId] ?? { serverId, status: 'unsupported' });
  }

  async invoke(input: McpToolInvocationRequestV2): Promise<McpToolInvocationResultV2> {
    return this.fixture.invoke?.(input) ?? { serverId: input.serverId, toolId: input.toolId, status: 'completed', output: { ok: true } };
  }
}
