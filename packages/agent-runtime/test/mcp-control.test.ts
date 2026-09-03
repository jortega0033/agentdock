import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('provider MCP control adapters — default run environment (issue #53)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('sanitizes the environment for the DEFAULT run implementation (no run override), never the daemon\'s full process.env', async () => {
    process.env.AGENT_DOCK_ENV_ISOLATION_TEST_CANARY = 'CANARY-do-not-leak';
    try {
      const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
      vi.doMock('../src/process/exec-capture.js', () => ({
        execCapture: async (
          _cmd: string,
          _args: string[],
          opts: { env?: NodeJS.ProcessEnv },
        ) => {
          capturedEnvs.push(opts.env);
          return { code: 0, timedOut: false, stderr: '', stdout: '[]' };
        },
      }));
      const { ProviderCliMcpControlPlane: FreshControlPlane } = await import(
        '../src/mcp-control.js'
      );
      // No `run` in these options: exercises the module's own default implementation.
      const control = new FreshControlPlane({ provider: 'codex', executableName: 'codex' });
      await control.list({
        cwd: '/repo',
        workspaceTrust: { state: 'trusted', workspaceId: 'w', incarnation: 'i', trustEpoch: 0 },
        executablePath: 'codex',
      });

      expect(capturedEnvs.length).toBeGreaterThan(0);
      for (const env of capturedEnvs) {
        expect(env).not.toHaveProperty('AGENT_DOCK_ENV_ISOLATION_TEST_CANARY');
        expect(env?.PATH ?? (env as Record<string, string> | undefined)?.Path).toBeDefined();
      }
    } finally {
      delete process.env.AGENT_DOCK_ENV_ISOLATION_TEST_CANARY;
    }
  });
});
