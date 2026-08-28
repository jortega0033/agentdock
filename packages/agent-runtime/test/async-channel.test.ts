import { describe, expect, it } from 'vitest';
import { AsyncChannel } from '../src/process/async-channel.js';

async function drain<T>(channel: AsyncChannel<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of channel) out.push(value);
  return out;
}

describe('AsyncChannel', () => {
  it('delivers items pushed before iteration starts', async () => {
    const channel = new AsyncChannel<number>();
    channel.push(1);
    channel.push(2);
    channel.close();
    expect(await drain(channel)).toEqual([1, 2]);
  });

  it('delivers items pushed after iteration has started', async () => {
    const channel = new AsyncChannel<number>();
    const resultPromise = drain(channel);
    channel.push(1);
    await new Promise((r) => setTimeout(r, 5));
    channel.push(2);
    channel.close();
    expect(await resultPromise).toEqual([1, 2]);
  });

  it('ignores pushes after close', async () => {
    const channel = new AsyncChannel<number>();
    channel.push(1);
    channel.close();
    channel.push(2);
    expect(await drain(channel)).toEqual([1]);
  });

  it('closes itself once the buffer overflows, without throwing', async () => {
    const channel = new AsyncChannel<number>(3);
    for (let i = 0; i < 10; i++) channel.push(i);
    const result = await drain(channel);
    expect(result.length).toBeLessThanOrEqual(3);
    expect(channel.didOverflow).toBe(true);
  });
});
