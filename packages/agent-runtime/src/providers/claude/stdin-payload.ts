import { readFileSync, statSync } from 'node:fs';
import type { StartSessionOptions } from '../../types.js';
import { MAX_SESSION_ATTACHMENT_BYTES } from '../common/attachment-limits.js';
import { CLAUDE_ATTACHMENT_MIME_TYPES } from './capabilities.js';

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
 * the file can't be read or exceeds `MAX_SESSION_ATTACHMENT_BYTES` -- the caller (adapter.ts) must
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
    // Checked from the directory entry before reading the whole file into memory: the daemon
    // route already enforces this same bound pre-dispatch, but re-checking the declared size
    // first here (not just after a full readFileSync) avoids fully materializing a
    // pathologically large file just to then discard it.
    let declaredSize: number;
    try {
      declaredSize = statSync(attachment.path).size;
    } catch (error) {
      throw new Error(
        `could not read claude attachment "${attachment.path}": ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
        { cause: error },
      );
    }
    if (declaredSize > MAX_SESSION_ATTACHMENT_BYTES) {
      throw new Error(
        `claude attachment "${attachment.path}" is ${declaredSize} bytes, over the ${MAX_SESSION_ATTACHMENT_BYTES} byte limit`,
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
    if (bytes.byteLength > MAX_SESSION_ATTACHMENT_BYTES) {
      // The file grew between the stat above and this read (TOCTOU) -- re-checked against what
      // was actually read, the same discipline this app's own CV-upload path already follows.
      throw new Error(
        `claude attachment "${attachment.path}" is ${bytes.byteLength} bytes, over the ${MAX_SESSION_ATTACHMENT_BYTES} byte limit`,
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
