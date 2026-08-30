import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ResolveWindowIconInput {
  /** Electron's app.getAppPath(); used by development and unpacked builds. */
  appPath: string;
  /** Electron's app.isPackaged. */
  isPackaged: boolean;
  /** Electron's process.resourcesPath; used only by packaged builds. */
  resourcesPath: string;
  /** Injectable for tests; defaults to node:fs existsSync. */
  fileExists?: (path: string) => boolean;
}

/** Resolve the development or packaged BrowserWindow icon without assuming a source-tree path. */
export function resolveWindowIcon(input: ResolveWindowIconInput): string | undefined {
  const root = input.isPackaged ? input.resourcesPath : input.appPath;
  const iconPath = join(root, 'assets', 'app-icons', 'png', 'icon-256.png');
  return (input.fileExists ?? existsSync)(iconPath) ? iconPath : undefined;
}
