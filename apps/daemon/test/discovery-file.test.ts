import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertNoLiveDaemon, discoveryFilePath, removeDiscoveryFile, writeDiscoveryFile } from '../src/discovery-file.js';

const discoveryDir = join(tmpdir(), 'agent-dock');

beforeEach(() => {
  removeDiscoveryFile();
});

afterEach(() => {
  removeDiscoveryFile();
});

describe('assertNoLiveDaemon', () => {
  it('does not throw when no discovery file exists', () => {
    expect(existsSync(discoveryFilePath())).toBe(false);
    expect(() => assertNoLiveDaemon()).not.toThrow();
  });

  it('does not throw when the discovery file references a pid that is no longer running', () => {
    // A pid this large is extremely unlikely to be a real, currently-running process on any
    // platform this test runs on — standing in for "the daemon that wrote this crashed".
    writeDiscoveryFile({ port: 9999, token: 'x', pid: 999_999_999, startedAt: new Date().toISOString() });
    expect(() => assertNoLiveDaemon()).not.toThrow();
  });

  it('throws when the discovery file references the current (definitely alive) process', () => {
    writeDiscoveryFile({ port: 9999, token: 'x', pid: process.pid, startedAt: new Date().toISOString() });
    expect(() => assertNoLiveDaemon()).toThrow(/already running/);
  });

  it('does not throw when the discovery file is corrupt/partially written', () => {
    // Created 0700 to match what writeDiscoveryFile's own ensureSecureRuntimeDir would produce —
    // otherwise a later test in this file that calls writeDiscoveryFile() would find this
    // directory already existing with an insecure default mode and refuse to use it.
    mkdirSync(discoveryDir, { recursive: true, mode: 0o700 });
    writeFileSync(discoveryFilePath(), '{not valid json', { mode: 0o600 });
    expect(() => assertNoLiveDaemon()).not.toThrow();
  });
});

describe('per-app-id namespacing (AD-02)', () => {
  afterEach(() => {
    removeDiscoveryFile('my-app');
    removeDiscoveryFile('other-app');
  });

  it('writes a distinct file per app id', () => {
    writeDiscoveryFile({ port: 1111, token: 'a', pid: process.pid, startedAt: new Date().toISOString() }, 'my-app');
    writeDiscoveryFile({ port: 2222, token: 'b', pid: process.pid, startedAt: new Date().toISOString() }, 'other-app');

    expect(discoveryFilePath('my-app')).not.toBe(discoveryFilePath('other-app'));
    expect(existsSync(discoveryFilePath('my-app'))).toBe(true);
    expect(existsSync(discoveryFilePath('other-app'))).toBe(true);
  });

  it('two daemons with the SAME app id still collide — the single-instance guarantee is per app id, not removed', () => {
    writeDiscoveryFile({ port: 1111, token: 'a', pid: process.pid, startedAt: new Date().toISOString() }, 'my-app');
    expect(() => assertNoLiveDaemon('my-app')).toThrow(/already running/);
  });

  it('two daemons with DIFFERENT app ids never collide, even though one references the current (alive) process', () => {
    writeDiscoveryFile({ port: 1111, token: 'a', pid: process.pid, startedAt: new Date().toISOString() }, 'my-app');
    expect(() => assertNoLiveDaemon('other-app')).not.toThrow();
  });

  it('a stale (dead-pid) discovery file for one app id does not block a different app id from starting', () => {
    writeDiscoveryFile({ port: 1111, token: 'a', pid: 999_999_999, startedAt: new Date().toISOString() }, 'my-app');
    writeDiscoveryFile({ port: 2222, token: 'b', pid: process.pid, startedAt: new Date().toISOString() }, 'other-app');
    expect(() => assertNoLiveDaemon('my-app')).not.toThrow(); // my-app's own file is stale
    expect(() => assertNoLiveDaemon('other-app')).toThrow(/already running/); // other-app's is live
  });

  it('rejects an app id containing a path separator (traversal attempt)', () => {
    expect(() => discoveryFilePath('../../etc/passwd')).toThrow(/invalid app id/);
    expect(() => discoveryFilePath('..\\..\\windows')).toThrow(/invalid app id/);
  });

  it('rejects an app id that is an absolute path', () => {
    expect(() => discoveryFilePath('/etc/passwd')).toThrow(/invalid app id/);
  });

  it('rejects an empty app id', () => {
    expect(() => discoveryFilePath('')).toThrow(/invalid app id/);
  });

  it('rejects an app id with characters outside letters/digits/-/_', () => {
    expect(() => discoveryFilePath('my app; rm -rf /')).toThrow(/invalid app id/);
    expect(() => discoveryFilePath('my.app')).toThrow(/invalid app id/);
  });

  it('rejects an app id over 64 characters', () => {
    expect(() => discoveryFilePath('a'.repeat(65))).toThrow(/invalid app id/);
  });

  it('accepts a normal app id and uses it verbatim in the filename', () => {
    expect(discoveryFilePath('my-cool-app_2')).toBe(join(discoveryDir, 'my-cool-app_2.json'));
  });

  it('defaults to "agent-dock" when no app id is given', () => {
    expect(discoveryFilePath()).toBe(join(discoveryDir, 'agent-dock.json'));
  });
});

describe('runtime directory permissions (AD-19)', () => {
  it('creates the discovery directory with mode 0700 on POSIX', () => {
    if (process.platform === 'win32') return; // no meaningful POSIX mode on Windows — see discovery-file.ts
    rmSync(discoveryDir, { recursive: true, force: true });
    writeDiscoveryFile({ port: 1111, token: 'a', pid: process.pid, startedAt: new Date().toISOString() }, 'perm-test-app');
    const mode = statSync(discoveryDir).mode & 0o777;
    expect(mode).toBe(0o700);
    removeDiscoveryFile('perm-test-app');
  });

  it('refuses to use a pre-existing discovery directory with an insecure mode on POSIX', () => {
    if (process.platform === 'win32') return;
    rmSync(discoveryDir, { recursive: true, force: true });
    mkdirSync(discoveryDir, { recursive: true, mode: 0o777 }); // world-writable — exactly the AD-19 risk
    expect(() =>
      writeDiscoveryFile({ port: 1111, token: 'a', pid: process.pid, startedAt: new Date().toISOString() }, 'perm-test-app'),
    ).toThrow(/refusing to use/);
    rmSync(discoveryDir, { recursive: true, force: true }); // clean up the intentionally-insecure dir
  });
});
