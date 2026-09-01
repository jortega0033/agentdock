import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ProviderCliMcpControlPlane } from '../src/mcp-control.js';

const context = (cwd: string) => ({ cwd, workspaceTrust: { state: 'trusted' as const, workspaceId: 'w', incarnation: 'i', trustEpoch: 0 }, executablePath: 'provider-cli' });

describe('provider MCP control adapters', () => {
  it('inspects Claude project configuration without executing or exposing env values', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-dock-mcp-'));
    await writeFile(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node', args: ['server.js'], env: { API_KEY: 'never-expose' } } } }));
    const run = vi.fn();
    const control = new ProviderCliMcpControlPlane({ provider: 'claude', executableName: 'claude', run });
    const result = await control.list(context(cwd));
    expect(run).not.toHaveBeenCalled();
    expect(result.servers[0]?.configFields).toEqual([
      expect.objectContaining({ key: 'command', value: 'node' }),
      expect.objectContaining({ key: 'args', value: ['server.js'] }),
      expect.objectContaining({ key: 'env', present: true }),
    ]);
    expect(JSON.stringify(result)).not.toContain('never-expose');
  });

  it('uses argv-only provider commands and refreshes after a mutation', async () => {
    const run = vi.fn(async (_command: string, args: string[]) => ({
      code: 0,
      timedOut: false,
      stderr: '',
      stdout: args.includes('list') ? JSON.stringify([{ name: 'docs', enabled: true, transport: { type: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'hidden' } } }]) : '',
    }));
    const control = new ProviderCliMcpControlPlane({ provider: 'codex', executableName: 'codex', run });
    const result = await control.configure({ provider: 'codex', cwd: '/repo', action: 'add', name: 'docs', scope: 'user', config: { transport: 'stdio', command: 'node', args: ['server.js'] } }, context('/repo'));
    expect(run.mock.calls[0]?.[0]).toBe('provider-cli');
    expect(run.mock.calls[0]?.[1]).toEqual(['mcp', 'add', 'docs', '--', 'node', 'server.js']);
    expect(result.servers[0]?.id).toBe('user:docs');
    expect(JSON.stringify(result)).not.toContain('hidden');
  });
});
