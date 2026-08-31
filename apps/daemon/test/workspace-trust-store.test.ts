import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { stateDirectory } from '../src/state-directory.js';
import {
  resolveWorkspaceIdentity,
  revalidateWorkspaceIdentity,
  type GitCommandRunner,
  type WorkspaceIdentity,
} from '../src/workspace-identity.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-dock-trust-'));
  temporaryDirectories.push(path);
  return path;
}

function identity(overrides: Partial<WorkspaceIdentity> = {}): WorkspaceIdentity {
  return {
    workspaceId: 'a'.repeat(64),
    incarnation: 'b'.repeat(64),
    displayName: 'project',
    canonicalPath: 'C:\\project',
    reusable: true,
    worktreeRoot: {
      canonicalPath: 'C:\\project',
      device: '1',
      fileId: '2',
      birthtimeNs: '3',
    },
    ...overrides,
  };
}

describe('stateDirectory', () => {
  it('uses per-user platform state locations and supports a test override', () => {
    expect(
      stateDirectory({
        platform: 'linux',
        homeDirectory: '/home/alice',
        env: { XDG_STATE_HOME: '/state' },
      }),
    ).toBe(join('/state', 'agent-dock'));
    expect(
      stateDirectory({
        platform: 'win32',
        homeDirectory: 'C:\\Users\\Alice',
        env: { LOCALAPPDATA: 'D:\\UserState' },
      }),
    ).toBe(join('D:\\UserState', 'agent-dock'));
    expect(stateDirectory({ env: { AGENT_DOCK_STATE_DIR: '/isolated/state' } })).toBe(
      '/isolated/state',
    );
  });
});

describe('resolveWorkspaceIdentity', () => {
  it('returns a canonical opaque identity bound to the directory incarnation', async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, 'workspace');
    await mkdir(workspace);

    const first = await resolveWorkspaceIdentity(workspace);
    const second = await resolveWorkspaceIdentity(workspace);

    expect(first).toEqual(second);
    expect(first.workspaceId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.incarnation).toMatch(/^[a-f0-9]{64}$/);
    expect(first.displayName).toBe('workspace');
    expect(first.reusable).toBe(true);
    expect(first.worktreeRoot.canonicalPath).toBe(await realpath(workspace));
    expect(first.gitCommonDirectory).toBeUndefined();
    expect(await revalidateWorkspaceIdentity(first)).toBe(true);
  });

  it('binds a Git workspace to its canonical worktree and common-directory objects', async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, 'workspace');
    const nested = join(workspace, 'src');
    await mkdir(workspace);
    await execFileAsync('git', ['init', workspace], { windowsHide: true });
    await mkdir(nested);

    const resolved = await resolveWorkspaceIdentity(nested);

    expect(resolved.reusable).toBe(true);
    expect(resolved.canonicalPath).toBe(await realpath(workspace));
    expect(resolved.worktreeRoot.canonicalPath).toBe(await realpath(workspace));
    expect(resolved.gitCommonDirectory?.canonicalPath).toBe(
      await realpath(join(workspace, '.git')),
    );
    expect(await revalidateWorkspaceIdentity(resolved)).toBe(true);
  });

  it('keeps linked worktrees distinct while binding them to the same common directory', async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, 'workspace');
    const linked = join(root, 'linked');
    await execFileAsync('git', ['init', workspace], { windowsHide: true });
    await execFileAsync(
      'git',
      [
        '-C',
        workspace,
        '-c',
        'user.name=AgentDock Test',
        '-c',
        'user.email=agent-dock@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      { windowsHide: true },
    );
    await execFileAsync('git', ['-C', workspace, 'worktree', 'add', '--detach', linked, 'HEAD'], {
      windowsHide: true,
    });

    const primaryIdentity = await resolveWorkspaceIdentity(workspace);
    const linkedIdentity = await resolveWorkspaceIdentity(linked);

    expect(primaryIdentity.workspaceId).not.toBe(linkedIdentity.workspaceId);
    expect(primaryIdentity.worktreeRoot.fileId).not.toBe(linkedIdentity.worktreeRoot.fileId);
    expect(primaryIdentity.gitCommonDirectory).toEqual(linkedIdentity.gitCommonDirectory);
  }, 15_000);

  it('uses argv-only bounded Git discovery and fails closed when discovery is unprovable', async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });
    const calls: Parameters<GitCommandRunner>[] = [];
    const failingRunner: GitCommandRunner = async (...args) => {
      calls.push(args);
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    };

    const first = await resolveWorkspaceIdentity(workspace, {
      runGit: failingRunner,
      gitTimeoutMs: 17,
      gitMaxOutputBytes: 1234,
    });
    const second = await resolveWorkspaceIdentity(workspace, { runGit: failingRunner });

    expect(calls[0]?.[0]).toBe('git');
    expect(calls[0]?.[1]).toEqual([
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
    ]);
    expect(calls[0]?.[2]).toMatchObject({
      cwd: await realpath(workspace),
      maxBuffer: 1234,
      shell: false,
      timeout: 17,
      windowsHide: true,
    });
    expect(first.reusable).toBe(false);
    expect(second.reusable).toBe(false);
    expect(second.incarnation).not.toBe(first.incarnation);
    expect(await revalidateWorkspaceIdentity(first, { runGit: failingRunner })).toBe(false);
  });

  it('rejects oversized Git output even when a test runner ignores maxBuffer', async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });
    const oversizedRunner: GitCommandRunner = async () => ({
      stdout: 'x'.repeat(65),
      stderr: '',
    });

    const resolved = await resolveWorkspaceIdentity(workspace, {
      gitMaxOutputBytes: 64,
      runGit: oversizedRunner,
    });

    expect(resolved.reusable).toBe(false);
  });

  it('fails revalidation after the workspace directory is replaced', async () => {
    const root = await temporaryDirectory();
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const original = await resolveWorkspaceIdentity(workspace);

    await rm(workspace, { recursive: true });
    await mkdir(workspace);

    expect(await revalidateWorkspaceIdentity(original)).toBe(false);
  });
});

describe('WorkspaceTrustStore', () => {
  it('defaults to untrusted and persists only the exact incarnation as trusted', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'workspace-trust.json');
    const firstStore = new WorkspaceTrustStore(path);

    expect((await firstStore.inspect(identity())).state).toBe('untrusted');
    await firstStore.setTrusted(identity());
    expect((await firstStore.inspect(identity())).state).toBe('trusted');

    const reloaded = new WorkspaceTrustStore(path);
    expect((await reloaded.inspect(identity())).state).toBe('trusted');
    expect((await reloaded.inspect(identity({ incarnation: 'c'.repeat(64) }))).state).toBe(
      'untrusted',
    );
  });

  it('treats an in-progress revocation as untrusted across reloads', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'workspace-trust.json');
    const store = new WorkspaceTrustStore(path);
    await store.setTrusted(identity());
    await store.beginRevocation(identity());

    expect((await new WorkspaceTrustStore(path).inspect(identity())).state).toBe('untrusted');
  });
});
