import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';

import { CLAUDE_AGENT_SDK_WINDOWS_X64_BINARY_PACKAGE } from './sdk-version.js';

const nodeRequire = createRequire(import.meta.url);

export type ClaudeSdkExecutableResolution =
  | { ok: true; path: string; source: 'packaged-resource' | 'development-module' }
  | { ok: false; reason: 'sdk_asset_missing' };

export interface ResolveClaudeSdkExecutableInput {
  /**
   * Electron supplies the real resource path for packaged launches.  Its presence is
   * authoritative: a missing resource must be diagnosed, not silently replaced with a
   * user-installed CLI or a development dependency.
   */
  packagedExecutablePath?: string;
  /** Daemon entrypoint path; defaults to process.argv[1] for a packaged sidecar. */
  daemonEntryPath?: string;
  runtimePlatform?: NodeJS.Platform;
  requireResolve?: (id: string) => string;
  fileExists?: (path: string) => boolean;
}

function isRegularFile(path: string, fileExists: (path: string) => boolean): boolean {
  if (!fileExists(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves an SDK-owned executable only.  This intentionally never searches PATH: doing so
 * could substitute a subscription-authenticated local Claude CLI for the permitted SDK binary.
 */
export function resolveClaudeSdkExecutable(
  input: ResolveClaudeSdkExecutableInput = {},
): ClaudeSdkExecutableResolution {
  const fileExists = input.fileExists ?? existsSync;
  const runtimePlatform = input.runtimePlatform ?? process.platform;
  const packagedPath = input.packagedExecutablePath;
  if (packagedPath !== undefined) {
    return isAbsolute(packagedPath) && isRegularFile(packagedPath, fileExists)
      ? { ok: true, path: packagedPath, source: 'packaged-resource' }
      : { ok: false, reason: 'sdk_asset_missing' };
  }

  // This release stages only the Windows x64 executable.  A non-Windows build must remain
  // buildable without a foreign optional package and report an ineligible asset at runtime.
  if (runtimePlatform !== 'win32') return { ok: false, reason: 'sdk_asset_missing' };

  const daemonEntryPath = input.daemonEntryPath ?? process.argv[1];
  if (daemonEntryPath && isAbsolute(daemonEntryPath)) {
    const colocatedPath = join(dirname(daemonEntryPath), 'claude-agent-sdk', 'claude.exe');
    if (isRegularFile(colocatedPath, fileExists)) {
      return { ok: true, path: colocatedPath, source: 'packaged-resource' };
    }
  }

  try {
    const resolved = (input.requireResolve ?? nodeRequire.resolve)(
      `${CLAUDE_AGENT_SDK_WINDOWS_X64_BINARY_PACKAGE}/claude.exe`,
    );
    return isRegularFile(resolved, fileExists)
      ? { ok: true, path: resolved, source: 'development-module' }
      : { ok: false, reason: 'sdk_asset_missing' };
  } catch {
    return { ok: false, reason: 'sdk_asset_missing' };
  }
}
