import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { execCapture } from './process/exec-capture.js';

/**
 * Locates an executable without assuming it's on the PATH the daemon inherited. Electron/GUI
 * apps frequently start with a different PATH than an interactive login shell (notably on
 * macOS), so on top of a real PATH lookup (`where` / `which`, never a shell builtin) we probe a
 * short, curated list of directories CLI installers commonly use.
 */
export async function findExecutable(
  names: string[],
  extraCandidateDirs: string[] = [],
): Promise<string | null> {
  for (const name of names) {
    if (isAbsolute(name) && existsSync(name)) return name;
  }

  for (const name of names) {
    const onPath = await lookupOnPath(name);
    if (onPath) return onPath;
  }

  const candidateDirs = [...extraCandidateDirs, ...commonInstallDirs()];
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of candidateDirs) {
    for (const name of names) {
      for (const ext of extensions) {
        const candidate = join(dir, `${name}${ext}`);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  return null;
}

async function lookupOnPath(name: string): Promise<string | null> {
  const [command, args] =
    process.platform === 'win32'
      ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), [name]]
      : ['which', [name]];
  try {
    const result = await execCapture(command, args, { timeoutMs: 5_000 });
    if (result.code !== 0) return null;
    const firstLine = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return firstLine?.trim() ?? null;
  } catch {
    return null;
  }
}

function commonInstallDirs(): string[] {
  const home = homedir();
  if (process.platform === 'darwin') {
    return [
      join(home, '.local', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      join(home, '.npm-global', 'bin'),
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return [
      join(home, '.local', 'bin'),
      join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'),
      join(appData, 'npm'),
    ];
  }
  return [join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin'];
}
