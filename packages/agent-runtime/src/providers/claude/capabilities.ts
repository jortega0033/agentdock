import type { ProviderCapabilities } from '@agent-dock/shared';

/**
 * What this adapter actually implements for Claude Code, see the parser and adapter.ts for the
 * behavior each of these reflects, not an assumption about what the model can do.
 *
 * - resume: `--resume <providerSessionId>` (adapter.ts)
 * - cancellation: shared runProviderSession() process-tree kill (providers/common/run-session.ts)
 * - tools: `tool_use`/`tool_result` content blocks normalize to tool.started/tool.completed (parser.ts)
 * - usage: `message.usage` and the final `result` event's usage normalize to `usage` events (parser.ts)
 * - thinking: `thinking` content blocks normalize to thinking.delta (parser.ts); only present when
 *   the CLI itself surfaces extended-thinking output; absent otherwise, which is fine, since this
 *   capability means "the adapter passes it through when the CLI provides it", not "always present"
 * - attachments: `StartSessionOptions.attachments` delivered as an Anthropic Messages-API-shaped
 *   `document`/`image` content block via `claude -p --input-format stream-json` (build-args.ts,
 *   stdin-payload.ts). Absent when there are no attachments, which keeps `--input-format text` and
 *   the raw-prompt stdin write exactly as before this capability existed (see build-args.ts).
 */
export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
  attachments: true,
};

/**
 * MIME types this adapter's attachment delivery (stdin-payload.ts) accepts, each mapped to the
 * Anthropic Messages-API content-block `type` it's sent as. This is a capability list, not a
 * validation function -- see `schemas.ts`'s route-level validation for where it's actually
 * enforced.
 *
 * Verification status (2026-09-19, claude Code CLI 2.1.228, `--input-format stream-json`):
 * - `application/pdf` (as a `document` block) and `image/png` (as an `image` block) were directly
 *   tested end-to-end against the real CLI -- a small real PDF and PNG were each attached, and the
 *   model correctly read their content back.
 * - `image/jpeg`, `image/gif`, and `image/webp` are NOT independently tested here; they're listed
 *   because Anthropic's Messages API documents them as accepted `image` content-block MIME types,
 *   and Claude Code's stream-json input format uses the same content-block shape. Re-verify against
 *   the pinned CLI version before relying on them for anything security- or correctness-sensitive,
 *   per this repo's policy of not guessing CLI/API behavior.
 */
export const CLAUDE_ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;
