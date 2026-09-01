import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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

export async function ensureStateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}
