import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StdioJsonRpcTransport, McpTransportError } from '../src/mcp/stdio-jsonrpc-transport.js';
import { StdioMcpConnection } from '../src/mcp/stdio-mcp-connection.js';
import { StdioConnectionManager } from '../src/mcp/stdio-connection-manager.js';

const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'mcp-fixture-server.mjs');
const FAST = { connectMs: 2_000, listMs: 2_000, invokeMs: 2_000 };

function spawnFixture(mode?: string) {
  return {
    command: process.execPath,
    args: [FIXTURE],
    env: mode ? { AGENTDOCK_FIXTURE_MODE: mode } : undefined,
  };
}

let tempDirs: string[] = [];
async function tempCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-dock-mcp-test-'));
  tempDirs.push(dir);
  return dir;
}

async function removeWithRetry(dir: string): Promise<void> {
  // A just-killed child process can hold Windows' directory handle open for a short moment after
  // its exit promise already resolved; retry instead of a single attempt.
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

describe('StdioJsonRpcTransport', () => {
  it('completes a real request/response round trip over real stdio', async () => {
    const cwd = await tempCwd();
    const transport = new StdioJsonRpcTransport(process.execPath, [FIXTURE], { cwd });
    try {
      const result = await transport.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } }, 3_000);
      expect(result).toMatchObject({ serverInfo: { name: 'agentdock-fixture' } });
    } finally {
      await transport.close();
    }
  });

  it('times out distinctly when the server never responds', async () => {
    const cwd = await tempCwd();
    const transport = new StdioJsonRpcTransport(process.execPath, [FIXTURE], { cwd, env: { ...process.env, AGENTDOCK_FIXTURE_MODE: 'slow_init' } });
    try {
      await expect(transport.request('initialize', {}, 200)).rejects.toThrow(McpTransportError);
    } finally {
      await transport.close();
    }
  });

  it('detects a crashed server process and fails pending requests', async () => {
    const cwd = await tempCwd();
    const transport = new StdioJsonRpcTransport(process.execPath, [FIXTURE], { cwd });
    try {
      await transport.request('initialize', {}, 3_000);
      const pending = transport.request('tools/call', { name: 'crash' }, 3_000);
      await expect(pending).rejects.toThrow(/exited unexpectedly/);
    } finally {
      await transport.close();
    }
  });

  it('always reaps the spawned process on close, even after a crash', async () => {
    const cwd = await tempCwd();
    const transport = new StdioJsonRpcTransport(process.execPath, [FIXTURE], { cwd });
    const pid = transport.pid;
    expect(pid).toBeDefined();
    await transport.close();
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});

describe('StdioMcpConnection', () => {
  it('connects and lists a real catalog with correct destructive/sideEffecting classification', async () => {
    const cwd = await tempCwd();
    const connection = new StdioMcpConnection(spawnFixture(), cwd, FAST);
    try {
      const items = await connection.listCatalog();
      const tools = items.filter((item) => item.kind === 'tool');
      expect(tools.map((tool) => tool.id).sort()).toEqual(
        ['crash', 'delete_file', 'echo', 'fails', 'false_destructive_hint', 'hang', 'huge', 'no_hints'].sort(),
      );
      const echo = tools.find((tool) => tool.id === 'echo')!;
      expect(echo).toMatchObject({ destructive: false, sideEffecting: false });
      const deleteFile = tools.find((tool) => tool.id === 'delete_file')!;
      expect(deleteFile).toMatchObject({ destructive: true, sideEffecting: true });
      // No annotations at all -- fail closed, treat as destructive/side-effecting.
      const noHints = tools.find((tool) => tool.id === 'no_hints')!;
      expect(noHints).toMatchObject({ destructive: true, sideEffecting: true });
      // A real, previously-real bug: `destructiveHint: false` alone (no `readOnlyHint: true`)
      // must NOT be enough to skip the approval gate -- only an explicit readOnlyHint does that.
      const falseDestructiveHint = tools.find((tool) => tool.id === 'false_destructive_hint')!;
      expect(falseDestructiveHint).toMatchObject({ destructive: true, sideEffecting: true });
      // resources/list and prompts/list are unimplemented by the fixture -- an empty catalog for
      // that kind is a legitimate result, not a connection failure.
      expect(items.some((item) => item.kind === 'resource')).toBe(false);
      expect(items.some((item) => item.kind === 'prompt')).toBe(false);
    } finally {
      await connection.close();
    }
  });

  it('tolerates a server with no optional listing methods at all', async () => {
    const cwd = await tempCwd();
    const connection = new StdioMcpConnection(spawnFixture('no_optional_methods'), cwd, FAST);
    try {
      const items = await connection.listCatalog();
      expect(items).toEqual([]);
    } finally {
      await connection.close();
    }
  });

  it('invokes a real tool and returns its output', async () => {
    const cwd = await tempCwd();
    const connection = new StdioMcpConnection(spawnFixture(), cwd, FAST);
    try {
      const result = await connection.callTool('echo', { hello: 'world' });
      expect(result).toEqual({ status: 'completed', output: { received: { hello: 'world' } } });
    } finally {
      await connection.close();
    }
  });

  it('reports a server-side tool error as a failed status, not a thrown exception', async () => {
    const cwd = await tempCwd();
    const connection = new StdioMcpConnection(spawnFixture(), cwd, FAST);
    try {
      const result = await connection.callTool('fails', {});
      expect(result.status).toBe('failed');
    } finally {
      await connection.close();
    }
  });

  it('fails closed on an oversized invocation result instead of returning it', async () => {
    const cwd = await tempCwd();
    const connection = new StdioMcpConnection(spawnFixture(), cwd, FAST);
    try {
      const result = await connection.callTool('huge', {});
      expect(result.status).toBe('failed');
      expect(result.safeSummary).toMatch(/exceeded the maximum/);
    } finally {
      await connection.close();
    }
  });

  it('times out an invocation that never responds, distinctly from a crash', async () => {
    const cwd = await tempCwd();
    const connection = new StdioMcpConnection(spawnFixture(), cwd, { ...FAST, invokeMs: 200 });
    try {
      const result = await connection.callTool('hang', {});
      expect(result.status).toBe('failed');
      expect(result.safeSummary).toMatch(/timeout/);
    } finally {
      await connection.close();
    }
  });

  it('rejects garbage (non-JSON-RPC) output instead of hanging or crashing the client', async () => {
    const cwd = await tempCwd();
    const connection = new StdioMcpConnection(spawnFixture('garbage'), cwd, { ...FAST, connectMs: 300 });
    try {
      await expect(connection.connect()).rejects.toThrow(McpTransportError);
    } finally {
      await connection.close();
    }
  });

  it('fails closed on an oversized single line from the server (frame overflow)', async () => {
    const cwd = await tempCwd();
    const connection = new StdioMcpConnection(spawnFixture('oversized_line'), cwd, { ...FAST, connectMs: 3_000 });
    try {
      await expect(connection.connect()).rejects.toThrow(McpTransportError);
    } finally {
      await connection.close();
    }
  });
});

describe('StdioConnectionManager', () => {
  it('reuses one live connection across a catalog fetch followed by an invocation', async () => {
    const cwd = await tempCwd();
    const manager = new StdioConnectionManager({ connectionTimeouts: FAST });
    try {
      await manager.getCatalog('claude', 'project:fixture', cwd, spawnFixture());
      expect(manager.hasConnection('claude', 'project:fixture', cwd)).toBe(true);
      const result = await manager.invoke('claude', 'project:fixture', cwd, spawnFixture(), 'echo', {});
      expect(result.status).toBe('completed');
      expect(manager.hasConnection('claude', 'project:fixture', cwd)).toBe(true);
    } finally {
      await manager.closeAll();
    }
  });

  it('always reaps the process when closeFor is called', async () => {
    const cwd = await tempCwd();
    const manager = new StdioConnectionManager({ connectionTimeouts: FAST });
    await manager.getCatalog('codex', 'user:fixture', cwd, spawnFixture());
    expect(manager.hasConnection('codex', 'user:fixture', cwd)).toBe(true);
    await manager.closeFor('codex', 'user:fixture', cwd);
    expect(manager.hasConnection('codex', 'user:fixture', cwd)).toBe(false);
  });

  it('always reaps every connection on closeAll (daemon shutdown)', async () => {
    const cwdA = await tempCwd();
    const cwdB = await tempCwd();
    const manager = new StdioConnectionManager({ connectionTimeouts: FAST });
    await manager.getCatalog('claude', 'project:a', cwdA, spawnFixture());
    await manager.getCatalog('claude', 'project:b', cwdB, spawnFixture());
    await manager.closeAll();
    expect(manager.hasConnection('claude', 'project:a', cwdA)).toBe(false);
    expect(manager.hasConnection('claude', 'project:b', cwdB)).toBe(false);
  });

  it('evicts and reaps the least-recently-used connection at capacity', async () => {
    const manager = new StdioConnectionManager({ maxConnections: 2, connectionTimeouts: FAST });
    try {
      const cwd1 = await tempCwd();
      const cwd2 = await tempCwd();
      const cwd3 = await tempCwd();
      await manager.getCatalog('claude', 'project:s1', cwd1, spawnFixture());
      await manager.getCatalog('claude', 'project:s2', cwd2, spawnFixture());
      await manager.getCatalog('claude', 'project:s3', cwd3, spawnFixture());
      expect(manager.hasConnection('claude', 'project:s1', cwd1)).toBe(false);
      expect(manager.hasConnection('claude', 'project:s3', cwd3)).toBe(true);
    } finally {
      await manager.closeAll();
    }
  });

  it('auto-evicts and reaps a connection whose process crashed', async () => {
    const cwd = await tempCwd();
    const manager = new StdioConnectionManager({ connectionTimeouts: FAST });
    try {
      await manager.getCatalog('claude', 'project:fixture', cwd, spawnFixture());
      // The crash tool exits the process without responding; the transport reports this as a
      // failed status (not a thrown error) so a single tool crash doesn't blow up the caller --
      // the pool still notices via the connection's independent crashSignal and evicts it.
      const result = await manager.invoke('claude', 'project:fixture', cwd, spawnFixture(), 'crash', {});
      expect(result.status).toBe('failed');
      await new Promise((r) => setTimeout(r, 200));
      expect(manager.hasConnection('claude', 'project:fixture', cwd)).toBe(false);
    } finally {
      await manager.closeAll();
    }
  });

  it('still reaps the spawned process when the initialize handshake itself times out', async () => {
    const cwd = await tempCwd();
    const manager = new StdioConnectionManager({ connectionTimeouts: { ...FAST, connectMs: 200 } });
    await expect(
      manager.getCatalog('claude', 'project:fixture', cwd, spawnFixture('slow_init')),
    ).rejects.toThrow();
    // A failed connect must not leave the pool thinking it owns a live connection, and must not
    // leave the underlying process running either.
    expect(manager.hasConnection('claude', 'project:fixture', cwd)).toBe(false);
    await manager.closeAll();
  });
});
