import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderCliMcpControlPlane, StdioConnectionManager } from '../src/mcp-control.js';
import type { McpControlContext } from '../src/mcp-control.js';

const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'mcp-fixture-server.mjs');
const FAST = { connectionTimeouts: { connectMs: 2_000, listMs: 2_000, invokeMs: 2_000 } };

const TRUSTED: McpControlContext['workspaceTrust'] = {
  state: 'trusted',
  workspaceId: 'a'.repeat(64),
  incarnation: 'b'.repeat(64),
  trustEpoch: 0,
};
const UNTRUSTED: McpControlContext['workspaceTrust'] = { state: 'untrusted' };

let tempDirs: string[] = [];
async function tempCwd(mcpJson: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-dock-mcp-control-test-'));
  tempDirs.push(dir);
  await writeFile(join(dir, '.mcp.json'), JSON.stringify(mcpJson), 'utf8');
  return dir;
}

async function removeWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => removeWithRetry(dir)));
  tempDirs = [];
});

function stdioServerConfig(name: string, enabled = true) {
  return {
    mcpServers: {
      [name]: {
        type: 'stdio',
        command: process.execPath,
        args: [FIXTURE],
        enabled,
      },
    },
  };
}

describe('ProviderCliMcpControlPlane real stdio catalog/invoke', () => {
  it('connects to a real configured stdio server and returns its real tool catalog', async () => {
    const cwd = await tempCwd(stdioServerConfig('fixture'));
    const plane = new ProviderCliMcpControlPlane({ provider: 'claude', executableName: 'claude', stdioConnections: new StdioConnectionManager(FAST) });
    const context: McpControlContext = { cwd, workspaceTrust: TRUSTED };
    const catalog = await plane.catalog('project:fixture', context);
    expect(catalog.items.some((item) => item.kind === 'tool' && item.id === 'echo')).toBe(true);
  });

  it('fails closed for an untrusted workspace before ever spawning a connection', async () => {
    const cwd = await tempCwd(stdioServerConfig('fixture'));
    const plane = new ProviderCliMcpControlPlane({ provider: 'claude', executableName: 'claude', stdioConnections: new StdioConnectionManager(FAST) });
    const context: McpControlContext = { cwd, workspaceTrust: UNTRUSTED };
    await expect(plane.catalog('project:fixture', context)).rejects.toMatchObject({ code: 'workspace_untrusted' });
  });

  it('rejects an untrusted workspace on invoke the same way', async () => {
    const cwd = await tempCwd(stdioServerConfig('fixture'));
    const plane = new ProviderCliMcpControlPlane({ provider: 'claude', executableName: 'claude', stdioConnections: new StdioConnectionManager(FAST) });
    const context: McpControlContext = { cwd, workspaceTrust: UNTRUSTED };
    await expect(
      plane.invoke({ provider: 'claude', cwd, serverId: 'project:fixture', toolId: 'echo', arguments: {} }, context),
    ).rejects.toMatchObject({ code: 'workspace_untrusted' });
  });

  it('completes a real tool invocation end to end', async () => {
    const cwd = await tempCwd(stdioServerConfig('fixture'));
    const plane = new ProviderCliMcpControlPlane({ provider: 'claude', executableName: 'claude', stdioConnections: new StdioConnectionManager(FAST) });
    const context: McpControlContext = { cwd, workspaceTrust: TRUSTED };
    const result = await plane.invoke(
      { provider: 'claude', cwd, serverId: 'project:fixture', toolId: 'echo', arguments: { x: 1 } },
      context,
    );
    expect(result).toMatchObject({ status: 'completed', output: { received: { x: 1 } } });
  });

  it('returns an empty catalog, not a connection attempt, for a disabled server', async () => {
    const cwd = await tempCwd(stdioServerConfig('fixture', false));
    const plane = new ProviderCliMcpControlPlane({ provider: 'claude', executableName: 'claude', stdioConnections: new StdioConnectionManager(FAST) });
    const context: McpControlContext = { cwd, workspaceTrust: TRUSTED };
    const catalog = await plane.catalog('project:fixture', context);
    expect(catalog.items).toEqual([]);
  });

  it('raises mcp_server_not_found for an unknown server id', async () => {
    const cwd = await tempCwd(stdioServerConfig('fixture'));
    const plane = new ProviderCliMcpControlPlane({ provider: 'claude', executableName: 'claude', stdioConnections: new StdioConnectionManager(FAST) });
    const context: McpControlContext = { cwd, workspaceTrust: TRUSTED };
    await expect(plane.catalog('project:does-not-exist', context)).rejects.toMatchObject({ code: 'mcp_server_not_found' });
  });

  it('reload disconnects the live connection so the next call reconnects fresh', async () => {
    const cwd = await tempCwd(stdioServerConfig('fixture'));
    const connections = new StdioConnectionManager(FAST);
    const plane = new ProviderCliMcpControlPlane({ provider: 'claude', executableName: 'claude', stdioConnections: connections });
    const context: McpControlContext = { cwd, workspaceTrust: TRUSTED };
    await plane.catalog('project:fixture', context);
    expect(connections.hasConnection('claude', 'project:fixture', cwd)).toBe(true);
    await plane.act({ provider: 'claude', cwd, serverId: 'project:fixture', action: 'reload' }, context);
    expect(connections.hasConnection('claude', 'project:fixture', cwd)).toBe(false);
  });
});
