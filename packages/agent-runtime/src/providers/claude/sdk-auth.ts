import type { AuthSource } from '@agent-dock/shared';
import { CLAUDE_AGENT_SDK_VERSION } from './sdk-version.js';

export type ClaudeSdkAuthSource = Extract<AuthSource, 'api_key' | 'bedrock' | 'vertex' | 'foundry'>;
export type ClaudeSdkAuthFailureReason =
  'missing' | 'conflicting' | 'prohibited' | 'invalid_cloud_flag';

export type ClaudeSdkAuthResolution =
  | { eligible: true; source: ClaudeSdkAuthSource }
  | { eligible: false; reason: ClaudeSdkAuthFailureReason };

const CLOUD_AUTH_FLAGS = {
  CLAUDE_CODE_USE_BEDROCK: 'bedrock',
  CLAUDE_CODE_USE_VERTEX: 'vertex',
  CLAUDE_CODE_USE_FOUNDRY: 'foundry',
} as const satisfies Record<string, ClaudeSdkAuthSource>;

/** Credential and gateway overrides that are never admitted to the SDK transport. */
export const CLAUDE_SDK_PROHIBITED_ENV_KEYS = Object.freeze([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
] as const);

/** Minimal host state needed for the pinned native child to start and locate cloud credentials. */
const PROCESS_ENV_KEYS = Object.freeze([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR',
] as const);

/** Reviewed credential-chain inputs for each permitted commercial auth source. */
const AUTH_SOURCE_ENV_KEYS = Object.freeze({
  api_key: ['ANTHROPIC_API_KEY'],
  bedrock: [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_PROFILE',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    'AWS_EC2_METADATA_DISABLED',
    'AWS_EC2_METADATA_SERVICE_ENDPOINT',
    'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
    'AWS_SDK_LOAD_CONFIG',
  ],
  vertex: [
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_QUOTA_PROJECT',
    'GCLOUD_PROJECT',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'CLOUD_ML_REGION',
  ],
  foundry: [
    'ANTHROPIC_FOUNDRY_API_KEY',
    'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
    'ANTHROPIC_FOUNDRY_RESOURCE',
    'AZURE_CLIENT_ID',
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_CLIENT_CERTIFICATE_PATH',
    'AZURE_CLIENT_CERTIFICATE_PASSWORD',
    'AZURE_CLIENT_SEND_CERTIFICATE_CHAIN',
    'AZURE_USERNAME',
    'AZURE_PASSWORD',
    'AZURE_AUTHORITY_HOST',
    'AZURE_FEDERATED_TOKEN_FILE',
    'AZURE_TOKEN_CREDENTIALS',
    'AZURE_POD_IDENTITY_AUTHORITY_HOST',
    'IDENTITY_ENDPOINT',
    'IDENTITY_HEADER',
    'IDENTITY_SERVER_THUMBPRINT',
    'IMDS_ENDPOINT',
    'MSI_ENDPOINT',
    'MSI_SECRET',
  ],
} as const satisfies Record<ClaudeSdkAuthSource, readonly string[]>);

function findEnvEntries(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): Array<[string, string | undefined]> {
  const normalized = name.toUpperCase();
  return Object.entries(env).filter(([key]) => key.toUpperCase() === normalized);
}

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return findEnvEntries(env, name)[0]?.[1];
}

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

function copyCanonicalEnvKeys(
  source: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
  target: Record<string, string | undefined>,
): void {
  for (const name of names) {
    const entries = findEnvEntries(source, name);
    if (entries.length > 1) {
      throw new Error('Claude SDK environment contains duplicate reviewed keys');
    }
    const value = entries[0]?.[1];
    if (value !== undefined) target[name] = value;
  }
}

/** Resolves only the four reviewed SDK auth modes and never returns credential material. */
export function resolveClaudeSdkAuth(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ClaudeSdkAuthResolution {
  if (CLAUDE_SDK_PROHIBITED_ENV_KEYS.some((name) => isPresent(envValue(env, name)))) {
    return { eligible: false, reason: 'prohibited' };
  }

  const sources: ClaudeSdkAuthSource[] = [];
  if (
    ['ANTHROPIC_API_KEY', ...Object.keys(CLOUD_AUTH_FLAGS)].some(
      (name) => findEnvEntries(env, name).length > 1,
    )
  ) {
    return { eligible: false, reason: 'conflicting' };
  }
  if (isPresent(envValue(env, 'ANTHROPIC_API_KEY'))) sources.push('api_key');

  for (const [flag, source] of Object.entries(CLOUD_AUTH_FLAGS)) {
    const value = envValue(env, flag);
    if (isPresent(value) && value !== '1') {
      return { eligible: false, reason: 'invalid_cloud_flag' };
    }
    if (value === '1') sources.push(source);
  }

  if (sources.length === 0) return { eligible: false, reason: 'missing' };
  if (sources.length !== 1) return { eligible: false, reason: 'conflicting' };
  return { eligible: true, source: sources[0]! };
}

/**
 * Builds the complete SDK child environment from a source-specific allowlist. The caller must pass
 * a unique daemon-owned config directory; unreviewed daemon state never reaches the native child.
 */
export function buildClaudeSdkEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  auth: ClaudeSdkAuthResolution & { eligible: true },
  configDir: string,
): Record<string, string | undefined> {
  if (configDir.length === 0) throw new Error('Claude SDK config directory is required');
  const currentAuth = resolveClaudeSdkAuth(env);
  if (!currentAuth.eligible || currentAuth.source !== auth.source) {
    throw new Error('Claude SDK authentication scope changed');
  }

  const childEnv: Record<string, string | undefined> = {};
  copyCanonicalEnvKeys(env, PROCESS_ENV_KEYS, childEnv);
  copyCanonicalEnvKeys(env, AUTH_SOURCE_ENV_KEYS[auth.source], childEnv);

  if (auth.source !== 'api_key') {
    const selectedFlag = Object.entries(CLOUD_AUTH_FLAGS).find(
      ([, source]) => source === auth.source,
    )?.[0];
    if (!selectedFlag) throw new Error('Claude SDK authentication source is invalid');
    childEnv[selectedFlag] = '1';
  }

  childEnv.CLAUDE_CONFIG_DIR = configDir;
  childEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR = configDir;
  childEnv.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
  childEnv.CLAUDE_AGENT_SDK_VERSION = CLAUDE_AGENT_SDK_VERSION;
  childEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  childEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';

  return childEnv;
}
