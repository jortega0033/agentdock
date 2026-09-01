import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findExecutable, lookupWindowsExecutableOnPath } from '../src/detect-executable.js';

describe('findExecutable', () => {
  it('returns an absolute path directly when it already exists on disk', async () => {
    const result = await findExecutable([process.execPath]);
    expect(result).toBe(process.execPath);
  });

  it('returns null for a name that is installed nowhere', async () => {
    const result = await findExecutable(['definitely-not-a-real-cli-xyz-123']);
    expect(result).toBeNull();
  });

  it('finds an npm cmd shim directly on a Windows PATH without consulting the CWD', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent-dock-windows-path-'));
    const shimDirectory = join(temp, 'npm bin with spaces');
    const shim = join(shimDirectory, 'codex.cmd');
    try {
      await mkdir(shimDirectory);
      await writeFile(shim, '@echo off\r\n');

      expect(
        lookupWindowsExecutableOnPath('codex', {
          Path: `;relative-entry;"${shimDirectory}"`,
          PATHEXT: '.CMD;.EXE',
        }),
      ).toBe(shim);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('preserves supported PATHEXT precedence when both Windows launchers exist', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent-dock-windows-pathext-'));
    const executable = join(temp, 'codex.exe');
    const commandShim = join(temp, 'codex.cmd');
    try {
      await Promise.all([writeFile(executable, ''), writeFile(commandShim, '@echo off\r\n')]);

      expect(
        lookupWindowsExecutableOnPath('codex', {
          PATH: temp,
          PATHEXT: '.CMD;.EXE;.BAT',
        }),
      ).toBe(commandShim);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
