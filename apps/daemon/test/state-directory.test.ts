import { mkdirSync, rmSync, statSync, chmodSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureStateDirectory, stateDirectory } from '../src/state-directory.js';

describe('stateDirectory', () => {
  it('honors an explicit override regardless of platform', () => {
    expect(
      stateDirectory({ env: { AGENT_DOCK_STATE_DIR: '/custom/state' }, platform: 'linux' }),
    ).toBe('/custom/state');
  });

  it('resolves a per-user, per-app path on each platform', () => {
    const home = 'C:\\Users\\fixture';
    expect(
      stateDirectory({ appId: 'my-app', env: { LOCALAPPDATA: 'C:\\Local' }, homeDirectory: home, platform: 'win32' }),
    ).toBe(join('C:\\Local', 'my-app'));
    expect(stateDirectory({ appId: 'my-app', env: {}, homeDirectory: '/home/fixture', platform: 'darwin' })).toBe(
      join('/home/fixture', 'Library', 'Application Support', 'my-app'),
    );
    expect(stateDirectory({ appId: 'my-app', env: {}, homeDirectory: '/home/fixture', platform: 'linux' })).toBe(
      join('/home/fixture', '.local', 'state', 'my-app'),
    );
  });

  it('rejects an invalid application id', () => {
    expect(() => stateDirectory({ appId: 'Not Valid!' })).toThrow('invalid application id');
  });
});

describe('ensureStateDirectory (issue #67)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function freshDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'agent-dock-state-dir-'));
    dirs.push(root);
    return join(root, 'nested', 'state');
  }

  it('creates a new directory with mode 0700 on POSIX', async () => {
    if (process.platform === 'win32') return;
    const dir = await freshDir();
    await ensureStateDirectory(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('self-heals an existing directory we own but with a looser mode', async () => {
    if (process.platform === 'win32') return;
    const dir = await freshDir();
    mkdirSync(dir, { recursive: true, mode: 0o777 });
    chmodSync(dir, 0o777);
    expect(statSync(dir).mode & 0o777).toBe(0o777);

    await ensureStateDirectory(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses to use an existing directory owned by a different user', async () => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
    const dir = await freshDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const proc = process as unknown as { getuid: () => number };
    vi.spyOn(proc, 'getuid').mockReturnValue(proc.getuid() + 1);

    await expect(ensureStateDirectory(dir)).rejects.toThrow(/refusing to use/);
  });

  it('is idempotent for an already-correct directory', async () => {
    if (process.platform === 'win32') return;
    const dir = await freshDir();
    await ensureStateDirectory(dir);
    await expect(ensureStateDirectory(dir)).resolves.toBeUndefined();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
