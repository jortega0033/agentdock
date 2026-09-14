import { createHash } from 'node:crypto';
import { ATTACHMENT_LIMITS_V2 } from '@agent-dock/shared';
import type { RawToolOutputV2 } from '../../types.js';
import { boundedUtf8FromBytes } from './safe-display.js';

/**
 * Issue #132: bounding/hashing logic shared by every provider's raw-tool-output side channel --
 * originally written twice, near-identically, for Codex (packages/agent-runtime/src/providers/
 * codex/app-server/normalizer.ts) and Claude (.../claude/sdk/normalizer.ts), promoted here for the
 * same reuse reason `FailableChannel` was promoted to providers/common/channel.ts. Bounded to the
 * daemon attachment store's own per-file cap -- above that, the raw output is dropped at the source
 * rather than partially staged, leaving each provider's existing synthetic summary as the only
 * record (graceful degradation).
 */
export const MAX_RAW_TOOL_OUTPUT_BYTES = ATTACHMENT_LIMITS_V2.maxFileBytes;
export const RAW_TOOL_OUTPUT_PREVIEW_MAX_BYTES = 4_096;

export interface RawToolOutputIdentity {
  contentBlockId: string;
  toolCallId: string;
}

export interface RawToolOutputContent {
  mimeType: RawToolOutputV2['mimeType'];
  text: string;
}

/** Returns `undefined` both when there is nothing to capture and when real content exceeds the
 * attachment store's byte cap -- the caller's only obligation is to skip emitting in either case. */
export function buildRawToolOutput(
  content: RawToolOutputContent | undefined,
  identity: RawToolOutputIdentity,
): RawToolOutputV2 | undefined {
  if (!content) return undefined;
  // Encode once: the size-cap check and the preview both work from these bytes, rather than each
  // separately re-encoding the (potentially 25MB) source string from scratch.
  const bytes = Buffer.from(content.text, 'utf8');
  if (bytes.byteLength > MAX_RAW_TOOL_OUTPUT_BYTES) return undefined;
  return {
    contentBlockId: identity.contentBlockId,
    toolCallId: identity.toolCallId,
    mimeType: content.mimeType,
    bytes,
    preview: boundedUtf8FromBytes(bytes, RAW_TOOL_OUTPUT_PREVIEW_MAX_BYTES),
    previewTruncated: bytes.byteLength > RAW_TOOL_OUTPUT_PREVIEW_MAX_BYTES,
    byteCount: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
