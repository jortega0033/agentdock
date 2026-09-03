import { describe, expect, it } from 'vitest';
import {
  buildBaseProcessEnvironment,
  buildLegacyProviderEnvironment,
  copyCanonicalEnvKeys,
  envValue,
  findEnvEntries,
  PROVIDER_AUTH_ENV_KEYS,
  REVIEWED_OS_RUNTIME_ENV_KEYS,
} from '../src/process/provider-environment.js';

describe('buildLegacyProviderEnvironment', () => {
  it('excludes a sentinel unrelated secret and every arbitrary/AGENT_DOCK-prefixed variable', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      UNRELATED_DATABASE_PASSWORD: 'sk-CANARY-do-not-leak',
      AGENT_DOCK_APP_ID: 'agent-dock',
      AGENT_DOCK_PORT: '54321',
      AGENT_DOCK_ANYTHING_AT_ALL: 'x',
      SOME_RANDOM_CONNECTOR_TOKEN: 'CANARY-connector-secret',
    };
    const env = buildLegacyProviderEnvironment(source, { provider: 'claude' });
    expect(env).not.toHaveProperty('UNRELATED_DATABASE_PASSWORD');
    expect(env).not.toHaveProperty('AGENT_DOCK_APP_ID');
    expect(env).not.toHaveProperty('AGENT_DOCK_PORT');
    expect(env).not.toHaveProperty('AGENT_DOCK_ANYTHING_AT_ALL');
    expect(env).not.toHaveProperty('SOME_RANDOM_CONNECTOR_TOKEN');
    expect(JSON.stringify(env)).not.toContain('CANARY');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/user');
  });

  it('excludes AgentDock discovery tokens and state paths by name, not just by prefix', () => {
    const source = {
      PATH: '/usr/bin',
      AGENT_DOCK_DISCOVERY_TOKEN: 'CANARY-token',
      AGENT_DOCK_STATE_DIR: '/state/CANARY',
    };
    const env = buildLegacyProviderEnvironment(source, { provider: 'codex' });
    expect(env).not.toHaveProperty('AGENT_DOCK_DISCOVERY_TOKEN');
    expect(env).not.toHaveProperty('AGENT_DOCK_STATE_DIR');
  });

  it('drops every unknown/unreviewed key by default, keeping only the reviewed matrix', () => {
    const source: Record<string, string> = { PATH: '/usr/bin' };
    for (const key of ['RANDOM_ONE', 'RANDOM_TWO', 'NPM_TOKEN', 'GITHUB_TOKEN', 'DOCKER_HOST']) {
      source[key] = 'value';
    }
    const env = buildLegacyProviderEnvironment(source, { provider: 'claude' });
    expect(Object.keys(env)).toEqual(['PATH']);
  });

  it('includes each provider only its own documented API-key auth variable', () => {
    const source = { ANTHROPIC_API_KEY: 'ak-1', OPENAI_API_KEY: 'ok-1' };
    const claudeEnv = buildLegacyProviderEnvironment(source, { provider: 'claude' });
    expect(claudeEnv.ANTHROPIC_API_KEY).toBe('ak-1');
    expect(claudeEnv).not.toHaveProperty('OPENAI_API_KEY');

    const codexEnv = buildLegacyProviderEnvironment(source, { provider: 'codex' });
    expect(codexEnv.OPENAI_API_KEY).toBe('ok-1');
    expect(codexEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('rejects an ambiguous case-duplicate reviewed key instead of picking one at random', () => {
    const source = { PATH: '/usr/bin', Path: '/mnt/c/other/bin' };
    expect(() => buildLegacyProviderEnvironment(source, { provider: 'claude' })).toThrow(
      /duplicate reviewed keys/,
    );
  });

  it('treats Windows environment names case-insensitively for a single canonical value', () => {
    const source = { path: 'C:\\Windows\\System32', HOME: 'C:\\Users\\test' };
    const env = buildLegacyProviderEnvironment(source, { provider: 'claude' });
    // The reviewed name is "PATH"; a lone lowercase "path" entry still resolves to it.
    expect(env.PATH).toBe('C:\\Windows\\System32');
  });

  it('never mutates the source environment object', () => {
    const source = Object.freeze({ PATH: '/usr/bin', SECRET: 'CANARY' });
    expect(() => buildLegacyProviderEnvironment(source, { provider: 'claude' })).not.toThrow();
    expect(source).toEqual({ PATH: '/usr/bin', SECRET: 'CANARY' });
  });

  it('extends the matrix only through the explicit additionalAllowedKeys seam, never by default', () => {
    const source = { PATH: '/usr/bin', CORPORATE_PROXY_CA_BUNDLE: '/etc/ssl/corp.pem' };
    const withoutSeam = buildLegacyProviderEnvironment(source, { provider: 'claude' });
    expect(withoutSeam).not.toHaveProperty('CORPORATE_PROXY_CA_BUNDLE');

    const withSeam = buildLegacyProviderEnvironment(source, {
      provider: 'claude',
      additionalAllowedKeys: ['CORPORATE_PROXY_CA_BUNDLE'],
    });
    expect(withSeam.CORPORATE_PROXY_CA_BUNDLE).toBe('/etc/ssl/corp.pem');
  });

  it('drops a reviewed key entirely when the source has no value for it, never emitting undefined noise', () => {
    const env = buildLegacyProviderEnvironment({ PATH: '/usr/bin' }, { provider: 'claude' });
    expect('HOME' in env).toBe(false);
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
  });
});

describe('buildBaseProcessEnvironment', () => {
  it('includes only reviewed OS/runtime keys, no provider auth keys, and excludes secrets', () => {
    const source = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'ak-CANARY',
      OPENAI_API_KEY: 'ok-CANARY',
      RANDOM_SECRET: 'CANARY',
    };
    const env = buildBaseProcessEnvironment(source);
    expect(env).toEqual({ PATH: '/usr/bin' });
    expect(JSON.stringify(env)).not.toContain('CANARY');
  });
});

describe('reviewed key matrices are exactly what the docs claim', () => {
  it('REVIEWED_OS_RUNTIME_ENV_KEYS is provider-agnostic OS/runtime state only', () => {
    for (const key of REVIEWED_OS_RUNTIME_ENV_KEYS) {
      expect(key).not.toMatch(/API_KEY|TOKEN|SECRET|PASSWORD|AGENT_DOCK/i);
    }
  });

  it('PROVIDER_AUTH_ENV_KEYS defines exactly claude and codex, each with their own key', () => {
    expect(PROVIDER_AUTH_ENV_KEYS.claude).toEqual(['ANTHROPIC_API_KEY']);
    expect(PROVIDER_AUTH_ENV_KEYS.codex).toEqual(['OPENAI_API_KEY']);
  });
});

describe('findEnvEntries / envValue / copyCanonicalEnvKeys', () => {
  it('findEnvEntries matches every case-insensitive occurrence of a name', () => {
    const source = { Path: '/a', PATH: '/b', OTHER: '/c' };
    expect(findEnvEntries(source, 'path')).toHaveLength(2);
  });

  it('envValue returns the first case-insensitive match', () => {
    expect(envValue({ Path: '/a' }, 'PATH')).toBe('/a');
    expect(envValue({}, 'PATH')).toBeUndefined();
  });

  it('copyCanonicalEnvKeys writes only present, named keys under their canonical casing', () => {
    const target: Record<string, string | undefined> = {};
    copyCanonicalEnvKeys({ path: '/a', unrelated: 'x' }, ['PATH', 'HOME'], target);
    expect(target).toEqual({ PATH: '/a' });
  });
});
