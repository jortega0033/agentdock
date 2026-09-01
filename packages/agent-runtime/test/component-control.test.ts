import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilesystemProviderComponentControlPlane } from '../src/component-control.js';

describe('provider component inspection', () => {
  it('inspects bounded manifest metadata without executing untrusted project content', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-dock-components-'));
    const skill = join(cwd, '.claude', 'skills', 'review');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), '---\nname: Review\ndescription: Safe review helper\nuser-invocable: true\n---\nHooks command env mcpServers');
    const control = new FilesystemProviderComponentControlPlane('claude');
    const result = await control.list({ provider: 'claude', cwd, kind: 'skill' }, { cwd, workspaceTrust: { state: 'untrusted' } });
    const projectItem = result.items.find((item) => item.scope === 'project');
    expect(projectItem).toMatchObject({ name: 'Review', enabled: false, trusted: false, supportsDirectInvoke: true, displayPath: '.claude/skills/review/SKILL.md' });
    expect(projectItem?.manifestPreview).toMatchObject({ hooks: 1, mcpServers: 1, executables: 1, environmentVariables: 1 });
  });
});
