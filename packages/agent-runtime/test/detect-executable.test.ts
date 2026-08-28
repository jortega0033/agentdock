import { describe, expect, it } from 'vitest';
import { findExecutable } from '../src/detect-executable.js';

describe('findExecutable', () => {
  it('returns an absolute path directly when it already exists on disk', async () => {
    const result = await findExecutable([process.execPath]);
    expect(result).toBe(process.execPath);
  });

  it('returns null for a name that is installed nowhere', async () => {
    const result = await findExecutable(['definitely-not-a-real-cli-xyz-123']);
    expect(result).toBeNull();
  });
});
