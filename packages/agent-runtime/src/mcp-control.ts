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
import type { WorkspaceTrustEvidence } from './types.js';

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
      tools: false,
      resources: false,
      prompts: false,
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

  constructor(private readonly options: ProviderCliMcpControlPlaneOptions) {
    this.run = options.run ?? ((command, args, runOptions) => execCapture(command, args, { cwd: runOptions.cwd, timeoutMs: 15_000 }));
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
    if (input.action !== 'reload') throw new ProviderControlError('operation_unsupported', `${input.action} is not supported by this provider CLI`);
    return this.list(context);
  }

  async catalog(serverId: string, context: McpControlContext): Promise<McpCatalogV2> {
    const list = await this.list(context);
    if (!list.servers.some((server) => server.id === serverId)) throw new ProviderControlError('mcp_server_not_found', 'MCP server was not found');
    return { serverId, items: [], revision: list.revision };
  }

  async startOAuth(serverId: string): Promise<McpOAuthStatusV2> {
    return { serverId, status: 'unsupported', safeSummary: this.options.provider === 'claude' ? 'Claude Agent SDK MCP OAuth requires a host token and is not supported' : 'Provider-owned browser OAuth is unavailable through this transport' };
  }

  async invoke(input: McpToolInvocationRequestV2): Promise<McpToolInvocationResultV2> {
    return { serverId: input.serverId, toolId: input.toolId, status: 'failed', safeSummary: 'Direct MCP tool invocation is not supported by this provider transport' };
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
