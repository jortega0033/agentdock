import { readFileSync } from 'node:fs';
import type { StartSessionOptions } from '../../types.js';
import { CLAUDE_ATTACHMENT_MIME_TYPES } from './capabilities.js';

/**
 * A CV or similar document is a handful of pages; this bounds what this adapter will ever read
 * into memory and base64-encode for a single attachment, independent of whatever bound the daemon
 * route enforces before a file even reaches here (belt and suspenders, not a substitute for it).
 */
export const MAX_CLAUDE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function contentBlockType(mimeType: string): 'document' | 'image' {
  return mimeType === 'application/pdf' ? 'document' : 'image';
}

/**
 * Builds the `claude -p --input-format stream-json` stdin payload: a single JSON line containing
 * one user message whose `content` array holds the prompt as a `text` block followed by one
 * Anthropic Messages-API-shaped `document`/`image` block per attachment (empirically verified
 * against the real CLI, see capabilities.ts). Reads and base64-encodes each attachment file
 * synchronously -- this runs once, before the child process spawns, on files already bounded by
 * the daemon route's own size check.
 *
 * Throws if an attachment's MIME type isn't one this adapter has a delivery mechanism for, or if
 * the file can't be read or exceeds `MAX_CLAUDE_ATTACHMENT_BYTES` -- the caller (adapter.ts) must
 * only reach this function when `options.attachments` is non-empty, so a throw here means a
 * genuinely bad attachment, not an absent one.
 */
export function buildClaudeStreamJsonStdinPayload(options: StartSessionOptions): string {
  const attachments = options.attachments ?? [];
  const content: unknown[] = [{ type: 'text', text: options.prompt }];

  for (const attachment of attachments) {
    if (!(CLAUDE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(attachment.mimeType)) {
      throw new Error(
        `claude attachment delivery does not support MIME type "${attachment.mimeType}"`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(attachment.path);
    } catch (error) {
      throw new Error(
        `could not read claude attachment "${attachment.path}": ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
        { cause: error },
      );
    }
    if (bytes.byteLength > MAX_CLAUDE_ATTACHMENT_BYTES) {
      throw new Error(
        `claude attachment "${attachment.path}" is ${bytes.byteLength} bytes, over the ${MAX_CLAUDE_ATTACHMENT_BYTES} byte limit`,
      );
    }
    content.push({
      type: contentBlockType(attachment.mimeType),
      source: {
        type: 'base64',
        media_type: attachment.mimeType,
        data: bytes.toString('base64'),
      },
    });
  }

  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

/**
 * Whichever stdin payload this session should actually get: the raw prompt (today's exact
 * behavior, `--input-format text`) when there are no attachments, or the stream-json envelope
 * above when there are. `buildClaudeArgs` and this function must always agree on which mode is in
 * effect for the same `options` -- see build-args.ts.
 */
export function buildClaudeStdinPayload(options: StartSessionOptions): string {
  return options.attachments?.length
    ? buildClaudeStreamJsonStdinPayload(options)
    : options.prompt;
}
