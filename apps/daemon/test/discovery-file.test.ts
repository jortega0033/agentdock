import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
    mkdirSync(discoveryDir, { recursive: true });
    writeFileSync(discoveryFilePath(), '{not valid json', { mode: 0o600 });
    expect(() => assertNoLiveDaemon()).not.toThrow();
  });
});
