import { mkdir, chmod, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DIRECTORY_MODE = 0o700;

export interface StateDirectoryOptions {
  appId?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

/** Resolves AgentDock's durable, per-user state directory without using the temp rendezvous. */
export function stateDirectory(options: StateDirectoryOptions = {}): string {
  const appId = options.appId ?? 'agent-dock';
  if (!APP_ID_PATTERN.test(appId)) throw new Error('invalid application id for state directory');

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDirectory ?? homedir();
  const override = env.AGENT_DOCK_STATE_DIR?.trim();
  if (override) return override;

  if (platform === 'win32') {
    return join(
      env.LOCALAPPDATA?.trim() || env.APPDATA?.trim() || join(home, 'AppData', 'Local'),
      appId,
    );
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', appId);
  return join(env.XDG_STATE_HOME?.trim() || join(home, '.local', 'state'), appId);
}

/**
 * Creates a state directory with restrictive permissions, or revalidates an already-existing one
 * rather than assuming it's still safe (issue #67; same risk `ensureSecureRuntimeDir` in
 * discovery-file.ts already guards for the temp rendezvous directory). Unlike that stricter check,
 * this one self-heals when it's safe to: a directory we own but with a looser mode is a mistake we
 * can just correct. A directory owned by someone else is not ours to touch -- that's the one case
 * this throws for, with an actionable message, since silently writing secrets/state into a
 * directory another local user controls would be unsafe regardless of what we set its mode to.
 * POSIX-only, for the same documented reason as discovery-file.ts: Windows has no equivalent of a
 * POSIX file mode, and NTFS ACL inheritance from a per-user parent is already restrictive.
 */
export async function ensureStateDirectory(path: string): Promise<void> {
  // Node's recursive mkdir is idempotent -- it does not error when `path` already exists, and
  // only applies `mode` to directories it actually creates. So this alone is not enough on its
  // own for an existing directory; the check below is what actually re-verifies it.
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  if (process.platform === 'win32') return;

  const stats = await stat(path);
  const ownedByUs = typeof process.getuid === 'function' ? stats.uid === process.getuid() : true;
  if (!ownedByUs) {
    throw new Error(
      `refusing to use ${path}: expected it to be owned by the current user, but found owner ` +
        `uid ${stats.uid}. Remove the directory and let AgentDock recreate it. A directory ` +
        'another local user controls is not a safe place to keep daemon state or secrets.',
    );
  }
  const mode = stats.mode & 0o777;
  if (mode !== DIRECTORY_MODE) await chmod(path, DIRECTORY_MODE);
}
