import { describe, expect, it } from 'vitest';
import { sandboxStatusV2Schema } from '@agent-dock/shared';
import { providerSandboxStatus } from '../src/sandbox-status.js';

describe('providerSandboxStatus', () => {
  it('labels AgentDock policy separately from OS isolation', () => {
    const status = providerSandboxStatus('codex', true, 'linux');

    expect(sandboxStatusV2Schema.parse(status)).toMatchObject({
      agentDock: { state: 'enforced' },
      os: { state: 'unknown' },
      badge: 'restricted_by_policy',
    });
  });

  it('never reports native Windows Claude as Bash sandboxed', () => {
    const status = providerSandboxStatus('claude', true, 'win32');

    expect(sandboxStatusV2Schema.parse(status)).toMatchObject({
      platform: 'win32',
      os: { state: 'unavailable' },
      badge: 'restricted_by_policy',
    });
    expect(status.badge).not.toBe('bash_sandboxed');
  });
});
