import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveClaudeSdkAuth } from '../src/providers/claude/sdk-auth.js';
import {
  buildClaudeSdkOptions,
  resolveClaudeSdkConfigDir,
} from '../src/providers/claude/sdk-options.js';

const auth = resolveClaudeSdkAuth({ ANTHROPIC_API_KEY: 'api-key-canary' });
if (!auth.eligible) throw new Error('test setup failed');

describe('resolveClaudeSdkConfigDir', () => {
  it('derives unique session directories beneath the daemon-owned root', () => {
    const root = resolve('daemon-owned-config');
    const first = resolveClaudeSdkConfigDir(root, 'session-1');
    const second = resolveClaudeSdkConfigDir(root, 'session-2');
    expect(first).not.toBe(second);
    expect(first.startsWith(root)).toBe(true);
    expect(second.startsWith(root)).toBe(true);
  });

  it.each(['../escape', 'nested/path', '', ' '.repeat(2)])('rejects unsafe session id %j', (id) => {
    expect(() => resolveClaudeSdkConfigDir(resolve('daemon-owned-config'), id)).toThrow();
  });
});

describe('buildClaudeSdkOptions', () => {
  const common = {
    cwd: resolve('workspace'),
    env: { ANTHROPIC_API_KEY: 'api-key-canary' },
    auth,
    daemonConfigRoot: resolve('daemon-owned-config'),
    sessionId: 'session-1',
  } as const;

  it('permits only question interaction in an untrusted workspace', () => {
    const options = buildClaudeSdkOptions({ ...common, trustState: 'untrusted' });
    expect(options.tools).toEqual(['AskUserQuestion']);
    expect(options).toMatchObject({
      permissionMode: 'default',
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      plugins: [],
      skills: [],
      agents: {},
      hooks: {},
    });
    expect(options.allowedTools).toBeUndefined();
  });

  it('permits reviewed filesystem tools in trusted workspaces while disabling Bash', () => {
    const options = buildClaudeSdkOptions({ ...common, trustState: 'trusted' });
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'AskUserQuestion']);
    expect(options.disallowedTools).toContain('Bash');
    expect(JSON.stringify(options)).not.toContain('bypassPermissions');
  });

  it('passes the transport-owned authorization callback through unchanged', () => {
    const canUseTool = async () => ({ behavior: 'deny' as const, message: 'denied by host' });
    const options = buildClaudeSdkOptions({ ...common, trustState: 'trusted', canUseTool });
    expect(options.canUseTool).toBe(canUseTool);
  });
});
