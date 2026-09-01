import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type {
  ProviderComponentDescriptorV2,
  ProviderComponentInvokeRequestV2,
  ProviderComponentListRequestV2,
  ProviderComponentListV2,
  ProviderComponentManageRequestV2,
  ProviderComponentOperationResultV2,
  ProviderId,
} from '@agent-dock/shared';
import type { McpControlContext } from './mcp-control.js';
import { ProviderControlError } from './mcp-control.js';

export interface ProviderComponentControlPlane {
  list(input: ProviderComponentListRequestV2, context: McpControlContext): Promise<ProviderComponentListV2>;
  manage(input: ProviderComponentManageRequestV2, context: McpControlContext): Promise<ProviderComponentOperationResultV2>;
  invoke(input: ProviderComponentInvokeRequestV2, context: McpControlContext): Promise<ProviderComponentOperationResultV2>;
}

interface DiscoveryRoot {
  scope: ProviderComponentDescriptorV2['scope'];
  kind: ProviderComponentDescriptorV2['kind'];
  directory: string;
  marker: string;
  fileName?: string;
}

function roots(provider: ProviderId, cwd: string): DiscoveryRoot[] {
  const providerDir = provider === 'claude' ? '.claude' : '.codex';
  const home = homedir();
  const entries: DiscoveryRoot[] = [
    { scope: 'project', kind: 'skill', directory: join(cwd, providerDir, 'skills'), marker: `${providerDir}/skills`, fileName: 'SKILL.md' },
    { scope: 'project', kind: 'plugin', directory: join(cwd, providerDir, 'plugins'), marker: `${providerDir}/plugins` },
    { scope: 'user', kind: 'skill', directory: join(home, providerDir, 'skills'), marker: `~/${providerDir}/skills`, fileName: 'SKILL.md' },
    { scope: 'user', kind: 'plugin', directory: join(home, providerDir, 'plugins'), marker: `~/${providerDir}/plugins` },
  ];
  if (provider === 'claude') {
    entries.push(
      { scope: 'project', kind: 'command', directory: join(cwd, '.claude', 'commands'), marker: '.claude/commands' },
      { scope: 'project', kind: 'agent', directory: join(cwd, '.claude', 'agents'), marker: '.claude/agents' },
      { scope: 'user', kind: 'command', directory: join(home, '.claude', 'commands'), marker: '~/.claude/commands' },
      { scope: 'user', kind: 'agent', directory: join(home, '.claude', 'agents'), marker: '~/.claude/agents' },
    );
  }
  return entries;
}

function frontmatter(text: string): Record<string, string> {
  const prefix = text.slice(0, 16_384);
  if (!prefix.startsWith('---\n') && !prefix.startsWith('---\r\n')) return {};
  const end = prefix.indexOf('\n---', 4);
  if (end < 0) return {};
  const result: Record<string, string> = {};
  for (const line of prefix.slice(4, end).split(/\r?\n/).slice(0, 128)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]{0,63}):\s*(.{0,4096})$/.exec(line);
    if (match) result[match[1]!.toLowerCase()] = match[2]!.replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function preview(text: string): ProviderComponentDescriptorV2['manifestPreview'] {
  const source = text.slice(0, 64 * 1024);
  const count = (pattern: RegExp) => Math.min(10_000, source.match(pattern)?.length ?? 0);
  return {
    hooks: count(/\bhooks?\b/gi),
    mcpServers: count(/\bmcpServers?\b/gi),
    executables: count(/\b(command|executable|binary)\b/gi),
    environmentVariables: count(/\b(env|environment)\b/gi),
    skills: count(/\bskills?\b/gi),
    agents: count(/\bagents?\b/gi),
  };
}

async function within(root: string, candidate: string): Promise<boolean> {
  try {
    const [canonicalRoot, canonicalCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    const suffix = relative(canonicalRoot, canonicalCandidate);
    return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..');
  } catch {
    return false;
  }
}

async function scanRoot(provider: ProviderId, root: DiscoveryRoot, trusted: boolean): Promise<ProviderComponentDescriptorV2[]> {
  let entries;
  try {
    entries = await readdir(root.directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const items: ProviderComponentDescriptorV2[] = [];
  for (const entry of entries.slice(0, 2_000)) {
    if (!/^[A-Za-z0-9._-]{1,256}$/.test(entry.name)) continue;
    const candidate = root.fileName
      ? join(root.directory, entry.name, root.fileName)
      : join(root.directory, entry.name);
    if (!(await within(root.directory, candidate))) continue;
    let contents = '';
    try {
      if (entry.isDirectory() && !root.fileName) {
        for (const manifest of ['plugin.json', 'manifest.json', 'README.md']) {
          try { contents = await readFile(join(candidate, manifest), 'utf8'); break; } catch { /* bounded fallback */ }
        }
      } else {
        contents = await readFile(candidate, 'utf8');
      }
    } catch {
      continue;
    }
    if (Buffer.byteLength(contents, 'utf8') > 1_000_000) continue;
    const metadata = frontmatter(contents);
    const name = (metadata.name || entry.name.replace(/\.md$/i, '')).slice(0, 256);
    const explicitInvoke = metadata['user-invocable'] === 'true';
    items.push({
      id: `${root.scope}/${root.kind}/${entry.name}`,
      provider,
      kind: root.kind,
      name,
      ...(metadata.description ? { description: metadata.description.slice(0, 4_096) } : {}),
      scope: root.scope,
      source: 'filesystem',
      displayPath: `${root.marker}/${entry.name}${root.fileName ? `/${root.fileName}` : ''}`,
      enabled: root.scope === 'user' || trusted,
      trusted: root.scope === 'user' || trusted,
      dependencies: metadata.dependencies ? metadata.dependencies.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 256) : [],
      capabilities: explicitInvoke ? ['direct_invoke'] : [],
      supportsDirectInvoke: explicitInvoke,
      supportsManage: false,
      manifestPreview: preview(contents),
    });
  }
  return items;
}

async function scanClaudeHooks(path: string, scope: 'project' | 'user', trusted: boolean): Promise<ProviderComponentDescriptorV2[]> {
  let contents: string;
  try { contents = await readFile(path, 'utf8'); } catch { return []; }
  if (Buffer.byteLength(contents, 'utf8') > 1_000_000) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(contents); } catch {
    return [{ id: `${scope}/hook/settings`, provider: 'claude', kind: 'hook', name: 'Hooks settings', scope, source: 'filesystem', displayPath: scope === 'project' ? '.claude/settings.json' : '~/.claude/settings.json', enabled: false, trusted: scope === 'user' || trusted, dependencies: [], capabilities: [], supportsDirectInvoke: false, supportsManage: false, loadError: { code: 'manifest_invalid', summary: 'Hook settings could not be parsed' }, manifestPreview: { hooks: 0, mcpServers: 0, executables: 0, environmentVariables: 0, skills: 0, agents: 0 } }];
  }
  const hooks = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).hooks : undefined;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  return Object.entries(hooks as Record<string, unknown>).slice(0, 256).map(([lifecycle, value], index) => ({
    id: `${scope}/hook/${lifecycle.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)}:${index}`,
    provider: 'claude' as const,
    kind: 'hook' as const,
    name: lifecycle.slice(0, 256),
    scope,
    source: 'filesystem' as const,
    displayPath: scope === 'project' ? '.claude/settings.json' : '~/.claude/settings.json',
    enabled: scope === 'user' || trusted,
    trusted: scope === 'user' || trusted,
    dependencies: [], capabilities: ['observe'], supportsDirectInvoke: false, supportsManage: false,
    manifestPreview: { hooks: Array.isArray(value) ? Math.min(value.length, 10_000) : 1, mcpServers: 0, executables: JSON.stringify(value).includes('command') ? 1 : 0, environmentVariables: JSON.stringify(value).includes('env') ? 1 : 0, skills: 0, agents: 0 },
  }));
}

function revision(items: readonly ProviderComponentDescriptorV2[]): string {
  let hash = 0;
  for (const character of JSON.stringify(items)) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return `components-${hash.toString(16).padStart(8, '0')}`;
}

/** Read-only supported-layout inspector. It never executes content while discovering it. */
export class FilesystemProviderComponentControlPlane implements ProviderComponentControlPlane {
  constructor(private readonly provider: ProviderId) {}

  async list(input: ProviderComponentListRequestV2, context: McpControlContext): Promise<ProviderComponentListV2> {
    const trusted = context.workspaceTrust.state === 'trusted';
    const discovered = (await Promise.all(roots(this.provider, context.cwd).map((root) => scanRoot(this.provider, root, trusted)))).flat();
    if (this.provider === 'claude') {
      discovered.push(...await scanClaudeHooks(join(context.cwd, '.claude', 'settings.json'), 'project', trusted));
      discovered.push(...await scanClaudeHooks(join(homedir(), '.claude', 'settings.json'), 'user', trusted));
    }
    const items = input.kind ? discovered.filter((item) => item.kind === input.kind) : discovered;
    return { items, revision: revision(items) };
  }

  async manage(input: ProviderComponentManageRequestV2, context: McpControlContext): Promise<ProviderComponentOperationResultV2> {
    if (context.workspaceTrust.state !== 'trusted') return { componentId: input.componentId, status: 'blocked', safeSummary: 'Project components cannot be enabled before workspace trust' };
    return { componentId: input.componentId, status: 'unsupported', safeSummary: 'This provider does not advertise an explicit component management API' };
  }

  async invoke(input: ProviderComponentInvokeRequestV2, context: McpControlContext): Promise<ProviderComponentOperationResultV2> {
    if (context.workspaceTrust.state !== 'trusted') return { componentId: input.componentId, status: 'blocked', safeSummary: 'Project components cannot execute before workspace trust' };
    throw new ProviderControlError('operation_unsupported', 'Direct component invocation requires a provider-native manifest operation');
  }
}
