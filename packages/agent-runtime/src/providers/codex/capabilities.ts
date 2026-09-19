import type { ProviderCapabilities } from '@agent-dock/shared';

/**
 * What this adapter actually implements for Codex, see the parser and adapter.ts for the
 * behavior each of these reflects.
 *
 * - resume: `codex exec resume <providerSessionId> -` (adapter.ts); the prompt itself is delivered
 *   over stdin for both fresh and resumed sessions, never as an argv element (build-args.ts)
 * - cancellation: shared runProviderSession() process-tree kill (providers/common/run-session.ts)
 * - tools: `command_execution`/`file_change`/`mcp_tool_call` items normalize to
 *   tool.started/tool.completed (parser.ts)
 * - usage: `turn.completed.usage` normalizes to a `usage` event (parser.ts)
 * - thinking: `reasoning` items normalize to thinking.delta (parser.ts); only present when Codex's
 *   own reasoning-effort/model configuration surfaces them; absent otherwise
 * - attachments: `StartSessionOptions.attachments` delivered as `-i/--image <path>` argv, one flag
 *   per attachment (build-args.ts) -- the prompt itself keeps going over stdin unchanged, since
 *   this flag takes a real local file path directly, not inline content.
 */
export const CODEX_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
  attachments: true,
};

/**
 * MIME types this adapter's attachment delivery (`-i/--image <path>`) accepts.
 *
 * Verification status (2026-09-19, codex-cli 0.147.0, `codex exec -i/--image <path>`):
 * - `application/pdf` was directly tested end-to-end against the real CLI -- a small real PDF was
 *   attached via this flag, and Codex correctly read its content back, despite the flag's name.
 * - `image/png` and `image/jpeg` are NOT independently tested here; they're listed because the
 *   flag's own `--help` text ("Optional image(s) to attach to the initial prompt") documents its
 *   purpose as image attachment. Re-verify against the pinned CLI version before relying on them
 *   for anything security- or correctness-sensitive, per this repo's policy of not guessing CLI
 *   behavior.
 */
export const CODEX_ATTACHMENT_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
