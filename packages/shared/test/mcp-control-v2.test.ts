import { describe, expect, it } from 'vitest';
import {
  mcpConfigureRequestV2Schema,
  mcpOAuthStatusV2Schema,
  mcpServerDescriptorV2Schema,
} from '../src/mcp-control-v2.js';

describe('MCP control protocol', () => {
  it('never exposes secret or unknown configuration values', () => {
    const base = {
      id: 'docs', provider: 'codex', name: 'docs', ownership: 'provider', scope: 'user',
      transport: 'streamable_http', enabled: true, required: false,
      connectionStatus: 'ready', authStatus: 'authenticated',
      catalog: { tools: 1, resources: 0, prompts: 0 },
      capabilities: { connect: true, reload: true, configure: true, oauth: true, tools: true, resources: false, prompts: false },
      sessionIds: [],
    } as const;
    expect(mcpServerDescriptorV2Schema.safeParse({ ...base, configFields: [{ key: 'token', classification: 'secret', present: true, source: 'provider', value: 'leak' }] }).success).toBe(false);
    expect(mcpServerDescriptorV2Schema.parse({ ...base, configFields: [{ key: 'url', classification: 'unknown', present: true, source: 'provider' }] }).configFields[0]).not.toHaveProperty('value');
  });

  it('accepts only public stdio arguments or HTTPS URLs', () => {
    expect(mcpConfigureRequestV2Schema.safeParse({ provider: 'codex', cwd: '/repo', action: 'add', name: 'safe', scope: 'user', config: { transport: 'stdio', command: 'npx', args: ['server'] } }).success).toBe(true);
    expect(mcpConfigureRequestV2Schema.safeParse({ provider: 'codex', cwd: '/repo', action: 'add', name: 'unsafe', scope: 'user', config: { transport: 'streamable_http', url: 'http://example.test', token: 'secret' } }).success).toBe(false);
  });

  it('keeps OAuth token-opaque and requires HTTPS browser URLs', () => {
    expect(mcpOAuthStatusV2Schema.safeParse({ serverId: 'docs', status: 'pending', authorizationUrl: 'https://login.example.test/authorize' }).success).toBe(true);
    expect(mcpOAuthStatusV2Schema.safeParse({ serverId: 'docs', status: 'pending', authorizationUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(mcpOAuthStatusV2Schema.safeParse({ serverId: 'docs', status: 'authenticated', token: 'leak' }).success).toBe(false);
  });
});
