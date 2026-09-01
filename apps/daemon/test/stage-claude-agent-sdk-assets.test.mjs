import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { stageClaudeAgentSdkAssets } from '../scripts/stage-claude-agent-sdk-assets.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('stageClaudeAgentSdkAssets', () => {
  it('skips staging on non-Windows build hosts without resolving a foreign optional package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-dock-sdk-assets-'));
    roots.push(root);
    await expect(
      stageClaudeAgentSdkAssets({ destinationRoot: root, runtimePlatform: 'linux' }),
    ).resolves.toMatchObject({ skipped: true, destinationRoot: root });
  });

  it('stages the executable and mandatory notices outside the daemon bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-dock-sdk-assets-'));
    roots.push(root);
    const staged = await stageClaudeAgentSdkAssets({ destinationRoot: root });

    if (process.platform !== 'win32') {
      expect(staged).toMatchObject({ skipped: true });
      return;
    }
    expect(staged.executablePath).toBe(join(root, 'claude.exe'));
    expect(staged).toMatchObject({ sdkVersion: '0.3.251', claudeCodeVersion: '2.1.251' });
    expect((await stat(staged.executablePath)).isFile()).toBe(true);
    await Promise.all([
      access(join(root, 'LICENSE.sdk.md')),
      access(join(root, 'LICENSE.win32-x64.md')),
      access(join(root, 'README.sdk.md')),
      access(join(root, 'README.win32-x64.md')),
    ]);
    const notice = await readFile(join(root, 'NOTICE.txt'), 'utf8');
    expect(notice).toContain('Claude Agent');
    expect(notice).toContain('Do not use: Claude Code, Claude Code Agent.');
    expect(notice).toContain('Commercial Terms');
  });
});
