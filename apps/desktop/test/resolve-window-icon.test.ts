import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveWindowIcon } from '../electron/resolve-window-icon.js';

const APP_PATH = join('D:', 'app', 'apps', 'desktop');
const RESOURCES_PATH = join('D:', 'app', 'resources');
const ICON_SUFFIX = ['assets', 'app-icons', 'png', 'icon-256.png'];

describe('resolveWindowIcon', () => {
  it('resolves development and unpacked builds from app.getAppPath()', () => {
    const iconPath = join(APP_PATH, ...ICON_SUFFIX);

    expect(
      resolveWindowIcon({
        appPath: APP_PATH,
        isPackaged: false,
        resourcesPath: RESOURCES_PATH,
        fileExists: (path) => path === iconPath,
      }),
    ).toBe(iconPath);
  });

  it('resolves packaged builds from process.resourcesPath, outside app.asar', () => {
    const iconPath = join(RESOURCES_PATH, ...ICON_SUFFIX);
    const fileExists = vi.fn((path: string) => path === iconPath);

    expect(
      resolveWindowIcon({
        appPath: join(RESOURCES_PATH, 'app.asar'),
        isPackaged: true,
        resourcesPath: RESOURCES_PATH,
        fileExists,
      }),
    ).toBe(iconPath);
    expect(fileExists).toHaveBeenCalledWith(iconPath);
  });

  it('returns undefined when the icon is missing', () => {
    expect(
      resolveWindowIcon({
        appPath: APP_PATH,
        isPackaged: false,
        resourcesPath: RESOURCES_PATH,
        fileExists: () => false,
      }),
    ).toBeUndefined();
  });
});
