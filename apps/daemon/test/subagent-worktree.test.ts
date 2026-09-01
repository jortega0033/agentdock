import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubagentGraphStore } from '../src/subagent-graph-store.js';
import { OwnedWorktreeManager, WorktreeManagerError } from '../src/worktree-manager.js';

const run = promisify(execFile);
const id = (suffix: string) => `123e4567-e89b-42d3-a456-4266141740${suffix}`;

describe('subagent graph store', () => {
  it('preserves nested parentage and refuses cross-session control', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-dock-subagents-'));
    const store = new SubagentGraphStore(join(root, 'graph.json'));
    const base = { provider: 'codex' as const, status: 'running' as const, startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z', workspace: { kind: 'shared' as const, displayName: 'repo' }, controls: { steer: false, interrupt: false, cancel: false } };
    store.upsert({ ...base, id: id('01'), sessionId: id('00'), name: 'parent' });
    store.upsert({ ...base, id: id('02'), sessionId: id('00'), parentId: id('01'), name: 'child' });
    expect(store.graph(id('00')).nodes.map((node) => [node.id, node.parentId])).toEqual([[id('01'), undefined], [id('02'), id('01')]]);
    await expect(store.control({ sessionId: id('03'), agentId: id('02'), action: 'cancel' })).resolves.toBe('not_found');
    expect(() => store.upsert({ ...base, id: id('04'), sessionId: id('03'), parentId: id('01'), name: 'crossover' })).toThrow(/parent/);
  });
});

describe('owned worktree manager', () => {
  it('previews ignored/include risks and never cleans a dirty owned worktree', async () => {
    const base = await mkdtemp(join(tmpdir(), 'agent-dock-worktrees-'));
    const repo = join(base, 'repo'); const owned = join(base, 'owned');
    await mkdir(repo); await run('git', ['init'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), 'fixture');
    await writeFile(join(repo, '.gitignore'), '.env\n');
    await writeFile(join(repo, '.env'), 'SECRET=never-log');
    await writeFile(join(repo, '.worktreeinclude'), '.env\n');
    await run('git', ['add', 'README.md', '.gitignore', '.worktreeinclude'], { cwd: repo });
    await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'], { cwd: repo });
    const manager = new OwnedWorktreeManager(owned, join(base, 'worktrees.json'));
    await manager.load();
    const preview = await manager.preview({ cwd: repo, name: 'child' });
    expect(preview).toMatchObject({ includeFiles: ['.env'], secretRisk: true, requiresConfirmation: true });
    expect(JSON.stringify(preview)).not.toContain('SECRET=never-log');
    const created = await manager.create({ cwd: repo, name: 'child', confirmIncludeCopy: true });
    const target = join(owned, (await readdir(owned))[0]!);
    await writeFile(join(target, 'dirty.txt'), 'dirty');
    expect((await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: target })).stdout).toContain('dirty.txt');
    await expect(manager.cleanup(created.id)).rejects.toMatchObject({ code: 'worktree_dirty' } satisfies Partial<WorktreeManagerError>);
    expect((await manager.list()).find((item) => item.id === created.id)?.status).toBe('dirty');
  });
});
