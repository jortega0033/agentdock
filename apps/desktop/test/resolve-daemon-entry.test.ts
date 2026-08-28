import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDaemonEntry } from '../electron/resolve-daemon-entry.js';

const MAIN_DIR = join('D:', 'app', 'apps', 'desktop', 'dist-electron');
const RESOURCES_PATH = join('D:', 'app', 'resources');

describe('resolveDaemonEntry', () => {
  it('dev server: always runs source through tsx, regardless of a stale dist/ build', () => {
    const entry = resolveDaemonEntry({
      mainDir: MAIN_DIR,
      isDevServer: true,
      isPackaged: false,
      resourcesPath: RESOURCES_PATH,
      fileExists: () => true, // even if a built dist/index.js exists, dev must ignore it
    });

    expect(entry.usesSourceViaTsx).toBe(true);
    expect(entry.args).toEqual(['--import', 'tsx', join(MAIN_DIR, '..', '..', 'daemon', 'src', 'index.ts')]);
    expect(entry.cwd).toBe(join(MAIN_DIR, '..', '..', 'daemon'));
  });

  it('packaged app: resolves the daemon from resourcesPath, never from source or tsx', () => {
    const entry = resolveDaemonEntry({
      mainDir: MAIN_DIR,
      isDevServer: false,
      isPackaged: true,
      resourcesPath: RESOURCES_PATH,
      fileExists: () => false, // no dist/ next to source in a packaged app either way
    });

    expect(entry.usesSourceViaTsx).toBe(false);
    expect(entry.cwd).toBe(join(RESOURCES_PATH, 'daemon'));
    expect(entry.args).toEqual([join(RESOURCES_PATH, 'daemon', 'index.js')]);
    expect(entry.args.join(' ')).not.toContain('tsx');
    expect(entry.args.some((a) => a.endsWith('.ts'))).toBe(false);
  });

  it('packaged app never falls back to tsx even if fileExists lies and says nothing exists', () => {
    // Regression guard: packaged mode must not have any code path that reaches the tsx fallback —
    // there is no tsx dependency and no .ts source shipped in a packaged build.
    const entry = resolveDaemonEntry({
      mainDir: MAIN_DIR,
      isDevServer: false,
      isPackaged: true,
      resourcesPath: RESOURCES_PATH,
      fileExists: () => false,
    });
    expect(entry.usesSourceViaTsx).toBe(false);
  });

  it('unpacked production build: prefers the built dist/index.js when it exists', () => {
    const builtEntry = join(MAIN_DIR, '..', '..', 'daemon', 'dist', 'index.js');
    const entry = resolveDaemonEntry({
      mainDir: MAIN_DIR,
      isDevServer: false,
      isPackaged: false,
      resourcesPath: RESOURCES_PATH,
      fileExists: (p) => p === builtEntry,
    });

    expect(entry.usesSourceViaTsx).toBe(false);
    expect(entry.args).toEqual([builtEntry]);
  });

  it('unpacked production build: falls back to tsx+source when dist/index.js has not been built yet', () => {
    const entry = resolveDaemonEntry({
      mainDir: MAIN_DIR,
      isDevServer: false,
      isPackaged: false,
      resourcesPath: RESOURCES_PATH,
      fileExists: () => false,
    });

    expect(entry.usesSourceViaTsx).toBe(true);
    expect(entry.args).toEqual(['--import', 'tsx', join(MAIN_DIR, '..', '..', 'daemon', 'src', 'index.ts')]);
  });

  it('dev-server takes priority over isPackaged if both were somehow set', () => {
    const entry = resolveDaemonEntry({
      mainDir: MAIN_DIR,
      isDevServer: true,
      isPackaged: true,
      resourcesPath: RESOURCES_PATH,
    });
    expect(entry.usesSourceViaTsx).toBe(true);
  });
});
