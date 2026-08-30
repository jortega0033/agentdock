import type { Readable } from 'node:stream';

const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;

/**
 * Reads a stream as newline-delimited text, tolerant of chunks that split a line across
 * boundaries and chunks that contain multiple lines. Throws if a single line grows past
 * `maxLineBytes` without a newline, as protection against an unbounded/malformed stream.
 *
 * Decodes with a single stateful `TextDecoder` across the whole stream rather than calling
 * `Buffer#toString('utf8')` per chunk: a multi-byte UTF-8 character (e.g. an emoji or CJK text)
 * can legitimately land split across two raw chunks, and decoding each chunk independently turns
 * the split character into U+FFFD replacement characters: silent data corruption in whatever the
 * CLI actually said. `{ stream: true }` tells the decoder to hold back a trailing incomplete
 * sequence and prepend it to the next chunk instead.
 */
export async function* readLines(
  stream: Readable,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
): AsyncGenerator<string, void, void> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk as Buffer, { stream: true });
    if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
      throw new Error(`line exceeded ${maxLineBytes} bytes without a newline`);
    }
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) yield line;
    }
  }
  buffer += decoder.decode(); // flush any trailing incomplete sequence (malformed at EOF, if any)
  const rest = buffer.replace(/\r$/, '').trim();
  if (rest.length > 0) yield rest;
}
