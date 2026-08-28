import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readLines } from '../src/process/line-reader.js';

async function collect(stream: Readable): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readLines(stream)) out.push(line);
  return out;
}

describe('readLines', () => {
  it('yields whole lines when chunks align with newlines', async () => {
    const stream = Readable.from(['{"a":1}\n{"b":2}\n']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('tolerates a single JSON line split across multiple chunks', async () => {
    const json = JSON.stringify({ hello: 'world', n: 42 });
    const mid = Math.floor(json.length / 2);
    const stream = Readable.from([json.slice(0, mid), json.slice(mid), '\n']);
    const lines = await collect(stream);
    expect(lines).toEqual([json]);
    expect(JSON.parse(lines[0]!)).toEqual({ hello: 'world', n: 42 });
  });

  it('tolerates multiple JSON lines arriving in a single chunk', async () => {
    const stream = Readable.from(['{"a":1}\n{"b":2}\n{"c":3}\n']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('yields a trailing line with no terminating newline', async () => {
    const stream = Readable.from(['{"a":1}\n{"b":2}']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('skips blank lines', async () => {
    const stream = Readable.from(['{"a":1}\n\n\n{"b":2}\n']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"b":2}']);
  });

});

async function collectBounded(stream: Readable, maxLineBytes: number): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readLines(stream, maxLineBytes)) out.push(line);
  return out;
}

describe('readLines with custom limit', () => {
  it('respects a custom maxLineBytes', async () => {
    const stream = Readable.from(['x'.repeat(50) + '\n']);
    await expect(collectBounded(stream, 10)).rejects.toThrow(/exceeded/);
  });
});
