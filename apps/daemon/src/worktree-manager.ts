import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { OwnedWorktreeV2, WorktreeCreateRequestV2, WorktreePreviewRequestV2, WorktreePreviewV2 } from '@agent-dock/shared';
import { resolveWorkspaceIdentity } from './workspace-identity.js';

interface StoredWorktrees { version: 1; worktrees: Array<OwnedWorktreeV2 & { sourcePath: string; targetPath: string }> }
type StoredWorktree = StoredWorktrees['worktrees'][number];
export type WorktreeGitRunner = (args: string[], cwd: string) => Promise<string>;

export class WorktreeManagerError extends Error {
  constructor(readonly code: 'invalid_repository' | 'invalid_target' | 'worktree_busy' | 'worktree_dirty' | 'worktree_locked' | 'worktree_not_found' | 'worktree_external', message: string) { super(message); this.name = 'WorktreeManagerError'; }
}

const defaultGit: WorktreeGitRunner = (args, cwd) => new Promise((resolvePromise, reject) => {
  execFile('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout) => error ? reject(error) : resolvePromise(stdout));
});

function inside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function risky(path: string): boolean {
  return /(^|\/)(\.env|id_rsa|credentials?|secrets?|tokens?)(\.|\/|$)/i.test(path.replaceAll('\\', '/'));
}

export class OwnedWorktreeManager {
  readonly #records = new Map<string, StoredWorktree>();
  readonly #leases = new Set<string>();
  readonly #runGit: WorktreeGitRunner;

  constructor(private readonly root: string, private readonly stateFile: string, runGit: WorktreeGitRunner = defaultGit) {
    this.#runGit = runGit;
  }

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<StoredWorktrees>;
      if (parsed.version !== 1 || !Array.isArray(parsed.worktrees)) return;
      for (const record of parsed.worktrees) {
        if (record && typeof record.id === 'string' && typeof record.targetPath === 'string' && inside(resolve(this.root), resolve(record.targetPath))) this.#records.set(record.id, record);
      }
    } catch { /* first run or corrupt ownership file: own nothing */ }
    await this.refreshStatuses();
  }

  async preview(input: WorktreePreviewRequestV2): Promise<WorktreePreviewV2> {
    const identity = await resolveWorkspaceIdentity(input.cwd);
    if (!identity.gitCommonDirectory) throw new WorktreeManagerError('invalid_repository', 'Worktrees require a Git repository');
    const includeFiles = await this.includeFiles(identity.canonicalPath);
    let ignoredFiles: string[] = [];
    try {
      ignoredFiles = (await this.#runGit(['status', '--ignored', '--porcelain=v1', '--untracked-files=all'], identity.canonicalPath)).split(/\r?\n/).filter((line) => line.startsWith('!! ')).map((line) => line.slice(3)).filter((path) => path.length > 0 && path.length <= 1_024).slice(0, 10_000);
    } catch { /* unknown ignored files stay omitted; confirmation still required */ }
    return { workspaceId: identity.workspaceId, name: input.name, displayTarget: input.name, includeFiles, ignoredFiles, secretRisk: [...includeFiles, ...ignoredFiles].some(risky), requiresConfirmation: true };
  }

  async create(input: WorktreeCreateRequestV2): Promise<OwnedWorktreeV2> {
    const identity = await resolveWorkspaceIdentity(input.cwd);
    if (!identity.gitCommonDirectory) throw new WorktreeManagerError('invalid_repository', 'Worktrees require a Git repository');
    const root = await realpath(this.root);
    const id = randomUUID();
    const target = resolve(root, `${identity.workspaceId.slice(0, 12)}-${input.name}-${id.slice(0, 8)}`);
    if (!inside(root, target) || target === identity.canonicalPath) throw new WorktreeManagerError('invalid_target', 'Worktree target is outside the owned root');
    if (this.#leases.has(identity.workspaceId)) throw new WorktreeManagerError('worktree_busy', 'A worktree operation is already active for this repository');
    this.#leases.add(identity.workspaceId);
    try {
      await this.#runGit(['worktree', 'add', '--detach', target, input.ref ?? 'HEAD'], identity.canonicalPath);
      for (const path of (await this.preview(input)).includeFiles) {
        const source = resolve(identity.canonicalPath, path);
        const destination = resolve(target, path);
        if (!inside(identity.canonicalPath, source) || !inside(target, destination)) continue;
        const metadata = await lstat(source).catch(() => undefined);
        if (!metadata?.isFile() || metadata.isSymbolicLink()) continue;
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await copyFile(source, destination);
      }
      const record: StoredWorktree = { id, workspaceId: identity.workspaceId, name: input.name, displayPath: input.name, status: 'ready', createdAt: new Date().toISOString(), ...(input.ref ? { branch: input.ref } : {}), sourcePath: identity.canonicalPath, targetPath: target };
      this.#records.set(id, record); await this.persist(); return this.public(record);
    } finally { this.#leases.delete(identity.workspaceId); }
  }

  async list(): Promise<OwnedWorktreeV2[]> { await this.refreshStatuses(); return [...this.#records.values()].map((record) => this.public(record)); }

  async cleanup(id: string): Promise<OwnedWorktreeV2> {
    const record = this.#records.get(id);
    if (!record) throw new WorktreeManagerError('worktree_not_found', 'Owned worktree was not found');
    const root = await realpath(this.root);
    if (!inside(root, resolve(record.targetPath))) throw new WorktreeManagerError('worktree_external', 'External worktrees cannot be removed');
    if (this.#leases.has(record.workspaceId)) throw new WorktreeManagerError('worktree_busy', 'Worktree is currently leased');
    this.#leases.add(record.workspaceId);
    try {
      const porcelain = await this.#runGit(['worktree', 'list', '--porcelain'], record.sourcePath);
      const lines = porcelain.split(/\r?\n/);
      const start = lines.findIndex((line) => line.startsWith('worktree ') && resolve(line.slice(9)) === resolve(record.targetPath));
      const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && line.startsWith('worktree '));
      const block = start < 0 ? undefined : lines.slice(start, end < 0 ? undefined : end).join('\n');
      if (!block) { record.status = 'orphaned'; await this.persist(); throw new WorktreeManagerError('worktree_external', 'Worktree is no longer registered to its source repository'); }
      if (/^locked/m.test(block)) { record.status = 'locked'; await this.persist(); throw new WorktreeManagerError('worktree_locked', 'Locked worktrees are never removed automatically'); }
      if ((await this.#runGit(['status', '--porcelain=v1', '--untracked-files=all'], record.targetPath)).trim()) { record.status = 'dirty'; await this.persist(); throw new WorktreeManagerError('worktree_dirty', 'Dirty worktrees are never removed automatically'); }
      await this.#runGit(['worktree', 'remove', record.targetPath], record.sourcePath);
      record.status = 'missing'; await this.persist(); return this.public(record);
    } finally { this.#leases.delete(record.workspaceId); }
  }

  private async includeFiles(cwd: string): Promise<string[]> {
    let contents: string;
    try { contents = await readFile(join(cwd, '.worktreeinclude'), 'utf8'); } catch { return []; }
    if (Buffer.byteLength(contents, 'utf8') > 64 * 1024) return [];
    return contents.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.length <= 1_024 && !isAbsolute(line) && !line.split(/[\\/]/).includes('..')).slice(0, 10_000);
  }

  private async refreshStatuses(): Promise<void> {
    for (const record of this.#records.values()) {
      if (record.status === 'missing') continue;
      try { await lstat(record.targetPath); } catch { record.status = 'missing'; }
    }
  }

  private public(record: StoredWorktree): OwnedWorktreeV2 { const { sourcePath: _source, targetPath: _target, ...view } = record; return structuredClone(view); }
  private async persist(): Promise<void> { await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 }); const temporary = `${this.stateFile}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify({ version: 1, worktrees: [...this.#records.values()] })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await rename(temporary, this.stateFile); }
}
