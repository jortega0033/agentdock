import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OwnedWorktreeManager, type WorktreeGitRunner } from '../src/worktree-manager.js';
import { resolveWorkspaceIdentity } from '../src/workspace-identity.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';

const run = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-dock-worktree-trust-'));
  temporaryDirectories.push(path);
  return path;
}

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await run('git', ['init'], { cwd: path });
  await writeFile(join(path, 'README.md'), 'fixture');
  await run('git', ['add', 'README.md'], { cwd: path });
  await run('git', [
    '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.test',
    'commit', '-m', 'fixture',
  ], { cwd: path });
}

const realGit: WorktreeGitRunner = (args, cwd) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout) => (error ? reject(error) : resolvePromise(stdout)),
    );
  });

function countingGit(): { runGit: WorktreeGitRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runGit: async (args, cwd) => {
      calls.push(args);
      return realGit(args, cwd);
    },
  };
}

describe('worktree trust gating', () => {
  it('runs no manager Git command for preview, create, or cleanup of an untrusted workspace', async () => {
    const base = await temporaryDirectory();
    const repo = join(base, 'repo');
    await initRepo(repo);
    const trustStore = new WorkspaceTrustStore(join(base, 'trust.json'));
    const spy = countingGit();
    const manager = new OwnedWorktreeManager(
      join(base, 'owned'),
      join(base, 'worktrees.json'),
      spy.runGit,
      trustStore,
    );
    await manager.load();

    await expect(manager.preview({ cwd: repo, name: 'child' })).rejects.toMatchObject({
      code: 'workspace_untrusted',
    });
    await expect(
      manager.create({ cwd: repo, name: 'child', confirmIncludeCopy: true }),
    ).rejects.toMatchObject({ code: 'workspace_untrusted' });
    expect(spy.calls).toEqual([]);
  }, 15_000);

  it('never runs Git against an already-created worktree whose source trust was later revoked, even on load/list', async () => {
    const base = await temporaryDirectory();
    const repo = join(base, 'repo');
    await initRepo(repo);
    const trustStore = new WorkspaceTrustStore(join(base, 'trust.json'));
    const identity = await resolveWorkspaceIdentity(repo);
    await trustStore.setTrusted(identity);
    const plainManager = new OwnedWorktreeManager(
      join(base, 'owned'),
      join(base, 'worktrees.json'),
      undefined,
      trustStore,
    );
    await plainManager.load();
    const created = await plainManager.create({
      cwd: repo,
      name: 'child',
      confirmIncludeCopy: true,
    });
    expect(created.status).toBe('ready');

    await trustStore.finishRevocation(identity);

    const spy = countingGit();
    const reloaded = new OwnedWorktreeManager(
      join(base, 'owned'),
      join(base, 'worktrees.json'),
      spy.runGit,
      trustStore,
    );
    await reloaded.load();
    const listed = await reloaded.list();
    expect(spy.calls).toEqual([]);
    // Status is left as the last-known value rather than freshly (and unsafely) re-probed.
    expect(listed.find((item) => item.id === created.id)?.status).toBe('ready');
  }, 15_000);

  it('creates and cleans up normally once the source repository is trusted', async () => {
    const base = await temporaryDirectory();
    const repo = join(base, 'repo');
    await initRepo(repo);
    const trustStore = new WorkspaceTrustStore(join(base, 'trust.json'));
    const identity = await resolveWorkspaceIdentity(repo);
    await trustStore.setTrusted(identity);
    const manager = new OwnedWorktreeManager(
      join(base, 'owned'),
      join(base, 'worktrees.json'),
      undefined,
      trustStore,
    );
    await manager.load();

    const created = await manager.create({ cwd: repo, name: 'child', confirmIncludeCopy: true });
    expect(created.status).toBe('ready');
    const cleaned = await manager.cleanup(created.id);
    expect(cleaned.status).toBe('missing');
  }, 15_000);

  it('does not propagate trust to a newly created owned worktree', async () => {
    const base = await temporaryDirectory();
    const repo = join(base, 'repo');
    await initRepo(repo);
    const trustStore = new WorkspaceTrustStore(join(base, 'trust.json'));
    await trustStore.setTrusted(await resolveWorkspaceIdentity(repo));
    const manager = new OwnedWorktreeManager(
      join(base, 'owned'),
      join(base, 'worktrees.json'),
      undefined,
      trustStore,
    );
    await manager.load();

    const created = await manager.create({ cwd: repo, name: 'child', confirmIncludeCopy: true });
    expect((await manager.list()).find((item) => item.id === created.id)).toBeDefined();
    const ownedDirs = await readdir(join(base, 'owned'));
    const worktreePath = join(base, 'owned', ownedDirs[0]!);
    const worktreeIdentity = await resolveWorkspaceIdentity(worktreePath);
    expect((await trustStore.inspect(worktreeIdentity)).state).toBe('untrusted');
  }, 15_000);

  it('aborts before the mutating worktree-add command when trust is revoked mid-flight (TOCTOU)', async () => {
    const base = await temporaryDirectory();
    const repo = join(base, 'repo');
    await initRepo(repo);
    const trustStore = new WorkspaceTrustStore(join(base, 'trust.json'));
    const identity = await resolveWorkspaceIdentity(repo);
    await trustStore.setTrusted(identity);
    const calls: string[][] = [];
    const revokingGit: WorktreeGitRunner = async (args, cwd) => {
      calls.push(args);
      if (args[0] === 'rev-parse') {
        await trustStore.finishRevocation(identity);
      }
      return realGit(args, cwd);
    };
    const manager = new OwnedWorktreeManager(
      join(base, 'owned'),
      join(base, 'worktrees.json'),
      revokingGit,
      trustStore,
    );
    await manager.load();

    await expect(
      manager.create({ cwd: repo, name: 'child', confirmIncludeCopy: true }),
    ).rejects.toMatchObject({ code: 'workspace_untrusted' });
    expect(calls.some((call) => call[0] === 'worktree' && call[1] === 'add')).toBe(false);
  }, 15_000);

  it('aborts cleanup before worktree-remove when the source directory is replaced mid-flight', async () => {
    const base = await temporaryDirectory();
    const repo = join(base, 'repo');
    await initRepo(repo);
    const trustStore = new WorkspaceTrustStore(join(base, 'trust.json'));
    await trustStore.setTrusted(await resolveWorkspaceIdentity(repo));
    const plainManager = new OwnedWorktreeManager(
      join(base, 'owned'),
      join(base, 'worktrees.json'),
      undefined,
      trustStore,
    );
    await plainManager.load();
    const created = await plainManager.create({
      cwd: repo,
      name: 'child',
      confirmIncludeCopy: true,
    });

    // `manager.load()` below issues its own dirty-check 'status --porcelain' on the *target*
    // (owned worktree) path as part of refreshStatuses() before cleanup() ever runs.
    // cleanup()'s own try block issues an identical dirty-check on the same target path once,
    // strictly after its post-lease revalidateTrusted checkpoint and strictly before its
    // pre-mutation revalidateTrusted checkpoint (worktree-manager.ts, right before
    // `worktree remove`). Triggering the source-repo replacement as a side effect *after* the
    // second occurrence of that dirty-check call -- once its own (unrelated, target-path) real
    // result has already been captured and returned -- lands the replacement inside that exact
    // window, so only the pre-mutation checkpoint can be what catches it.
    let dirtyCheckCalls = 0;
    const calls: string[][] = [];
    const replacingGit: WorktreeGitRunner = async (args, cwd) => {
      calls.push(args);
      const isDirtyCheck = args[0] === 'status' && args[1] === '--porcelain=v1';
      if (isDirtyCheck) dirtyCheckCalls += 1;
      const result = await realGit(args, cwd);
      if (isDirtyCheck && dirtyCheckCalls === 2) {
        await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        await initRepo(repo);
      }
      return result;
    };
    const manager = new OwnedWorktreeManager(
      join(base, 'owned'),
      join(base, 'worktrees.json'),
      replacingGit,
      trustStore,
    );
    await manager.load();
    expect(dirtyCheckCalls).toBe(1); // sanity: load() alone must not have triggered it yet

    await expect(manager.cleanup(created.id)).rejects.toMatchObject({
      code: 'workspace_untrusted',
    });
    expect(dirtyCheckCalls).toBe(2); // sanity: cleanup() did reach its own dirty-check call
    expect(calls.some((call) => call[0] === 'worktree' && call[1] === 'remove')).toBe(false);
  }, 15_000);
});
