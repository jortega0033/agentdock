import type { ProviderCapabilities } from '@agent-dock/shared';

/**
 * What this adapter actually implements for Codex, see the parser and adapter.ts for the
 * behavior each of these reflects.
 *
 * - resume: `codex exec resume <providerSessionId> <prompt>` (adapter.ts)
 * - cancellation: shared runProviderSession() process-tree kill (providers/common/run-session.ts)
 * - tools: `command_execution`/`file_change`/`mcp_tool_call` items normalize to
 *   tool.started/tool.completed (parser.ts)
 * - usage: `turn.completed.usage` normalizes to a `usage` event (parser.ts)
 * - thinking: `reasoning` items normalize to thinking.delta (parser.ts); only present when Codex's
 *   own reasoning-effort/model configuration surfaces them; absent otherwise
 */
export const CODEX_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
};
