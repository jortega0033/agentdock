import type { ProviderStatus } from '@agent-dock/shared';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_AGENT_SDK_TRANSPORT_ID,
  ClaudeSdkUnsupportedError,
  resolveClaudeSdkV2Support,
} from '../src/providers/claude/sdk-support.js';

const status: ProviderStatus = {
  id: 'claude',
  name: 'Claude Agent',
  installed: true,
  authenticated: 'authenticated',
  authSource: 'api_key',
  capabilities: {},
};

const runtime = {
  runtimePlatform: 'win32',
  sdkAssetAvailable: true,
  sdkClaudeCodeVersion: '2.1.251',
} as const;

describe('resolveClaudeSdkV2Support', () => {
  it('uses SDK in auto mode only for exactly one reviewed auth source', () => {
    const support = resolveClaudeSdkV2Support(
      status,
      'auto',
      { ANTHROPIC_API_KEY: 'canary' },
      runtime,
    );
    expect(support?.transports[0]?.id).toBe(CLAUDE_AGENT_SDK_TRANSPORT_ID);
    expect(support?.capabilities.every((record) => record.scope.authMode === 'api_key')).toBe(true);
  });

  it('keeps subscription/cached-login auth on CLI in auto mode', () => {
    expect(
      resolveClaudeSdkV2Support(
        { ...status, authSource: 'claude_subscription' },
        'auto',
        {},
        runtime,
      ),
    ).toBeUndefined();
  });

  it.each([
    [{}, 'missing'],
    [{ ANTHROPIC_API_KEY: 'canary', CLAUDE_CODE_USE_BEDROCK: '1' }, 'conflicting'],
    [{ ANTHROPIC_API_KEY: 'canary', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' }, 'prohibited'],
  ] as const)('forced SDK fails closed for %s auth', (env, reason) => {
    expect(() => resolveClaudeSdkV2Support(status, 'sdk', env, runtime)).toThrowError(
      new ClaudeSdkUnsupportedError(reason),
    );
  });

  it('honors explicit CLI mode even when SDK auth is eligible', () => {
    expect(
      resolveClaudeSdkV2Support(status, 'cli', { ANTHROPIC_API_KEY: 'canary' }, runtime),
    ).toBeUndefined();
  });

  it('advertises tool effects only for trusted workspaces', () => {
    const support = resolveClaudeSdkV2Support(
      status,
      'sdk',
      { ANTHROPIC_API_KEY: 'canary' },
      runtime,
    );
    const toolRecords = support?.capabilities.filter((record) => record.id === 'content.tools');
    expect(toolRecords).toHaveLength(1);
    expect(toolRecords?.[0]?.scope.trustState).toBe('trusted');
    expect(support?.capabilities.every((record) => record.scope.trustState === 'trusted')).toBe(
      true,
    );
    expect(support?.capabilities.find((record) => record.id === 'session.resume')).toMatchObject({
      support: 'unsupported',
    });
    expect(support?.capabilities.find((record) => record.id === 'session.fork')).toMatchObject({
      support: 'unsupported',
    });
    expect(
      support?.capabilities.find((record) => record.id === 'integration.mcp.oauth'),
    ).toMatchObject({ support: 'unsupported' });
  });

  it.each([
    [{ ...runtime, runtimePlatform: 'linux' as const }, 'unsupported platform'],
    [{ ...runtime, sdkAssetAvailable: false }, 'SDK asset missing'],
    [{ ...runtime, sdkClaudeCodeVersion: '2.1.250' }, 'SDK executable version mismatch'],
  ])('fails closed when runtime eligibility fails: %s', (ineligibleRuntime, reason) => {
    expect(() =>
      resolveClaudeSdkV2Support(status, 'sdk', { ANTHROPIC_API_KEY: 'canary' }, ineligibleRuntime),
    ).toThrowError(new ClaudeSdkUnsupportedError(reason));
  });

  it.each([
    [{ ...status, installed: false }, 'provider is not installed'],
    [{ ...status, authenticated: 'unknown' as const }, 'provider is not authenticated'],
    [{ ...status, authSource: 'bedrock' as const }, 'authentication source mismatch'],
  ])('fails closed when status eligibility fails', (ineligibleStatus, reason) => {
    expect(() =>
      resolveClaudeSdkV2Support(ineligibleStatus, 'sdk', { ANTHROPIC_API_KEY: 'canary' }, runtime),
    ).toThrowError(new ClaudeSdkUnsupportedError(reason));
  });
});
