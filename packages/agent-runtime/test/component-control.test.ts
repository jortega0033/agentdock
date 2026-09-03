import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesystemProviderComponentControlPlane } from '../src/component-control.js';
import type { McpControlContext } from '../src/mcp-control.js';

const TRUSTED: McpControlContext['workspaceTrust'] = {
  state: 'trusted',
  workspaceId: 'a'.repeat(64),
  incarnation: 'b'.repeat(64),
  trustEpoch: 0,
};
const UNTRUSTED: McpControlContext['workspaceTrust'] = { state: 'untrusted' };

describe('provider component inspection', () => {
  it('inspects bounded manifest metadata without executing untrusted project content', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-dock-components-'));
    const skill = join(cwd, '.claude', 'skills', 'review');
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: Review\ndescription: Safe review helper\nuser-invocable: true\n---\nHooks command env mcpServers',
    );
    const control = new FilesystemProviderComponentControlPlane('claude');
    const result = await control.list(
      { provider: 'claude', cwd, kind: 'skill' },
      { cwd, workspaceTrust: { state: 'untrusted' } },
    );
    const projectItem = result.items.find((item) => item.scope === 'project');
    expect(projectItem).toMatchObject({
      name: 'Review',
      enabled: false,
      trusted: false,
      supportsDirectInvoke: false,
      supportsManage: false,
      capabilities: ['manifest_direct_invoke'],
      displayPath: '.claude/skills/review/SKILL.md',
    });
    expect(projectItem?.manifestPreview).toMatchObject({
      hooks: 1,
      mcpServers: 1,
      executables: 1,
      environmentVariables: 1,
    });
  });

  it('never follows a symlink outside the discovery root (path/symlink safety)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-dock-components-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'agent-dock-components-outside-'));
    await writeFile(join(outside, 'SKILL.md'), '---\nname: Escaped\n---\nshould never be read');
    const skillsDir = join(cwd, '.claude', 'skills');
    await mkdir(skillsDir, { recursive: true });
    try {
      await symlink(outside, join(skillsDir, 'escape'), 'junction');
    } catch {
      return; // Symlink creation can require elevated privileges on some Windows configs; skip rather than fail spuriously.
    }
    const control = new FilesystemProviderComponentControlPlane('claude');
    const result = await control.list(
      { provider: 'claude', cwd, kind: 'skill' },
      { cwd, workspaceTrust: TRUSTED },
    );
    expect(result.items.some((item) => item.name === 'Escaped')).toBe(false);
  });

  it('supportsManage is true only for Claude hooks -- every other kind stays discovery-only', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-dock-components-caps-'));
    await mkdir(join(cwd, '.claude', 'skills', 'review'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: Review\n---\n');
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } }),
    );
    const control = new FilesystemProviderComponentControlPlane('claude');
    const result = await control.list({ provider: 'claude', cwd }, { cwd, workspaceTrust: TRUSTED });
    const skill = result.items.find((item) => item.kind === 'skill');
    const hook = result.items.find((item) => item.kind === 'hook');
    expect(skill?.supportsManage).toBe(false);
    expect(hook?.supportsManage).toBe(true);
    expect(hook?.supportsDirectInvoke).toBe(false);
  });

  it('never advertises management for a Codex component (no handler registered for that provider)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-dock-components-codex-'));
    await mkdir(join(cwd, '.codex', 'skills', 'review'), { recursive: true });
    await writeFile(join(cwd, '.codex', 'skills', 'review', 'SKILL.md'), '---\nname: Review\n---\n');
    const control = new FilesystemProviderComponentControlPlane('codex');
    const result = await control.list({ provider: 'codex', cwd }, { cwd, workspaceTrust: TRUSTED });
    expect(result.items.every((item) => !item.supportsManage)).toBe(true);
  });
});

describe('Claude hook management (the one real provider-native operation)', () => {
  async function settingsFixture(hooks: Record<string, unknown>): Promise<string> {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-dock-hooks-'));
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks }));
    return cwd;
  }

  it('disabling a hook removes it from the live settings file Claude actually reads', async () => {
    const cwd = await settingsFixture({ PreToolUse: [{ matcher: 'Bash' }] });
    const control = new FilesystemProviderComponentControlPlane('claude');
    const result = await control.manage(
      { provider: 'claude', cwd, componentId: 'project/hook/PreToolUse', action: 'disable' },
      { cwd, workspaceTrust: TRUSTED },
    );
    expect(result).toEqual({ componentId: 'project/hook/PreToolUse', status: 'disabled' });
    const settings = JSON.parse(await readFile(join(cwd, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse).toBeUndefined();
  });

  it('a disabled hook is still discoverable (as inactive), then re-enabling restores it byte for byte', async () => {
    const original = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }];
    const cwd = await settingsFixture({ PreToolUse: original });
    const control = new FilesystemProviderComponentControlPlane('claude');
    await control.manage(
      { provider: 'claude', cwd, componentId: 'project/hook/PreToolUse', action: 'disable' },
      { cwd, workspaceTrust: TRUSTED },
    );

    const afterDisable = await control.list({ provider: 'claude', cwd }, { cwd, workspaceTrust: TRUSTED });
    const disabledHook = afterDisable.items.find((item) => item.id === 'project/hook/PreToolUse');
    expect(disabledHook).toMatchObject({ enabled: false, supportsManage: true });

    const enableResult = await control.manage(
      { provider: 'claude', cwd, componentId: 'project/hook/PreToolUse', action: 'enable' },
      { cwd, workspaceTrust: TRUSTED },
    );
    expect(enableResult).toEqual({ componentId: 'project/hook/PreToolUse', status: 'enabled' });
    const settings = JSON.parse(await readFile(join(cwd, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse).toEqual(original);

    const afterEnable = await control.list({ provider: 'claude', cwd }, { cwd, workspaceTrust: TRUSTED });
    expect(afterEnable.items.find((item) => item.id === 'project/hook/PreToolUse')).toMatchObject({
      enabled: true,
    });
  });

  it('fails closed for an untrusted workspace before touching the settings file', async () => {
    const original = [{ matcher: 'Bash' }];
    const cwd = await settingsFixture({ PreToolUse: original });
    const control = new FilesystemProviderComponentControlPlane('claude');
    const result = await control.manage(
      { provider: 'claude', cwd, componentId: 'project/hook/PreToolUse', action: 'disable' },
      { cwd, workspaceTrust: UNTRUSTED },
    );
    expect(result.status).toBe('blocked');
    const settings = JSON.parse(await readFile(join(cwd, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse).toEqual(original);
  });

  it('rejects re-enabling a lifecycle that was never disabled (nothing in the ledger)', async () => {
    const cwd = await settingsFixture({ PreToolUse: [{ matcher: 'Bash' }] });
    const control = new FilesystemProviderComponentControlPlane('claude');
    const result = await control.manage(
      { provider: 'claude', cwd, componentId: 'project/hook/PreToolUse', action: 'enable' },
      { cwd, workspaceTrust: TRUSTED },
    );
    expect(result.status).toBe('unsupported');
  });

  it('rejects disabling a hook lifecycle that does not currently exist (stale target)', async () => {
    const cwd = await settingsFixture({ PreToolUse: [{ matcher: 'Bash' }] });
    const control = new FilesystemProviderComponentControlPlane('claude');
    const result = await control.manage(
      { provider: 'claude', cwd, componentId: 'project/hook/PostToolUse', action: 'disable' },
      { cwd, workspaceTrust: TRUSTED },
    );
    expect(result.status).toBe('unsupported');
  });

  it('round-trips a lifecycle name with characters unsafe in a bare id segment', async () => {
    const lifecycle = 'Pre/Tool:Use';
    const original = [{ matcher: 'Bash' }];
    const cwd = await settingsFixture({ [lifecycle]: original });
    const control = new FilesystemProviderComponentControlPlane('claude');
    const listed = await control.list({ provider: 'claude', cwd }, { cwd, workspaceTrust: TRUSTED });
    const hook = listed.items.find((item) => item.kind === 'hook' && item.name === lifecycle);
    expect(hook?.id).toBeDefined();

    const disable = await control.manage(
      { provider: 'claude', cwd, componentId: hook!.id, action: 'disable' },
      { cwd, workspaceTrust: TRUSTED },
    );
    expect(disable).toEqual({ componentId: hook!.id, status: 'disabled' });
    const afterDisable = JSON.parse(await readFile(join(cwd, '.claude', 'settings.json'), 'utf8'));
    expect(afterDisable.hooks[lifecycle]).toBeUndefined();

    const enable = await control.manage(
      { provider: 'claude', cwd, componentId: hook!.id, action: 'enable' },
      { cwd, workspaceTrust: TRUSTED },
    );
    expect(enable).toEqual({ componentId: hook!.id, status: 'enabled' });
    const afterEnable = JSON.parse(await readFile(join(cwd, '.claude', 'settings.json'), 'utf8'));
    expect(afterEnable.hooks[lifecycle]).toEqual(original);
  });

  it('rejects a manage call for a non-hook component id (no handler registered)', async () => {
    const cwd = await settingsFixture({});
    await mkdir(join(cwd, '.claude', 'skills', 'review'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: Review\n---\n');
    const control = new FilesystemProviderComponentControlPlane('claude');
    const result = await control.manage(
      { provider: 'claude', cwd, componentId: 'project/skill/review', action: 'disable' },
      { cwd, workspaceTrust: TRUSTED },
    );
    expect(result.status).toBe('unsupported');
  });

  it('rejects a manage call for Codex (no handler registered for any Codex component)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-dock-hooks-codex-'));
    const control = new FilesystemProviderComponentControlPlane('codex');
    const result = await control.manage(
      { provider: 'codex', cwd, componentId: 'project/hook/PreToolUse', action: 'disable' },
      { cwd, workspaceTrust: TRUSTED },
    );
    expect(result.status).toBe('unsupported');
  });
});
