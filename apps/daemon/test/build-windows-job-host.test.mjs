import { describe, expect, it } from 'vitest';
import { assertWindowsJobHostBuildPlatform } from '../scripts/build-windows-job-host.mjs';

describe('Windows Job Host packaging preflight', () => {
  it('fails closed when a Windows package is requested off Windows', () => {
    expect(() => assertWindowsJobHostBuildPlatform('linux')).toThrow(
      'Windows packaging requires win32',
    );
    expect(() => assertWindowsJobHostBuildPlatform('darwin')).toThrow(
      'Windows packaging requires win32',
    );
  });

  it('allows the Windows packaging host that compiles the helper', () => {
    expect(() => assertWindowsJobHostBuildPlatform('win32')).not.toThrow();
  });
});
