import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WINDOWS_JOB_HOST_NAME = 'agent-dock-job-host.exe';
const MODULE_PATH = fileURLToPath(import.meta.url);

function encodeField(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** Encodes the version-1 Job Host protocol without placing raw launch values in a shell command. */
export function encodeWindowsJobHostArguments(options: {
  ownerPid: number;
  executable: string;
  cwd: string;
  args: readonly string[];
}): string[] {
  if (!Number.isSafeInteger(options.ownerPid) || options.ownerPid <= 0) {
    throw new TypeError('Windows Job Host owner PID must be a positive integer');
  }
  return [String(options.ownerPid), options.executable, options.cwd, ...options.args].map(
    encodeField,
  );
}

/**
 * Resolves only a shipped helper: colocated with the entry bundle in packaged mode, or in the
 * sibling daemon dist directory when the TypeScript daemon entry point is running in development.
 * Tests and embedders must use the explicit override instead of relying on the process CWD.
 */
export function resolveWindowsJobHostPath(
  explicitPath?: string,
  entrypoint: string | undefined = process.argv[1],
): string {
  if (explicitPath && !isAbsolute(explicitPath)) {
    throw new TypeError('Windows Job Host override must be an absolute path');
  }
  const moduleDirectory = dirname(MODULE_PATH);
  const candidates = explicitPath
    ? [explicitPath]
    : [
        ...(entrypoint && isAbsolute(entrypoint)
          ? [
              join(dirname(entrypoint), WINDOWS_JOB_HOST_NAME),
              join(dirname(entrypoint), '..', 'dist', WINDOWS_JOB_HOST_NAME),
            ]
          : []),
        // When this module is bundled into daemon/dist/index.js, this is the packaged location.
        join(moduleDirectory, WINDOWS_JOB_HOST_NAME),
        // When running workspace TypeScript directly, resolve from this source module to the
        // daemon build output. This absolute module-relative path never consults PATH or CWD.
        join(
          moduleDirectory,
          '..',
          '..',
          '..',
          '..',
          'apps',
          'daemon',
          'dist',
          WINDOWS_JOB_HOST_NAME,
        ),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return realpathSync.native(candidate);
  }
  // Preserve asynchronous spawn error handling. An absent helper never starts the provider.
  return candidates[0] ?? join(moduleDirectory, WINDOWS_JOB_HOST_NAME);
}
