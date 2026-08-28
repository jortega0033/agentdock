import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readLines } from '../src/process/line-reader.js';

async function collect(stream: Readable): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readLines(stream)) out.push(line);
  return out;
}

describe('readLines UTF-8 chunk-boundary handling', () => {
  it('does not corrupt a multibyte emoji split exactly across two raw chunks', async () => {
    // Real assistant text containing an emoji ("hello 🎉 world") encoded as UTF-8, then split the
    // raw byte buffer in the middle of the 4-byte emoji sequence — exactly what a TCP/pipe chunk
    // boundary can do to output from a real CLI process.
    const line = JSON.stringify({ type: 'assistant.message', text: 'hello 🎉 world' });
    const bytes = Buffer.from(line + '\n', 'utf8');
    const emojiByteOffset = bytes.indexOf(Buffer.from('🎉', 'utf8'));
    const splitPoint = emojiByteOffset + 2; // inside the 4-byte emoji sequence

    async function* chunks() {
      yield bytes.subarray(0, splitPoint);
      yield bytes.subarray(splitPoint);
    }
    const stream = Readable.from(chunks());

    const lines = await collect(stream);
    expect(lines).toEqual([line]);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'assistant.message', text: 'hello 🎉 world' });
  });

  it('does not corrupt a multibyte character split across many single-byte chunks', async () => {
    const line = JSON.stringify({ text: '日本語のテスト' }); // multibyte CJK text
    const bytes = Buffer.from(line + '\n', 'utf8');

    async function* byteAtATime() {
      for (const byte of bytes) yield Buffer.from([byte]);
    }
    const stream = Readable.from(byteAtATime());

    const lines = await collect(stream);
    expect(lines).toEqual([line]);
  });
});
