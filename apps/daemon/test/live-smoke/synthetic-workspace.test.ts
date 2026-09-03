import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { withSyntheticWorkspace } from '../../src/live-smoke/synthetic-workspace.js';

describe('withSyntheticWorkspace', () => {
  it('creates a real, trust-eligible Git workspace and passes its cwd to run', async () => {
    let capturedCwd = '';
    await withSyntheticWorkspace(async (workspace) => {
      capturedCwd = workspace.cwd;
      expect(existsSync(workspace.cwd)).toBe(true);
      expect(existsSync(`${workspace.cwd}/.git`)).toBe(true);
    });
    // Cleaned up afterward -- see the always-cleans-up test below for the throwing case.
    await expect(access(capturedCwd)).rejects.toThrow();
  });

  it('always removes the temp directory, even when run throws', async () => {
    let capturedCwd = '';
    await expect(
      withSyntheticWorkspace(async (workspace) => {
        capturedCwd = workspace.cwd;
        throw new Error('smoke case failed');
      }),
    ).rejects.toThrow('smoke case failed');
    expect(capturedCwd).not.toBe('');
    await expect(access(capturedCwd)).rejects.toThrow();
  });

  it('returns the value run resolves with', async () => {
    const result = await withSyntheticWorkspace(async () => 'result-value');
    expect(result).toBe('result-value');
  });
});
