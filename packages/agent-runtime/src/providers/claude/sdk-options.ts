import { isAbsolute, relative, resolve } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { buildClaudeSdkEnvironment, type ClaudeSdkAuthResolution } from './sdk-auth.js';

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
