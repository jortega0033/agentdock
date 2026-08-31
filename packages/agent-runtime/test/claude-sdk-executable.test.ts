import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveClaudeSdkExecutable } from '../src/providers/claude/sdk-executable.js';

describe('resolveClaudeSdkExecutable', () => {
  it('uses a supplied packaged executable only when it is a real file', () => {
    const resolved = resolveClaudeSdkExecutable({ packagedExecutablePath: process.execPath });
    expect(resolved).toEqual({ ok: true, path: process.execPath, source: 'packaged-resource' });
  });

  it('reports a missing packaged asset without falling back to another executable', () => {
    const resolved = resolveClaudeSdkExecutable({
      packagedExecutablePath: 'C:\\agent-dock-missing\\claude.exe',
      requireResolve: () => process.execPath,
    });
    expect(resolved).toEqual({ ok: false, reason: 'sdk_asset_missing' });
  });

  it('rejects a relative packaged override rather than resolving it from the current directory', () => {
    const resolved = resolveClaudeSdkExecutable({
      packagedExecutablePath: 'claude-agent-sdk\\claude.exe',
      requireResolve: () => process.execPath,
    });
    expect(resolved).toEqual({ ok: false, reason: 'sdk_asset_missing' });
  });

  it('prefers an adjacent packaged daemon asset before module resolution', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-dock-sdk-executable-'));
    try {
      const daemonEntry = join(root, 'index.js');
      const assetDirectory = join(root, 'claude-agent-sdk');
      const expected = join(assetDirectory, 'claude.exe');
      mkdirSync(assetDirectory);
      writeFileSync(expected, 'fixture');
      const resolved = resolveClaudeSdkExecutable({
        daemonEntryPath: daemonEntry,
        runtimePlatform: 'win32',
        requireResolve: () => process.execPath,
      });
      expect(resolved).toEqual({ ok: true, path: expected, source: 'packaged-resource' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not attempt the Windows module on a non-Windows runtime', () => {
    const resolved = resolveClaudeSdkExecutable({
      runtimePlatform: 'linux',
      requireResolve: () => {
        throw new Error('must not resolve a Windows package');
      },
    });
    expect(resolved).toEqual({ ok: false, reason: 'sdk_asset_missing' });
  });

  it('uses the SDK platform-module resolution as the development fallback', () => {
    const resolved = resolveClaudeSdkExecutable({ requireResolve: () => process.execPath });
    expect(resolved).toEqual({ ok: true, path: process.execPath, source: 'development-module' });
  });
});
