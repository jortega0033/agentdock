import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SESSION_ATTACHMENT_BYTES } from '../src/providers/common/attachment-limits.js';
import {
  buildClaudeStdinPayload,
  buildClaudeStreamJsonStdinPayload,
} from '../src/providers/claude/stdin-payload.js';

describe('buildClaudeStdinPayload (issue #152)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-attach-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the raw prompt, unchanged, when there are no attachments', () => {
    const prompt = 'plain prompt, no attachments, must be byte-for-byte identical to before #152';
    expect(buildClaudeStdinPayload({ sessionId: 's', cwd: '/tmp', prompt })).toBe(prompt);
    expect(buildClaudeStdinPayload({ sessionId: 's', cwd: '/tmp', prompt, attachments: [] })).toBe(prompt);
  });

  it('builds a stream-json user message with a text block and a document block for a PDF', () => {
    const pdfPath = join(dir, 'cv.pdf');
    writeFileSync(pdfPath, Buffer.from('%PDF-1.4 fake pdf bytes'));
    const payload = buildClaudeStdinPayload({
      sessionId: 's',
      cwd: '/tmp',
      prompt: 'transcribe this CV',
      attachments: [{ path: pdfPath, mimeType: 'application/pdf' }],
    });
    expect(payload.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(payload.trim());
    expect(parsed).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'transcribe this CV' },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: Buffer.from('%PDF-1.4 fake pdf bytes').toString('base64'),
            },
          },
        ],
      },
    });
  });

  it('builds an image content block (not document) for an image MIME type', () => {
    const imgPath = join(dir, 'scan.png');
    writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const payload = buildClaudeStreamJsonStdinPayload({
      sessionId: 's',
      cwd: '/tmp',
      prompt: 'read this',
      attachments: [{ path: imgPath, mimeType: 'image/png' }],
    });
    const parsed = JSON.parse(payload.trim());
    expect(parsed.message.content[1].type).toBe('image');
    expect(parsed.message.content[1].source.media_type).toBe('image/png');
  });

  it('throws for a MIME type this adapter has no delivery mechanism for', () => {
    const filePath = join(dir, 'file.exe');
    writeFileSync(filePath, Buffer.from('x'));
    expect(() =>
      buildClaudeStreamJsonStdinPayload({
        sessionId: 's',
        cwd: '/tmp',
        prompt: 'p',
        attachments: [{ path: filePath, mimeType: 'application/x-msdownload' }],
      }),
    ).toThrow(/does not support MIME type/);
  });

  it('throws when the attachment file cannot be read', () => {
    expect(() =>
      buildClaudeStreamJsonStdinPayload({
        sessionId: 's',
        cwd: '/tmp',
        prompt: 'p',
        attachments: [{ path: join(dir, 'does-not-exist.pdf'), mimeType: 'application/pdf' }],
      }),
    ).toThrow(/could not read claude attachment/);
  });

  it('throws when the attachment exceeds the byte bound, without reading the whole file into the error message', () => {
    const bigPath = join(dir, 'big.pdf');
    writeFileSync(bigPath, Buffer.alloc(MAX_SESSION_ATTACHMENT_BYTES + 1, 1));
    expect(() =>
      buildClaudeStreamJsonStdinPayload({
        sessionId: 's',
        cwd: '/tmp',
        prompt: 'p',
        attachments: [{ path: bigPath, mimeType: 'application/pdf' }],
      }),
    ).toThrow(/over the .* byte limit/);
  });

  it('never lets the attachment content or prompt leak into the thrown error for an unsupported MIME type', () => {
    const filePath = join(dir, 'secret.exe');
    writeFileSync(filePath, Buffer.from('super secret binary content'));
    try {
      buildClaudeStreamJsonStdinPayload({
        sessionId: 's',
        cwd: '/tmp',
        prompt: 'p',
        attachments: [{ path: filePath, mimeType: 'application/x-msdownload' }],
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('super secret binary content');
    }
  });
});
