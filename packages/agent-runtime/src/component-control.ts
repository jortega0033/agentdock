import { readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): UnknownRecord | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;

export interface ProviderComponentControlPlane {
  list(
    input: ProviderComponentListRequestV2,
    context: McpControlContext,
  ): Promise<ProviderComponentListV2>;
  manage(
    input: ProviderComponentManageRequestV2,
    context: McpControlContext,
  ): Promise<ProviderComponentOperationResultV2>;
  invoke(
    input: ProviderComponentInvokeRequestV2,
    context: McpControlContext,
  ): Promise<ProviderComponentOperationResultV2>;
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
    {
      scope: 'project',
      kind: 'skill',
      directory: join(cwd, providerDir, 'skills'),
      marker: `${providerDir}/skills`,
      fileName: 'SKILL.md',
    },
    {
      scope: 'project',
      kind: 'plugin',
      directory: join(cwd, providerDir, 'plugins'),
      marker: `${providerDir}/plugins`,
    },
    {
      scope: 'user',
      kind: 'skill',
      directory: join(home, providerDir, 'skills'),
      marker: `~/${providerDir}/skills`,
      fileName: 'SKILL.md',
    },
    {
      scope: 'user',
      kind: 'plugin',
      directory: join(home, providerDir, 'plugins'),
      marker: `~/${providerDir}/plugins`,
    },
  ];
  if (provider === 'claude') {
    entries.push(
      {
        scope: 'project',
        kind: 'command',
        directory: join(cwd, '.claude', 'commands'),
        marker: '.claude/commands',
      },
      {
        scope: 'project',
        kind: 'agent',
        directory: join(cwd, '.claude', 'agents'),
        marker: '.claude/agents',
      },
      {
        scope: 'user',
        kind: 'command',
        directory: join(home, '.claude', 'commands'),
        marker: '~/.claude/commands',
      },
      {
        scope: 'user',
        kind: 'agent',
        directory: join(home, '.claude', 'agents'),
        marker: '~/.claude/agents',
      },
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
    const [canonicalRoot, canonicalCandidate] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ]);
    const suffix = relative(canonicalRoot, canonicalCandidate);
    return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..');
  } catch {
    return false;
  }
}

async function scanRoot(
  provider: ProviderId,
  root: DiscoveryRoot,
  trusted: boolean,
): Promise<ProviderComponentDescriptorV2[]> {
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
          try {
            contents = await readFile(join(candidate, manifest), 'utf8');
            break;
          } catch {
            /* bounded fallback */
          }
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
      dependencies: metadata.dependencies
        ? metadata.dependencies
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 256)
        : [],
      // The filesystem layout can declare provider-native invocation support, but this
      // inspector has no provider invocation transport. Keep the declaration visible
      // without advertising an operation that will always fail.
      capabilities: explicitInvoke ? ['manifest_direct_invoke'] : [],
      supportsDirectInvoke: false,
      supportsManage: false,
      manifestPreview: preview(contents),
    });
  }
  return items;
}

/**
 * Disabling a hook means Claude Code must genuinely stop reading it -- the only way to make that
 * true is to remove its entry from the exact file Claude reads. This ledger (a small sibling file
 * next to `settings.json`, never inside it) is where that removed entry is kept so `enable` can
 * restore the identical value later; it is not itself read by Claude, only by this handler.
 */
function hookLedgerPath(settingsPath: string): string {
  return `${settingsPath}.agent-dock-disabled-hooks.json`;
}

async function readHookLedger(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    const contents = await readFile(hookLedgerPath(settingsPath), 'utf8');
    if (Buffer.byteLength(contents, 'utf8') > 1_000_000) return {};
    const parsed: unknown = JSON.parse(contents);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function hookDescriptor(
  scope: 'project' | 'user',
  settingsDisplayPath: string,
  lifecycle: string,
  value: unknown,
  trusted: boolean,
  enabled: boolean,
): ProviderComponentDescriptorV2 {
  return {
    // Percent-encoded so the id round-trips losslessly through parseHookComponentId() -- unlike
    // a character-replacing sanitizer, this never collides two different lifecycle names into the
    // same id and never leaves the parsed lifecycle unable to match the real settings.json key.
    id: `${scope}/hook/${encodeURIComponent(lifecycle.slice(0, 128))}`,
    provider: 'claude',
    kind: 'hook',
    name: lifecycle.slice(0, 256),
    scope,
    source: 'filesystem',
    displayPath: settingsDisplayPath,
    enabled: enabled && (scope === 'user' || trusted),
    trusted: scope === 'user' || trusted,
    dependencies: [],
    capabilities: ['observe'],
    supportsDirectInvoke: false,
    // A real handler exists for this exact (provider, kind, source) combination -- see
    // manageClaudeHook() below -- so this is genuinely capability-driven, not a blanket default:
    // it is false for every other component kind because no handler is registered.
    supportsManage: true,
    manifestPreview: {
      hooks: Array.isArray(value) ? Math.min(value.length, 10_000) : 1,
      mcpServers: 0,
      executables: JSON.stringify(value).includes('command') ? 1 : 0,
      environmentVariables: JSON.stringify(value).includes('env') ? 1 : 0,
      skills: 0,
      agents: 0,
    },
  };
}

async function scanClaudeHooks(
  path: string,
  scope: 'project' | 'user',
  trusted: boolean,
): Promise<ProviderComponentDescriptorV2[]> {
  const displayPath = scope === 'project' ? '.claude/settings.json' : '~/.claude/settings.json';
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    contents = '';
  }
  if (Buffer.byteLength(contents, 'utf8') > 1_000_000) return [];
  let liveHooks: Record<string, unknown> = {};
  if (contents) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return [
        {
          id: `${scope}/hook/settings`,
          provider: 'claude',
          kind: 'hook',
          name: 'Hooks settings',
          scope,
          source: 'filesystem',
          displayPath,
          enabled: false,
          trusted: scope === 'user' || trusted,
          dependencies: [],
          capabilities: [],
          supportsDirectInvoke: false,
          supportsManage: false,
          loadError: { code: 'manifest_invalid', summary: 'Hook settings could not be parsed' },
          manifestPreview: {
            hooks: 0,
            mcpServers: 0,
            executables: 0,
            environmentVariables: 0,
            skills: 0,
            agents: 0,
          },
        },
      ];
    }
    const hooks =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).hooks
        : undefined;
    if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
      liveHooks = hooks as Record<string, unknown>;
    }
  }
  const ledger = await readHookLedger(path);
  const items: ProviderComponentDescriptorV2[] = [];
  // Keyed by lifecycle name, not array position: `hooks` is a JSON object, so each key is
  // already unique -- a positional index would silently drift to a different lifecycle the next
  // time this file is scanned with a different key order or a key added/removed elsewhere, which
  // matters once this id becomes the target of a real mutation (see manageClaudeHook() below),
  // not just a display label.
  for (const [lifecycle, value] of Object.entries(liveHooks).slice(0, 256)) {
    items.push(hookDescriptor(scope, displayPath, lifecycle, value, trusted, true));
  }
  // A hook this handler previously disabled (removed from the live file, kept in the ledger) must
  // still be discoverable -- as a real, currently-inactive component the user can re-enable --
  // not silently vanish once it's no longer in the file Claude reads.
  for (const [lifecycle, value] of Object.entries(ledger).slice(0, 256)) {
    if (lifecycle in liveHooks) continue;
    items.push(hookDescriptor(scope, displayPath, lifecycle, value, trusted, false));
  }
  return items;
}

async function writeHookLedger(settingsPath: string, ledger: Record<string, unknown>): Promise<void> {
  const path = hookLedgerPath(settingsPath);
  if (Object.keys(ledger).length === 0) {
    await rm(path, { force: true });
    return;
  }
  await writeFile(path, JSON.stringify(ledger, null, 2), 'utf8');
}

interface ParsedHookComponentId {
  scope: 'project' | 'user';
  lifecycle: string;
}

function parseHookComponentId(componentId: string): ParsedHookComponentId | undefined {
  const match = /^(project|user)\/hook\/(.+)$/.exec(componentId);
  if (!match) return undefined;
  try {
    return { scope: match[1] as 'project' | 'user', lifecycle: decodeURIComponent(match[2]!) };
  } catch {
    return undefined;
  }
}

/**
 * The one real, provider-native component operation in this slice: enabling/disabling a Claude
 * Code hook lifecycle by moving its entry between `settings.json`'s live `hooks` object and a
 * sibling ledger file (see `hookLedgerPath`). This has a real, verifiable effect -- Claude Code
 * genuinely stops (or resumes) reading that lifecycle -- and is fully reversible; it never
 * executes anything, matching issue #55's non-goal against prompt-based or executable invocation.
 */
async function manageClaudeHook(
  cwd: string,
  componentId: string,
  parsed: ParsedHookComponentId,
  action: 'enable' | 'disable',
): Promise<ProviderComponentOperationResultV2> {
  // Echo back the exact id the caller passed in -- not a value rebuilt from parsed.lifecycle,
  // which is percent-decoded and would silently diverge from the encoded id every descriptor
  // actually advertises (see hookDescriptor()) whenever the lifecycle needed encoding at all.
  const settingsPath =
    parsed.scope === 'project'
      ? join(cwd, '.claude', 'settings.json')
      : join(homedir(), '.claude', 'settings.json');
  let raw: UnknownRecord = {};
  try {
    const contents = await readFile(settingsPath, 'utf8');
    if (Buffer.byteLength(contents, 'utf8') > 1_000_000) {
      return { componentId, status: 'unsupported', safeSummary: 'Hook settings file is too large to manage' };
    }
    const parsedJson = JSON.parse(contents) as unknown;
    if (record(parsedJson)) raw = record(parsedJson)!;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return { componentId, status: 'unsupported', safeSummary: 'Hook settings could not be read' };
    }
  }
  const liveHooks = record(raw.hooks) ?? {};
  const ledger = await readHookLedger(settingsPath);

  if (action === 'disable') {
    if (!(parsed.lifecycle in liveHooks)) {
      return { componentId, status: 'unsupported', safeSummary: 'Hook lifecycle is not currently active' };
    }
    ledger[parsed.lifecycle] = liveHooks[parsed.lifecycle];
    const nextHooks = { ...liveHooks };
    delete nextHooks[parsed.lifecycle];
    // Ledger written before the live file: if the process dies between these two writes, the
    // lifecycle is still live AND already in the ledger. scanClaudeHooks() always prefers a live
    // entry over a ledger one, so that partial state is indistinguishable from "not yet disabled"
    // -- safe to retry, no data loss. The reverse order could instead remove the only copy from
    // the live file before it's durably saved anywhere else.
    await writeHookLedger(settingsPath, ledger);
    await writeFile(settingsPath, JSON.stringify({ ...raw, hooks: nextHooks }, null, 2), 'utf8');
    return { componentId, status: 'disabled' };
  }

  if (!(parsed.lifecycle in ledger)) {
    return { componentId, status: 'unsupported', safeSummary: 'No disabled hook found to re-enable' };
  }
  const nextHooks = { ...liveHooks, [parsed.lifecycle]: ledger[parsed.lifecycle] };
  const nextLedger = { ...ledger };
  delete nextLedger[parsed.lifecycle];
  // Live file written before the ledger cleanup: the same reasoning as disable() above, mirrored
  // -- a crash between these two writes leaves the lifecycle live AND still in the ledger, which
  // scanClaudeHooks() again resolves in favor of the live copy. Never the reverse order, which
  // would risk clearing the only copy from the ledger before the restore is durably saved.
  await writeFile(settingsPath, JSON.stringify({ ...raw, hooks: nextHooks }, null, 2), 'utf8');
  await writeHookLedger(settingsPath, nextLedger);
  return { componentId, status: 'enabled' };
}

function revision(items: readonly ProviderComponentDescriptorV2[]): string {
  let hash = 0;
  for (const character of JSON.stringify(items))
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return `components-${hash.toString(16).padStart(8, '0')}`;
}

/** Read-only supported-layout inspector. It never executes content while discovering it. */
export class FilesystemProviderComponentControlPlane implements ProviderComponentControlPlane {
  constructor(private readonly provider: ProviderId) {}

  async list(
    input: ProviderComponentListRequestV2,
    context: McpControlContext,
  ): Promise<ProviderComponentListV2> {
    const trusted = context.workspaceTrust.state === 'trusted';
    const discovered = (
      await Promise.all(
        roots(this.provider, context.cwd).map((root) => scanRoot(this.provider, root, trusted)),
      )
    ).flat();
    if (this.provider === 'claude') {
      discovered.push(
        ...(await scanClaudeHooks(
          join(context.cwd, '.claude', 'settings.json'),
          'project',
          trusted,
        )),
      );
      discovered.push(
        ...(await scanClaudeHooks(join(homedir(), '.claude', 'settings.json'), 'user', trusted)),
      );
    }
    const items = input.kind ? discovered.filter((item) => item.kind === input.kind) : discovered;
    return { items, revision: revision(items) };
  }

  async manage(
    input: ProviderComponentManageRequestV2,
    context: McpControlContext,
  ): Promise<ProviderComponentOperationResultV2> {
    if (context.workspaceTrust.state !== 'trusted')
      return {
        componentId: input.componentId,
        status: 'blocked',
        safeSummary: 'Components cannot be managed before workspace trust',
      };
    // The one real, registered handler in this slice: Claude hook lifecycles. Every other
    // component (skills/plugins/commands/agents, any provider, any non-filesystem source) has no
    // handler at all -- `list()` already reports `supportsManage: false` for all of them, and this
    // is the same check enforced again here so `manage()` can never be reached for one even by a
    // caller that skipped the descriptor check.
    const parsedId = this.provider === 'claude' ? parseHookComponentId(input.componentId) : undefined;
    if (!parsedId) {
      return {
        componentId: input.componentId,
        status: 'unsupported',
        safeSummary: 'This provider does not advertise an explicit component management API',
      };
    }
    return manageClaudeHook(context.cwd, input.componentId, parsedId, input.action);
  }

  async invoke(
    input: ProviderComponentInvokeRequestV2,
    context: McpControlContext,
  ): Promise<ProviderComponentOperationResultV2> {
    if (context.workspaceTrust.state !== 'trusted')
      return {
        componentId: input.componentId,
        status: 'blocked',
        safeSummary: 'Project components cannot execute before workspace trust',
      };
    throw new ProviderControlError(
      'operation_unsupported',
      'Direct component invocation requires a provider-native manifest operation',
    );
  }
}
