import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateGateResults,
  buildManifest,
  importProviderMatrixEvidence,
} from '../../../scripts/release-candidate/manifest.mjs';

describe('aggregateGateResults', () => {
  it('is ready when every gate passed', () => {
    const result = aggregateGateResults([
      { name: 'lint', passed: true },
      { name: 'typecheck', passed: true },
    ]);
    expect(result).toEqual({ ready: true, failedGates: [], gates: expect.any(Array) });
  });

  it('is never ready when any single gate failed, however minor', () => {
    const result = aggregateGateResults([
      { name: 'lint', passed: true },
      { name: 'typecheck', passed: true },
      { name: 'installer-lifecycle', passed: false, detail: 'silent uninstall left files behind' },
    ]);
    expect(result.ready).toBe(false);
    expect(result.failedGates).toEqual(['installer-lifecycle']);
  });

  it('reports every failed gate, not just the first', () => {
    const result = aggregateGateResults([
      { name: 'lint', passed: false },
      { name: 'test', passed: false },
      { name: 'build', passed: true },
    ]);
    expect(result.failedGates).toEqual(['lint', 'test']);
  });

  it('refuses to aggregate an empty gate list rather than silently reporting ready', () => {
    expect(() => aggregateGateResults([])).toThrow();
  });
});

describe('importProviderMatrixEvidence', () => {
  let dir;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('reports unavailable, not an implicit pass, when the evidence file does not exist', async () => {
    const result = await importProviderMatrixEvidence(join(tmpdir(), 'definitely-does-not-exist.jsonl'));
    expect(result).toEqual({ available: false, rows: [] });
  });

  it('reports unavailable when no path is given at all', async () => {
    const result = await importProviderMatrixEvidence(undefined);
    expect(result).toEqual({ available: false, rows: [] });
  });

  it('imports rows without exposing raw provider output, and labels non-success rows as not verified', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-dock-rc-evidence-'));
    const evidencePath = join(dir, 'evidence.jsonl');
    const rawSuccess = {
      schemaVersion: 1,
      commit: 'a'.repeat(40),
      os: 'win32',
      provider: 'codex',
      transport: 'codex-app-server',
      providerVersion: '0.147.0',
      authSourceCategory: 'chatgpt',
      capabilitiesTested: ['session.cancel'],
      resultCode: 'success',
      durationMs: 4200,
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const rawSkip = { ...rawSuccess, transport: 'claude-agent-sdk', resultCode: 'skipped_missing_binary' };
    await writeFile(evidencePath, `${JSON.stringify(rawSuccess)}\n${JSON.stringify(rawSkip)}\n`, 'utf8');

    const result = await importProviderMatrixEvidence(evidencePath);
    expect(result.available).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({
      provider: 'codex',
      transport: 'codex-app-server',
      providerVersion: '0.147.0',
      resultCode: 'success',
      verified: true,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(result.rows[1].verified).toBe(false);
    expect(result.rows[1].resultCode).toBe('skipped_missing_binary');
    // Only the fields the schema declares are ever present -- no capabilitiesTested/durationMs/os
    // leak through, even though the source row had them.
    for (const row of result.rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['provider', 'providerVersion', 'resultCode', 'timestamp', 'transport', 'verified'].sort(),
      );
    }
  });
});

describe('buildManifest', () => {
  const baseInput = {
    commit: 'a'.repeat(40),
    dirty: false,
    osImage: 'windows-2022',
    nodeVersion: '20.18.0',
    pnpmVersion: '10.29.2',
    providerPins: { 'codex-app-server': '0.147.0' },
    artifacts: [],
    signingStatus: 'unsigned',
    documentedExceptions: [],
    providerMatrix: { available: false, rows: [] },
  };

  it('is ready only when every gate passed', () => {
    const manifest = buildManifest({
      ...baseInput,
      gates: [
        { name: 'lint', passed: true },
        { name: 'test', passed: true },
      ],
    });
    expect(manifest.ready).toBe(true);
    expect(manifest.failedGates).toEqual([]);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.published).toBe(false);
    expect(manifest.signingStatus).toBe('unsigned');
  });

  it('is not ready when a gate failed, regardless of how many others passed', () => {
    const manifest = buildManifest({
      ...baseInput,
      gates: [
        { name: 'lint', passed: true },
        { name: 'typecheck', passed: true },
        { name: 'test', passed: true },
        { name: 'build', passed: true },
        { name: 'audit', passed: true },
        { name: 'packaging', passed: true },
        { name: 'packaged-app-launch', passed: true },
        { name: 'installer-lifecycle', passed: false, detail: 'uninstall left a registry key' },
      ],
    });
    expect(manifest.ready).toBe(false);
    expect(manifest.failedGates).toEqual(['installer-lifecycle']);
  });

  it('a missing or stale provider matrix never elevates an unverified transport to verified', () => {
    const manifest = buildManifest({
      ...baseInput,
      gates: [{ name: 'lint', passed: true }],
      providerMatrix: { available: false, rows: [] },
    });
    expect(manifest.providerMatrix.available).toBe(false);
    expect(manifest.providerMatrix.rows).toEqual([]);
  });
});
