import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pure path-resolution logic for locating the daemon, factored out of main.ts so it's testable
 * without an Electron runtime (this file imports nothing from 'electron'). main.ts is the only
 * caller and supplies the real `app.isPackaged` / `process.resourcesPath` values.
 */
export interface ResolveDaemonEntryInput {
  /** Directory containing the compiled main.js (derived from import.meta.url in main.ts). */
  mainDir: string;
  /** True when running under `vite dev` (VITE_DEV_SERVER_URL set). */
  isDevServer: boolean;
  /** Electron's `app.isPackaged`. */
  isPackaged: boolean;
  /** Electron's `process.resourcesPath`; only read when `isPackaged` is true. */
  resourcesPath: string;
  /** Injectable for tests; defaults to `node:fs`'s `existsSync`. */
  fileExists?: (path: string) => boolean;
}

export interface DaemonEntry {
  cwd: string;
  args: string[];
  /** True only for the dev-mode path that runs TypeScript source directly through tsx. */
  usesSourceViaTsx: boolean;
}

/**
 * Three distinct cases, in priority order:
 *
 * 1. **Dev server** (`vite dev` spawned us; VITE_DEV_SERVER_URL is set): always run
 *    apps/daemon/src/index.ts live through tsx, even if a stale `dist/` build exists from an
 *    earlier `pnpm build`, so the sidecar always reflects current source.
 * 2. **Packaged app** (installed/running from an electron-builder output): the daemon's built
 *    bundle ships as an extraResource *outside* app.asar (see electron-builder.yml) at
 *    `resourcesPath/daemon/index.js`, never source, never tsx, since neither exists in a
 *    packaged build.
 * 3. **Unpacked production build** (`pnpm build` ran but the app isn't packaged, e.g. `electron .`
 *    against apps/desktop directly): prefer apps/daemon's own `dist/index.js` next to its source;
 *    fall back to tsx+source only if that build hasn't been run yet.
 */
export function resolveDaemonEntry(input: ResolveDaemonEntryInput): DaemonEntry {
  const fileExists = input.fileExists ?? existsSync;

  if (input.isDevServer) {
    const daemonPkgDir = join(input.mainDir, '..', '..', 'daemon');
    return {
      cwd: daemonPkgDir,
      args: ['--import', 'tsx', join(daemonPkgDir, 'src', 'index.ts')],
      usesSourceViaTsx: true,
    };
  }

  if (input.isPackaged) {
    const daemonDir = join(input.resourcesPath, 'daemon');
    return { cwd: daemonDir, args: [join(daemonDir, 'index.js')], usesSourceViaTsx: false };
  }

  const daemonPkgDir = join(input.mainDir, '..', '..', 'daemon');
  const builtEntry = join(daemonPkgDir, 'dist', 'index.js');
  if (fileExists(builtEntry)) {
    return { cwd: daemonPkgDir, args: [builtEntry], usesSourceViaTsx: false };
  }
  return {
    cwd: daemonPkgDir,
    args: ['--import', 'tsx', join(daemonPkgDir, 'src', 'index.ts')],
    usesSourceViaTsx: true,
  };
}
