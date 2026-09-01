/**
 * The Agent SDK is deliberately pinned: its stream/control protocol is fixture-backed rather
 * than treated as a semver-stable CLI implementation detail.  Update these constants, package
 * pins, fixtures, and packaged-asset smoke tests together.
 *
 * Distribution notice: Anthropic's current Agent SDK materials are governed by its Commercial
 * Terms, not an OSS licence.  Product UI may say "Claude Agent" (or "Claude" inside an Agents
 * menu), but must not present this integration as "Claude Code" or "Claude Code Agent".
 * See https://code.claude.com/docs/en/agent-sdk/overview before changing release packaging.
 */
export const CLAUDE_AGENT_SDK_VERSION = '0.3.251';
export const CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION = '2.1.251';
export const CLAUDE_AGENT_SDK_WINDOWS_X64_BINARY_PACKAGE =
  '@anthropic-ai/claude-agent-sdk-win32-x64';
export const CLAUDE_AGENT_SDK_WINDOWS_X64_BINARY_VERSION = CLAUDE_AGENT_SDK_VERSION;

/** A release-visible name, not the existing local-CLI provider display name. */
export const CLAUDE_AGENT_SDK_BRANDING = {
  approvedDisplayName: 'Claude Agent',
  prohibitedDisplayNames: ['Claude Code', 'Claude Code Agent'],
} as const;
