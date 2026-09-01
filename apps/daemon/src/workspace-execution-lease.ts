import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CapabilitySelection } from '@agent-dock/shared';
import type { WorkspaceIdentity } from './workspace-identity.js';

const GIT_STATUS_TIMEOUT_MS = 2_000;
const GIT_STATUS_MAX_BYTES = 64 * 1024;

export type WorkspaceLeaseMode = 'read' | 'write';

export class WorkspaceExecutionLeaseError extends Error {
  constructor(
    readonly code: 'workspace_execution_conflict' | 'dirty_workspace_share_requires_opt_in',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceExecutionLeaseError';
  }
}

export interface WorkspaceExecutionLease {
  readonly workspaceId: string;
  readonly mode: WorkspaceLeaseMode;
  release(): void;
}

interface WorkspaceLeaseState {
  writer?: string;
  readers: Set<string>;
}

/** In-memory pre-dispatch reader/writer leases keyed by canonical workspace identity. */
export class WorkspaceExecutionLeaseManager {
  readonly #states = new Map<string, WorkspaceLeaseState>();

  acquire(options: {
    workspaceId: string;
    mode: WorkspaceLeaseMode;
    dirty: boolean;
    allowDirtyShare: boolean;
  }): WorkspaceExecutionLease {
    const current = this.#states.get(options.workspaceId);
    const shared = !!current && (!!current.writer || current.readers.size > 0);
    if (options.mode === 'write' && shared) {
      throw new WorkspaceExecutionLeaseError(
        'workspace_execution_conflict',
        'a mutation-capable session already conflicts with this workspace',
      );
    }
    if (options.mode === 'read' && current?.writer) {
      throw new WorkspaceExecutionLeaseError(
        'workspace_execution_conflict',
        'a mutation-capable session has the exclusive workspace lease',
      );
    }
    if (options.mode === 'read' && shared && options.dirty && !options.allowDirtyShare) {
      throw new WorkspaceExecutionLeaseError(
        'dirty_workspace_share_requires_opt_in',
        'sharing an already-dirty workspace requires explicit opt-in',
      );
    }

    const leaseId = randomUUID();
    const state = current ?? { readers: new Set<string>() };
    if (options.mode === 'write') state.writer = leaseId;
    else state.readers.add(leaseId);
    this.#states.set(options.workspaceId, state);
    let released = false;
    return {
      workspaceId: options.workspaceId,
      mode: options.mode,
      release: () => {
        if (released) return;
        released = true;
        const active = this.#states.get(options.workspaceId);
        if (!active) return;
        if (active.writer === leaseId) active.writer = undefined;
        active.readers.delete(leaseId);
        if (!active.writer && active.readers.size === 0) this.#states.delete(options.workspaceId);
      },
    };
  }
}

export function workspaceLeaseMode(selection: CapabilitySelection): WorkspaceLeaseMode {
  if (!selection.effectsComplete) return 'write';
  return selection.possibleEffects.some((effect) => effect !== 'read') ? 'write' : 'read';
}

/** Uses argv-only Git execution against the already-canonical worktree root. */
export async function isWorkspaceDirty(workspace: WorkspaceIdentity): Promise<boolean> {
  if (!workspace.gitCommonDirectory) return false;
  try {
    const stdout = await runGitStatus(workspace.canonicalPath);
    return stdout.length > 0;
  } catch {
    // Failure to prove cleanliness must not silently authorize dirty sharing.
    return true;
  }
}

function runGitStatus(cwd: string): Promise<string> {
  const env = { ...process.env };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) {
    delete env[name];
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';

  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=normal'],
      {
        cwd,
        encoding: 'utf8',
        env,
        killSignal: 'SIGKILL',
        maxBuffer: GIT_STATUS_MAX_BYTES,
        shell: false,
        timeout: GIT_STATUS_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}
