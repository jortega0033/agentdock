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

  it('drops items and reports false once the buffer overflows, without auto-closing (AD-10)', () => {
    const channel = new AsyncChannel<number>(3);
    const accepted: boolean[] = [];
    for (let i = 0; i < 10; i++) accepted.push(channel.push(i));
    expect(accepted.slice(0, 3)).toEqual([true, true, true]);
    expect(accepted.slice(3)).toEqual([false, false, false, false, false, false, false]);
    expect(channel.push(11)).toBe(false); // still overflowed, still open, still refusing normal pushes
  });

  it('push() returns true for an accepted item and false once closed', async () => {
    const channel = new AsyncChannel<number>();
    expect(channel.push(1)).toBe(true);
    channel.close();
    expect(channel.push(2)).toBe(false);
    expect(await drain(channel)).toEqual([1]);
  });

  describe('closeWith', () => {
    it('delivers the given final values even though the channel already overflowed (AD-10)', async () => {
      const channel = new AsyncChannel<number>(3);
      for (let i = 0; i < 3; i++) channel.push(i); // fill to the cap
      expect(channel.push(3)).toBe(false); // confirm it's genuinely full first
      channel.closeWith([997, 998, 999]);
      expect(await drain(channel)).toEqual([0, 1, 2, 997, 998, 999]);
    });

    it('is the terminal step — nothing pushed after it is delivered', async () => {
      const channel = new AsyncChannel<number>();
      channel.push(1);
      channel.closeWith([2]);
      expect(channel.push(3)).toBe(false);
      expect(await drain(channel)).toEqual([1, 2]);
    });

    it('is a no-op if the channel is already closed', async () => {
      const channel = new AsyncChannel<number>();
      channel.push(1);
      channel.close();
      channel.closeWith([2]); // must not resurrect a closed channel
      expect(await drain(channel)).toEqual([1]);
    });
  });
});
