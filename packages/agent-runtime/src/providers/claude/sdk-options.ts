import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { buildClaudeSdkEnvironment, type ClaudeSdkAuthResolution } from './sdk-auth.js';
import { ClaudeAgentSdkProtocolError } from './sdk/errors.js';

export type ClaudeWorkspaceTrustState = 'trusted' | 'untrusted';

const TRUSTED_TOOLS = Object.freeze([
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'AskUserQuestion',
] as const);
const UNTRUSTED_TOOLS = Object.freeze(['AskUserQuestion'] as const);

export interface ClaudeSdkOptionsInput {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  auth: ClaudeSdkAuthResolution & { eligible: true };
  trustState: ClaudeWorkspaceTrustState;
  daemonConfigRoot: string;
  sessionId: string;
  /** Transport-owned interactive authorization callback; omitted means SDK prompts auto-deny. */
  canUseTool?: Options['canUseTool'];
  /** Caller-selected model (issue #107). Omitted keeps the SDK's own default. */
  model?: string;
}

/** Derives an isolated config directory from daemon-owned root and unique session identity. */
export function resolveClaudeSdkConfigDir(daemonConfigRoot: string, sessionId: string): string {
  if (!isAbsolute(daemonConfigRoot)) {
    throw new Error('Claude SDK daemon config root must be absolute');
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw new Error('Claude SDK session id is invalid');
  }

  const root = resolve(daemonConfigRoot, 'claude-agent-sdk');
  const configDir = resolve(root, sessionId);
  const pathFromRoot = relative(root, configDir);
  if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error('Claude SDK config directory escaped daemon root');
  }
  return configDir;
}

/** True when `target`'s canonical path is not `workspace` itself or a descendant of it. */
export function escapesWorkspace(workspace: string, target: string): boolean {
  const pathFromWorkspace = relative(workspace, target);
  return (
    pathFromWorkspace === '..' ||
    pathFromWorkspace.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(pathFromWorkspace)
  );
}

/**
 * Creates the isolated, daemon-owned SDK config directory for one session (or probe), verifying
 * at every step -- not just by path string -- that nothing between the daemon root and the final
 * directory has been swapped for a symlink. Throws `ClaudeAgentSdkProtocolError` on unsafe state.
 */
export async function prepareClaudeSdkConfigDirectory(
  daemonConfigRoot: string,
  configDirectory: string,
): Promise<void> {
  let rootStat;
  try {
    rootStat = await lstat(daemonConfigRoot);
  } catch {
    throw new ClaudeAgentSdkProtocolError(
      'claude_sdk_state_invalid',
      'Claude SDK daemon config root is unavailable',
    );
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ClaudeAgentSdkProtocolError(
      'claude_sdk_state_invalid',
      'Claude SDK daemon config root is not a safe directory',
    );
  }
  const canonicalRoot = await realpath(daemonConfigRoot);
  const sdkRoot = resolve(daemonConfigRoot, 'claude-agent-sdk');
  await mkdir(sdkRoot, { recursive: true, mode: 0o700 });
  const sdkRootStat = await lstat(sdkRoot);
  const canonicalSdkRoot = await realpath(sdkRoot);
  if (
    !sdkRootStat.isDirectory() ||
    sdkRootStat.isSymbolicLink() ||
    escapesWorkspace(canonicalRoot, canonicalSdkRoot)
  ) {
    throw new ClaudeAgentSdkProtocolError(
      'claude_sdk_state_invalid',
      'Claude SDK config parent escaped the daemon root',
    );
  }
  try {
    await mkdir(configDirectory, { mode: 0o700 });
  } catch {
    throw new ClaudeAgentSdkProtocolError(
      'claude_sdk_state_invalid',
      'Claude SDK session config directory already exists',
    );
  }
}

/**
 * Removes a directory created by `prepareClaudeSdkConfigDirectory`, refusing if it was swapped for
 * something other than a plain directory (e.g. a symlink) between creation and cleanup.
 */
export async function removeClaudeSdkConfigDirectory(configDirectory: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(configDirectory);
  } catch {
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ClaudeAgentSdkProtocolError(
      'claude_sdk_config_cleanup_failed',
      'Claude SDK config directory changed before cleanup',
    );
  }
  try {
    await rm(configDirectory, { recursive: true, force: false });
  } catch {
    throw new ClaudeAgentSdkProtocolError(
      'claude_sdk_config_cleanup_failed',
      'Claude SDK config directory cleanup failed',
    );
  }
}

/** Constructs the locked-down SDK option baseline; the transport adds only callbacks/session IDs. */
export function buildClaudeSdkOptions(input: ClaudeSdkOptionsInput): Options {
  const configDir = resolveClaudeSdkConfigDir(input.daemonConfigRoot, input.sessionId);
  const tools = input.trustState === 'trusted' ? [...TRUSTED_TOOLS] : [...UNTRUSTED_TOOLS];

  return {
    cwd: input.cwd,
    env: buildClaudeSdkEnvironment(input.env, input.auth, configDir),
    tools,
    disallowedTools: ['Bash', 'Agent', 'Skill', 'WebFetch', 'WebSearch'],
    ...(input.canUseTool ? { canUseTool: input.canUseTool } : {}),
    ...(input.model ? { model: input.model } : {}),
    permissionMode: 'default',
    persistSession: false,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
    skills: [],
    agents: {},
    hooks: {},
  };
}
