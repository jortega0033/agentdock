import { describe, expect, it } from 'vitest';
import { consumeSmokeStream } from '../../src/live-smoke/stream.js';

async function* iterableFrom(items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

// eslint-disable-next-line require-yield -- deliberately never yields, to simulate a real hang
async function* neverYields(): AsyncGenerator<unknown> {
  await new Promise(() => {});
}

describe('consumeSmokeStream', () => {
  it('succeeds with normalized content on exactly one terminal event', async () => {
    const outcome = await consumeSmokeStream(
      iterableFrom([
        { type: 'content.delta', delta: 'hello' },
        { type: 'session.completed' },
      ]),
      { timeoutMs: 5_000 },
    );
    expect(outcome).toEqual({ outcome: 'success', terminalType: 'session.completed', hasContent: true });
  });

  it('succeeds but reports no content when the terminal event carries no normalized text', async () => {
    const outcome = await consumeSmokeStream(iterableFrom([{ type: 'session.completed' }]), {
      timeoutMs: 5_000,
    });
    expect(outcome).toEqual({ outcome: 'success', terminalType: 'session.completed', hasContent: false });
  });

  it('cancellation/interruption terminal types also count as a valid single completion', async () => {
    const outcome = await consumeSmokeStream(iterableFrom([{ type: 'session.cancelled' }]), {
      timeoutMs: 5_000,
    });
    expect(outcome.outcome).toBe('success');
    if (outcome.outcome === 'success') expect(outcome.terminalType).toBe('session.cancelled');
  });

  it('flags a duplicate terminal event as a protocol violation', async () => {
    const outcome = await consumeSmokeStream(
      iterableFrom([{ type: 'session.completed' }, { type: 'session.completed' }]),
      { timeoutMs: 5_000 },
    );
    expect(outcome.outcome).toBe('protocol_violation');
    if (outcome.outcome === 'protocol_violation') expect(outcome.reason).toContain('second terminal');
  });

  it('flags an event with no recognizable type as a malformed-stream protocol violation', async () => {
    const outcome = await consumeSmokeStream(iterableFrom([{ notAnEvent: true }]), {
      timeoutMs: 5_000,
    });
    expect(outcome.outcome).toBe('protocol_violation');
    if (outcome.outcome === 'protocol_violation') expect(outcome.reason).toContain('type');
  });

  it('flags a stream that ends without ever reaching a terminal event', async () => {
    const outcome = await consumeSmokeStream(iterableFrom([{ type: 'content.delta', delta: 'x' }]), {
      timeoutMs: 5_000,
    });
    expect(outcome.outcome).toBe('protocol_violation');
    if (outcome.outcome === 'protocol_violation') expect(outcome.reason).toContain('terminal');
  });

  it('times out distinctly from a protocol violation when the stream hangs', async () => {
    const outcome = await consumeSmokeStream(neverYields(), { timeoutMs: 25 });
    expect(outcome).toEqual({ outcome: 'timeout' });
  });

  it('calls onEvent for every event before classifying it', async () => {
    const seen: unknown[] = [];
    await consumeSmokeStream(iterableFrom([{ type: 'content.delta', delta: 'x' }, { type: 'session.completed' }]), {
      timeoutMs: 5_000,
      onEvent: (event) => {
        seen.push(event);
      },
    });
    expect(seen).toHaveLength(2);
  });
});
