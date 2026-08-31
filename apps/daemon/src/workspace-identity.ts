import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

const DEFAULT_GIT_TIMEOUT_MS = 2_000;
const DEFAULT_GIT_MAX_OUTPUT_BYTES = 64 * 1024;

export interface WorkspaceObjectIdentity {
  canonicalPath: string;
  device: string;
  fileId: string;
  birthtimeNs: string;
}

export interface WorkspaceIdentity {
  /** Stable opaque handle for the canonical path; safe to expose to the renderer. */
  workspaceId: string;
  /** Changes when either object occupying the trusted Git/workspace paths is replaced. */
  incarnation: string;
  /** Display-only basename. Durable stores and audit records never retain the full path. */
  displayName: string;
  /** Kept only in daemon memory so providers can receive the canonical worktree/directory. */
  canonicalPath: string;
  /** False when this resolution could not prove a stable filesystem/repository incarnation. */
  reusable: boolean;
  /** Filesystem identity of the canonical Git worktree root, or the non-Git workspace directory. */
  worktreeRoot: WorkspaceObjectIdentity;
  /** Filesystem identity of Git's canonical common directory when this is a Git workspace. */
  gitCommonDirectory?: WorkspaceObjectIdentity;
}

interface GitCommandOptions {
  cwd: string;
  encoding: 'utf8';
  env: NodeJS.ProcessEnv;
  killSignal: NodeJS.Signals;
  maxBuffer: number;
  shell: false;
  timeout: number;
  windowsHide: true;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (
  executable: string,
  args: readonly string[],
  options: GitCommandOptions,
) => Promise<GitCommandResult>;

export interface WorkspaceIdentityOptions {
  platform?: NodeJS.Platform;
  gitExecutable?: string;
  gitTimeoutMs?: number;
  gitMaxOutputBytes?: number;
  /** Test seam; production uses argv-only `execFile` with `shell: false`. */
  runGit?: GitCommandRunner;
}

interface DirectoryIdentityResult {
  identity: WorkspaceObjectIdentity;
  stable: boolean;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pathIdentity(path: string, platform: NodeJS.Platform): string {
  const slashNormalized = path.replaceAll('\\', '/');
  const root = parse(slashNormalized).root.replaceAll('\\', '/');
  const normalized = slashNormalized === root ? root : slashNormalized.replace(/\/+$/, '');
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function objectMaterial(identity: WorkspaceObjectIdentity, platform: NodeJS.Platform): string {
  return [
    pathIdentity(identity.canonicalPath, platform),
    identity.device,
    identity.fileId,
    identity.birthtimeNs,
  ].join('\0');
}

function hasStableObjectId(metadata: Awaited<ReturnType<typeof stat>>): boolean {
  return metadata.dev > 0n && metadata.ino > 0n;
}

async function directoryIdentity(path: string): Promise<DirectoryIdentityResult> {
  const canonicalPath = await realpath(path);
  const metadata = await stat(canonicalPath, { bigint: true });
  if (!metadata.isDirectory()) throw new Error('workspace path is not a directory');

  // Re-read after canonicalization. If the path changed underneath resolution, return an
  // explicitly non-reusable identity rather than blessing either side of the race.
  const confirmedPath = await realpath(path);
  const confirmed = await stat(confirmedPath, { bigint: true });
  if (!confirmed.isDirectory()) throw new Error('workspace path is not a directory');

  const identity: WorkspaceObjectIdentity = {
    canonicalPath,
    device: metadata.dev.toString(),
    fileId: metadata.ino.toString(),
    birthtimeNs: metadata.birthtimeNs.toString(),
  };
  const stable =
    canonicalPath === confirmedPath &&
    metadata.dev === confirmed.dev &&
    metadata.ino === confirmed.ino &&
    metadata.birthtimeNs === confirmed.birthtimeNs &&
    hasStableObjectId(metadata);
  return { identity, stable };
}

async function gitMarkerStatus(canonicalPath: string): Promise<'present' | 'absent' | 'unknown'> {
  let current = canonicalPath;
  while (true) {
    try {
      await lstat(join(current, '.git'));
      return 'present';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'unknown';
    }
    const parent = dirname(current);
    if (parent === current) return 'absent';
    current = parent;
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  ]) {
    delete env[name];
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

const runGitWithExecFile: GitCommandRunner = (executable, args, options) =>
  new Promise((resolvePromise, reject) => {
    execFile(executable, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });

function normalizeOptions(
  platformOrOptions: NodeJS.Platform | WorkspaceIdentityOptions | undefined,
): Required<
  Pick<
    WorkspaceIdentityOptions,
    'platform' | 'gitExecutable' | 'gitTimeoutMs' | 'gitMaxOutputBytes' | 'runGit'
  >
> {
  const options =
    typeof platformOrOptions === 'string'
      ? { platform: platformOrOptions }
      : (platformOrOptions ?? {});
  return {
    platform: options.platform ?? process.platform,
    gitExecutable: options.gitExecutable ?? 'git',
    gitTimeoutMs: options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    gitMaxOutputBytes: options.gitMaxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES,
    runGit: options.runGit ?? runGitWithExecFile,
  };
}

async function resolveGitPaths(
  cwd: string,
  options: ReturnType<typeof normalizeOptions>,
): Promise<{ worktreeRoot: string; commonDirectory: string } | undefined> {
  let result: GitCommandResult;
  try {
    result = await options.runGit(
      options.gitExecutable,
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      {
        cwd,
        encoding: 'utf8',
        env: gitEnvironment(),
        killSignal: 'SIGKILL',
        maxBuffer: options.gitMaxOutputBytes,
        shell: false,
        timeout: options.gitTimeoutMs,
        windowsHide: true,
      },
    );
  } catch {
    return undefined;
  }

  if (
    Buffer.byteLength(result.stdout, 'utf8') > options.gitMaxOutputBytes ||
    Buffer.byteLength(result.stderr, 'utf8') > options.gitMaxOutputBytes
  ) {
    return undefined;
  }
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length !== 2) return undefined;

  const worktreeRoot = lines[0] as string;
  const commonOutput = lines[1] as string;
  return {
    worktreeRoot: isAbsolute(worktreeRoot) ? worktreeRoot : resolve(cwd, worktreeRoot),
    commonDirectory: isAbsolute(commonOutput) ? commonOutput : resolve(worktreeRoot, commonOutput),
  };
}

function nonReusableIncarnation(canonicalKey: string): string {
  return digest(
    `workspace-incarnation-unproven-v1\0${canonicalKey}\0${randomBytes(32).toString('hex')}`,
  );
}

/**
 * Canonicalizes symlinks and binds trust to filesystem identity, not merely a reusable path.
 * Git workspaces bind both the worktree root and common directory. An ambiguous Git probe or
 * unstable object ID produces an identity usable for the current interaction only.
 */
export async function resolveWorkspaceIdentity(
  cwd: string,
  platformOrOptions?: NodeJS.Platform | WorkspaceIdentityOptions,
): Promise<WorkspaceIdentity> {
  const options = normalizeOptions(platformOrOptions);
  const requested = await directoryIdentity(cwd);
  const marker = await gitMarkerStatus(requested.identity.canonicalPath);
  const gitPaths =
    marker === 'present'
      ? await resolveGitPaths(requested.identity.canonicalPath, options)
      : undefined;

  if (marker !== 'present') {
    const canonicalKey = pathIdentity(requested.identity.canonicalPath, options.platform);
    const reusable = marker === 'absent' && requested.stable;
    return {
      workspaceId: digest(`workspace-path-v1\0${canonicalKey}`),
      incarnation: reusable
        ? digest(
            `workspace-incarnation-v1\0${objectMaterial(requested.identity, options.platform)}`,
          )
        : nonReusableIncarnation(canonicalKey),
      displayName: basename(requested.identity.canonicalPath) || 'workspace',
      canonicalPath: requested.identity.canonicalPath,
      reusable,
      worktreeRoot: requested.identity,
    };
  }

  if (!gitPaths) {
    const canonicalKey = pathIdentity(requested.identity.canonicalPath, options.platform);
    return {
      workspaceId: digest(`workspace-path-v1\0${canonicalKey}`),
      incarnation: nonReusableIncarnation(canonicalKey),
      displayName: basename(requested.identity.canonicalPath) || 'workspace',
      canonicalPath: requested.identity.canonicalPath,
      reusable: false,
      worktreeRoot: requested.identity,
    };
  }

  let worktree: DirectoryIdentityResult;
  let common: DirectoryIdentityResult;
  try {
    [worktree, common] = await Promise.all([
      directoryIdentity(gitPaths.worktreeRoot),
      directoryIdentity(gitPaths.commonDirectory),
    ]);
  } catch {
    const canonicalKey = pathIdentity(requested.identity.canonicalPath, options.platform);
    return {
      workspaceId: digest(`workspace-path-v1\0${canonicalKey}`),
      incarnation: nonReusableIncarnation(canonicalKey),
      displayName: basename(requested.identity.canonicalPath) || 'workspace',
      canonicalPath: requested.identity.canonicalPath,
      reusable: false,
      worktreeRoot: requested.identity,
    };
  }

  const worktreeKey = pathIdentity(worktree.identity.canonicalPath, options.platform);
  const commonKey = pathIdentity(common.identity.canonicalPath, options.platform);
  const reusable = requested.stable && worktree.stable && common.stable;
  return {
    workspaceId: digest(`workspace-git-path-v1\0${worktreeKey}\0${commonKey}`),
    incarnation: reusable
      ? digest(
          `workspace-git-incarnation-v1\0${objectMaterial(worktree.identity, options.platform)}\0${objectMaterial(common.identity, options.platform)}`,
        )
      : nonReusableIncarnation(`${worktreeKey}\0${commonKey}`),
    displayName: basename(worktree.identity.canonicalPath) || 'workspace',
    canonicalPath: worktree.identity.canonicalPath,
    reusable,
    worktreeRoot: worktree.identity,
    gitCommonDirectory: common.identity,
  };
}

/** Re-resolves every canonical object and fails closed on replacement, ambiguity, or I/O failure. */
export async function revalidateWorkspaceIdentity(
  expected: WorkspaceIdentity,
  platformOrOptions?: NodeJS.Platform | WorkspaceIdentityOptions,
): Promise<boolean> {
  if (!expected.reusable) return false;
  try {
    const current = await resolveWorkspaceIdentity(expected.canonicalPath, platformOrOptions);
    return (
      current.reusable &&
      current.workspaceId === expected.workspaceId &&
      current.incarnation === expected.incarnation
    );
  } catch {
    return false;
  }
}
