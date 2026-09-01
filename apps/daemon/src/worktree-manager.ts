import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  OwnedWorktreeV2,
  WorktreeCreateRequestV2,
  WorktreePreviewRequestV2,
  WorktreePreviewV2,
} from '@agent-dock/shared';
import { resolveWorkspaceIdentity } from './workspace-identity.js';

interface StoredWorktrees {
  version: 1;
  worktrees: Array<
    OwnedWorktreeV2 & {
      sourcePath: string;
      targetPath: string;
      includeDigests?: Record<string, string>;
    }
  >;
}
type StoredWorktree = StoredWorktrees['worktrees'][number];
export type WorktreeGitRunner = (args: string[], cwd: string) => Promise<string>;

export class WorktreeManagerError extends Error {
  constructor(
    readonly code:
      | 'invalid_repository'
      | 'invalid_ref'
      | 'invalid_target'
      | 'worktree_busy'
      | 'worktree_dirty'
      | 'worktree_locked'
      | 'worktree_not_found'
      | 'worktree_external',
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeManagerError';
  }
}

const defaultGit: WorktreeGitRunner = (args, cwd) =>
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
const MAX_INCLUDE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_INCLUDE_TOTAL_BYTES = 100 * 1024 * 1024;

async function digestFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function inside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function risky(path: string): boolean {
  return /(^|\/)(\.env|id_rsa|credentials?|secrets?|tokens?)(\.|\/|$)/i.test(
    path.replaceAll('\\', '/'),
  );
}

export class OwnedWorktreeManager {
  readonly #records = new Map<string, StoredWorktree>();
  readonly #leases = new Set<string>();
  readonly #runGit: WorktreeGitRunner;

  constructor(
    private readonly root: string,
    private readonly stateFile: string,
    runGit: WorktreeGitRunner = defaultGit,
  ) {
    this.#runGit = runGit;
  }

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<StoredWorktrees>;
      if (parsed.version !== 1 || !Array.isArray(parsed.worktrees)) return;
      for (const record of parsed.worktrees) {
        if (
          record &&
          typeof record.id === 'string' &&
          typeof record.targetPath === 'string' &&
          inside(root, resolve(record.targetPath))
        )
          this.#records.set(record.id, record);
      }
    } catch {
      /* first run or corrupt ownership file: own nothing */
    }
    await this.refreshStatuses();
  }

  async preview(input: WorktreePreviewRequestV2): Promise<WorktreePreviewV2> {
    const identity = await resolveWorkspaceIdentity(input.cwd);
    if (!identity.gitCommonDirectory)
      throw new WorktreeManagerError('invalid_repository', 'Worktrees require a Git repository');
    const includeFiles = await this.includeFiles(identity.canonicalPath);
    let ignoredFiles: string[] = [];
    try {
      ignoredFiles = (
        await this.#runGit(
          ['status', '--ignored', '--porcelain=v1', '--untracked-files=all'],
          identity.canonicalPath,
        )
      )
        .split(/\r?\n/)
        .filter((line) => line.startsWith('!! '))
        .map((line) => line.slice(3))
        .filter((path) => path.length > 0 && path.length <= 1_024)
        .slice(0, 10_000);
    } catch {
      /* unknown ignored files stay omitted; confirmation still required */
    }
    return {
      workspaceId: identity.workspaceId,
      name: input.name,
      displayTarget: input.name,
      includeFiles,
      ignoredFiles,
      secretRisk: [...includeFiles, ...ignoredFiles].some(risky),
      requiresConfirmation: true,
    };
  }

  async create(input: WorktreeCreateRequestV2): Promise<OwnedWorktreeV2> {
    const identity = await resolveWorkspaceIdentity(input.cwd);
    if (!identity.gitCommonDirectory)
      throw new WorktreeManagerError('invalid_repository', 'Worktrees require a Git repository');
    const root = await realpath(this.root);
    const id = randomUUID();
    const target = resolve(
      root,
      `${identity.workspaceId.slice(0, 12)}-${input.name}-${id.slice(0, 8)}`,
    );
    if (!inside(root, target) || samePath(target, identity.canonicalPath))
      throw new WorktreeManagerError('invalid_target', 'Worktree target is outside the owned root');
    if (process.platform === 'win32' && target.length >= 240)
      throw new WorktreeManagerError(
        'invalid_target',
        'Owned worktree path is too long for reliable Windows Git operations',
      );
    if (this.#leases.has(identity.workspaceId))
      throw new WorktreeManagerError(
        'worktree_busy',
        'A worktree operation is already active for this repository',
      );
    this.#leases.add(identity.workspaceId);
    try {
      const preview = await this.preview(input);
      const includeDigests: Record<string, string> = {};
      let includeBytes = 0;
      for (const path of preview.includeFiles) {
        const source = resolve(identity.canonicalPath, path);
        if (!inside(identity.canonicalPath, source)) continue;
        const metadata = await lstat(source).catch(() => undefined);
        if (!metadata?.isFile() || metadata.isSymbolicLink()) continue;
        includeBytes += metadata.size;
        if (metadata.size > MAX_INCLUDE_FILE_BYTES || includeBytes > MAX_INCLUDE_TOTAL_BYTES)
          throw new WorktreeManagerError(
            'invalid_target',
            'Worktree include files exceed the safe copy limit',
          );
        includeDigests[path] = await digestFile(source);
      }
      let commit: string;
      try {
        commit = (
          await this.#runGit(
            ['rev-parse', '--verify', '--end-of-options', `${input.ref ?? 'HEAD'}^{commit}`],
            identity.canonicalPath,
          )
        ).trim();
      } catch {
        throw new WorktreeManagerError('invalid_ref', 'Worktree ref does not resolve to a commit');
      }
      if (!/^[a-f0-9]{40,64}$/i.test(commit))
        throw new WorktreeManagerError('invalid_ref', 'Worktree ref resolved to an invalid commit');
      const record: StoredWorktree = {
        id,
        workspaceId: identity.workspaceId,
        name: input.name,
        displayPath: input.name,
        status: 'missing',
        createdAt: new Date().toISOString(),
        ...(input.ref ? { branch: input.ref } : {}),
        sourcePath: identity.canonicalPath,
        targetPath: target,
        includeDigests,
      };
      this.#records.set(id, record);
      await this.persist();
      await this.#runGit(['worktree', 'add', '--detach', target, commit], identity.canonicalPath);
      record.status = 'ready';
      await this.persist();
      for (const [path, expectedDigest] of Object.entries(includeDigests)) {
        const source = resolve(identity.canonicalPath, path);
        const destination = resolve(target, path);
        if (!inside(identity.canonicalPath, source) || !inside(target, destination)) continue;
        const metadata = await lstat(source).catch(() => undefined);
        if (!metadata?.isFile() || metadata.isSymbolicLink()) continue;
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await copyFile(source, destination);
        if ((await digestFile(destination)) !== expectedDigest)
          throw new WorktreeManagerError(
            'worktree_dirty',
            'A worktree include file changed during copy',
          );
      }
      await this.refreshStatuses();
      return this.public(record);
    } catch (error) {
      await this.refreshStatuses().catch(() => undefined);
      throw error;
    } finally {
      this.#leases.delete(identity.workspaceId);
    }
  }

  async list(): Promise<OwnedWorktreeV2[]> {
    await this.refreshStatuses();
    return [...this.#records.values()].map((record) => this.public(record));
  }

  async cleanup(id: string): Promise<OwnedWorktreeV2> {
    const record = this.#records.get(id);
    if (!record)
      throw new WorktreeManagerError('worktree_not_found', 'Owned worktree was not found');
    const root = await realpath(this.root);
    const canonicalTarget = await realpath(record.targetPath).catch(() => undefined);
    if (!canonicalTarget) {
      record.status = 'missing';
      await this.persist();
      throw new WorktreeManagerError('worktree_not_found', 'Owned worktree path is missing');
    }
    if (!inside(root, canonicalTarget) || !samePath(canonicalTarget, record.targetPath))
      throw new WorktreeManagerError(
        'worktree_external',
        'External or redirected worktrees cannot be removed',
      );
    if (this.#leases.has(record.workspaceId))
      throw new WorktreeManagerError('worktree_busy', 'Worktree is currently leased');
    this.#leases.add(record.workspaceId);
    try {
      const porcelain = await this.#runGit(['worktree', 'list', '--porcelain'], record.sourcePath);
      const lines = porcelain.split(/\r?\n/);
      const start = lines.findIndex(
        (line) => line.startsWith('worktree ') && samePath(line.slice(9), record.targetPath),
      );
      const end =
        start < 0
          ? -1
          : lines.findIndex((line, index) => index > start && line.startsWith('worktree '));
      const block =
        start < 0 ? undefined : lines.slice(start, end < 0 ? undefined : end).join('\n');
      if (!block) {
        record.status = 'orphaned';
        await this.persist();
        throw new WorktreeManagerError(
          'worktree_external',
          'Worktree is no longer registered to its source repository',
        );
      }
      if (/^locked/m.test(block)) {
        record.status = 'locked';
        await this.persist();
        throw new WorktreeManagerError(
          'worktree_locked',
          'Locked worktrees are never removed automatically',
        );
      }
      const gitDirty = (
        await this.#runGit(
          ['status', '--porcelain=v1', '--untracked-files=all'],
          record.targetPath,
        )
      ).trim();
      if (gitDirty || (await this.includesChanged(record))) {
        record.status = 'dirty';
        await this.persist();
        throw new WorktreeManagerError(
          'worktree_dirty',
          'Dirty worktrees are never removed automatically',
        );
      }
      await this.#runGit(['worktree', 'remove', record.targetPath], record.sourcePath);
      record.status = 'missing';
      await this.persist();
      return this.public(record);
    } finally {
      this.#leases.delete(record.workspaceId);
    }
  }

  private async includeFiles(cwd: string): Promise<string[]> {
    let contents: string;
    try {
      contents = await readFile(join(cwd, '.worktreeinclude'), 'utf8');
    } catch {
      return [];
    }
    if (Buffer.byteLength(contents, 'utf8') > 64 * 1024) return [];
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line &&
          !line.startsWith('#') &&
          line.length <= 1_024 &&
          !isAbsolute(line) &&
          !line.split(/[\\/]/).includes('..'),
      )
      .slice(0, 10_000);
  }

  private async refreshStatuses(): Promise<void> {
    let changed = false;
    const root = await realpath(this.root);
    for (const record of this.#records.values()) {
      const previous = record.status;
      const canonicalTarget = await realpath(record.targetPath).catch(() => undefined);
      if (!canonicalTarget) {
        record.status = 'missing';
      } else if (!inside(root, canonicalTarget) || !samePath(canonicalTarget, record.targetPath)) {
        record.status = 'orphaned';
      } else {
        try {
          const porcelain = await this.#runGit(
            ['worktree', 'list', '--porcelain'],
            record.sourcePath,
          );
          const lines = porcelain.split(/\r?\n/);
          const start = lines.findIndex(
            (line) => line.startsWith('worktree ') && samePath(line.slice(9), record.targetPath),
          );
          const end =
            start < 0
              ? -1
              : lines.findIndex((line, index) => index > start && line.startsWith('worktree '));
          const block =
            start < 0 ? undefined : lines.slice(start, end < 0 ? undefined : end).join('\n');
          if (!block) record.status = 'orphaned';
          else if (/^locked/m.test(block)) record.status = 'locked';
          else {
            const gitDirty = (
              await this.#runGit(
                ['status', '--porcelain=v1', '--untracked-files=all'],
                record.targetPath,
              )
            ).trim();
            record.status = gitDirty || (await this.includesChanged(record)) ? 'dirty' : 'ready';
          }
        } catch {
          record.status = 'orphaned';
        }
      }
      if (record.status !== previous) changed = true;
    }
    if (changed) await this.persist();
  }

  private async includesChanged(record: StoredWorktree): Promise<boolean> {
    for (const [path, expectedDigest] of Object.entries(record.includeDigests ?? {})) {
      const candidate = resolve(record.targetPath, path);
      if (!inside(record.targetPath, candidate)) return true;
      const metadata = await lstat(candidate).catch(() => undefined);
      if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_INCLUDE_FILE_BYTES)
        return true;
      if ((await digestFile(candidate).catch(() => undefined)) !== expectedDigest) return true;
    }
    return false;
  }

  private public(record: StoredWorktree): OwnedWorktreeV2 {
    const {
      sourcePath: _source,
      targetPath: _target,
      includeDigests: _includeDigests,
      ...view
    } = record;
    return structuredClone(view);
  }
  private async persist(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, worktrees: [...this.#records.values()] })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await rename(temporary, this.stateFile);
  }
}
