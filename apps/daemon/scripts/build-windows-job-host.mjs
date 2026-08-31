import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WINDOWS_JOB_HOST_NAME = 'agent-dock-job-host.exe';
const DAEMON_DIR = fileURLToPath(new URL('../', import.meta.url));

export function assertWindowsJobHostBuildPlatform(platform = process.platform) {
  if (platform !== 'win32') {
    throw new Error(
      'Windows packaging requires win32 so agent-dock-job-host.exe is compiled and verified',
    );
  }
}

export async function buildWindowsJobHost() {
  const outputPath = join(DAEMON_DIR, 'dist', WINDOWS_JOB_HOST_NAME);
  await rm(outputPath, { force: true });
  if (process.platform !== 'win32') return undefined;

  const sourcePath = join(DAEMON_DIR, 'native', 'windows', 'AgentDock.JobHost.cs');
  await mkdir(dirname(outputPath), { recursive: true });
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  const command = [
    '$ErrorActionPreference = "Stop"',
    `Add-Type -LiteralPath ${literal(sourcePath)} -OutputAssembly ${literal(outputPath)} -OutputType ConsoleApplication`,
  ].join('; ');
  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? error.stderr : '';
    throw new Error(
      `Windows Job Object host build failed${stderr ? `: ${String(stderr).trim()}` : ''}`,
    );
  }
  return outputPath;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--assert-windows')) assertWindowsJobHostBuildPlatform();
  else await buildWindowsJobHost();
}
