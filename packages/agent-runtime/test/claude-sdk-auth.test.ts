import { describe, expect, it } from 'vitest';
import {
  buildClaudeSdkEnvironment,
  resolveClaudeSdkAuth,
} from '../src/providers/claude/sdk-auth.js';

describe('resolveClaudeSdkAuth', () => {
  it.each([
    [{ ANTHROPIC_API_KEY: 'api-key-canary' }, 'api_key'],
    [{ CLAUDE_CODE_USE_BEDROCK: '1' }, 'bedrock'],
    [{ CLAUDE_CODE_USE_VERTEX: '1' }, 'vertex'],
    [{ CLAUDE_CODE_USE_FOUNDRY: '1' }, 'foundry'],
  ] as const)('admits exactly one reviewed auth mode', (env, source) => {
    expect(resolveClaudeSdkAuth(env)).toEqual({ eligible: true, source });
  });

  it('treats cached subscription login with no reviewed environment auth as missing', () => {
    expect(resolveClaudeSdkAuth({})).toEqual({ eligible: false, reason: 'missing' });
  });

  it('rejects conflicting reviewed modes', () => {
    expect(
      resolveClaudeSdkAuth({ ANTHROPIC_API_KEY: 'canary', CLAUDE_CODE_USE_VERTEX: '1' }),
    ).toEqual({ eligible: false, reason: 'conflicting' });
  });

  it('rejects case-duplicate controlled auth keys before Windows can choose one', () => {
    expect(
      resolveClaudeSdkAuth({
        ANTHROPIC_API_KEY: 'first-canary',
        anthropic_api_key: 'second-canary',
      }),
    ).toEqual({ eligible: false, reason: 'conflicting' });
  });

  it('rejects malformed cloud selectors instead of guessing', () => {
    expect(resolveClaudeSdkAuth({ CLAUDE_CODE_USE_BEDROCK: 'true' })).toEqual({
      eligible: false,
      reason: 'invalid_cloud_flag',
    });
  });

  it.each([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
    'ANTHROPIC_VERTEX_BASE_URL',
    'ANTHROPIC_FOUNDRY_BASE_URL',
  ])('rejects prohibited %s', (key) => {
    expect(
      resolveClaudeSdkAuth({ ANTHROPIC_API_KEY: 'allowed', [key]: 'prohibited-canary' }),
    ).toEqual({ eligible: false, reason: 'prohibited' });
  });
});

describe('buildClaudeSdkEnvironment', () => {
  it('copies only reviewed process/auth keys and installs isolation markers', () => {
    const auth = resolveClaudeSdkAuth({ ANTHROPIC_API_KEY: 'api-key-canary' });
    expect(auth.eligible).toBe(true);
    if (!auth.eligible) throw new Error('test setup failed');

    const child = buildClaudeSdkEnvironment(
      {
        PATH: 'path-canary',
        ANTHROPIC_API_KEY: 'api-key-canary',
        ANTHROPIC_MODEL: 'model-canary',
        ANTHROPIC_OAUTH_TOKEN: 'alternate-oauth-canary',
        CLAUDE_CODE_API_KEY_HELPER: 'helper-canary',
        CLAUDE_CODE_GIT_BASH_PATH: 'wrapper-canary',
        CLAUDE_CODE_SETTINGS_PATH: 'settings-canary',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: 'secure-storage-canary',
        claude_config_dir: 'user-config-canary',
        claude_code_subprocess_env_scrub: '0',
        claude_code_disable_auto_memory: '0',
        NODE_OPTIONS: '--require=wrapper-canary',
        UNRELATED_SECRET: 'secret-canary',
      },
      auth,
      '/daemon/session-config',
    );

    expect(child).toMatchObject({
      PATH: 'path-canary',
      ANTHROPIC_API_KEY: 'api-key-canary',
      CLAUDE_CONFIG_DIR: '/daemon/session-config',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/daemon/session-config',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_AGENT_SDK_VERSION: '0.3.251',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    });
    expect(Object.keys(child).sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'CLAUDE_AGENT_SDK_VERSION',
        'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
        'CLAUDE_CODE_ENTRYPOINT',
        'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
        'CLAUDE_CONFIG_DIR',
        'CLAUDE_SECURESTORAGE_CONFIG_DIR',
        'PATH',
      ].sort(),
    );
    expect(Object.keys(child).map((key) => key.toUpperCase())).not.toContain(
      'CLAUDE_CODE_OAUTH_TOKEN',
    );
    expect(Object.keys(child).filter((key) => key.toUpperCase() === 'CLAUDE_CONFIG_DIR')).toEqual([
      'CLAUDE_CONFIG_DIR',
    ]);
    expect(
      Object.keys(child).filter((key) => key.toUpperCase() === 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'),
    ).toEqual(['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']);
    expect(
      Object.keys(child).filter((key) => key.toUpperCase() === 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'),
    ).toEqual(['CLAUDE_CODE_DISABLE_AUTO_MEMORY']);
    expect(child.ANTHROPIC_MODEL).toBeUndefined();
    expect(child.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(child.CLAUDE_CODE_API_KEY_HELPER).toBeUndefined();
    expect(child.CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined();
    expect(child.CLAUDE_CODE_SETTINGS_PATH).toBeUndefined();
    expect(child.NODE_OPTIONS).toBeUndefined();
    expect(child.UNRELATED_SECRET).toBeUndefined();
  });

  it('fails closed if prohibited auth or gateway state appears after resolution', () => {
    const auth = resolveClaudeSdkAuth({ ANTHROPIC_API_KEY: 'api-key-canary' });
    expect(auth.eligible).toBe(true);
    if (!auth.eligible) throw new Error('test setup failed');

    expect(() =>
      buildClaudeSdkEnvironment(
        { ANTHROPIC_API_KEY: 'api-key-canary', ANTHROPIC_BASE_URL: 'gateway-canary' },
        auth,
        '/daemon/session-config',
      ),
    ).toThrow(/authentication scope changed/);
  });

  it('canonicalizes the selected auth selector in the child environment', () => {
    const auth = resolveClaudeSdkAuth({ anthropic_api_key: 'api-key-canary' });
    expect(auth.eligible).toBe(true);
    if (!auth.eligible) throw new Error('test setup failed');

    const child = buildClaudeSdkEnvironment(
      { anthropic_api_key: 'api-key-canary' },
      auth,
      '/daemon/session-config',
    );
    expect(child.ANTHROPIC_API_KEY).toBe('api-key-canary');
    expect(Object.keys(child).filter((key) => key.toUpperCase() === 'ANTHROPIC_API_KEY')).toEqual([
      'ANTHROPIC_API_KEY',
    ]);
  });

  it.each([
    [
      { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1', AWS_PROFILE: 'dock' },
      'bedrock',
      { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1', AWS_PROFILE: 'dock' },
    ],
    [
      {
        CLAUDE_CODE_USE_VERTEX: '1',
        ANTHROPIC_VERTEX_PROJECT_ID: 'project-canary',
        CLOUD_ML_REGION: 'europe-west1',
      },
      'vertex',
      {
        CLAUDE_CODE_USE_VERTEX: '1',
        ANTHROPIC_VERTEX_PROJECT_ID: 'project-canary',
        CLOUD_ML_REGION: 'europe-west1',
      },
    ],
    [
      {
        CLAUDE_CODE_USE_FOUNDRY: '1',
        ANTHROPIC_FOUNDRY_RESOURCE: 'resource-canary',
        ANTHROPIC_FOUNDRY_API_KEY: 'foundry-key-canary',
      },
      'foundry',
      {
        CLAUDE_CODE_USE_FOUNDRY: '1',
        ANTHROPIC_FOUNDRY_RESOURCE: 'resource-canary',
        ANTHROPIC_FOUNDRY_API_KEY: 'foundry-key-canary',
      },
    ],
  ] as const)('retains only reviewed %s credential-chain inputs', (env, source, expected) => {
    const auth = resolveClaudeSdkAuth(env);
    expect(auth).toEqual({ eligible: true, source });
    if (!auth.eligible) throw new Error('test setup failed');

    const child = buildClaudeSdkEnvironment(
      { ...env, ANTHROPIC_API_URL: 'gateway-canary', CLAUDE_CODE_SHELL: 'wrapper-canary' },
      auth,
      '/daemon/session-config',
    );
    expect(child).toMatchObject(expected);
    expect(child.ANTHROPIC_API_URL).toBeUndefined();
    expect(child.CLAUDE_CODE_SHELL).toBeUndefined();
  });

  it('rejects case-duplicate reviewed keys instead of choosing one', () => {
    const auth = resolveClaudeSdkAuth({ CLAUDE_CODE_USE_BEDROCK: '1' });
    expect(auth.eligible).toBe(true);
    if (!auth.eligible) throw new Error('test setup failed');

    expect(() =>
      buildClaudeSdkEnvironment(
        {
          CLAUDE_CODE_USE_BEDROCK: '1',
          AWS_REGION: 'eu-west-1',
          aws_region: 'us-east-1',
        },
        auth,
        '/daemon/session-config',
      ),
    ).toThrow(/duplicate reviewed keys/);
  });
});
