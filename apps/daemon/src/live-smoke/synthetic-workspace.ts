import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SyntheticWorkspace {
  cwd: string;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

/**
 * A throwaway, real Git workspace for one live smoke case -- issue #65 requires "a synthetic
 * temporary Git workspace", not the operator's real repository. Always removes the directory
 * afterward, even if `run` throws, so a crashed smoke case can never leave provider-touched state
 * behind on disk.
 */
export async function withSyntheticWorkspace<T>(
  run: (workspace: SyntheticWorkspace) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'agent-dock-live-smoke-'));
  try {
    await git(root, ['init', '--initial-branch=main']);
    await git(root, ['config', 'user.email', 'live-smoke@agent-dock.invalid']);
    await git(root, ['config', 'user.name', 'AgentDock Live Smoke']);
    await git(root, ['commit', '--allow-empty', '-m', 'live smoke synthetic workspace']);
    return await run({ cwd: root });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
