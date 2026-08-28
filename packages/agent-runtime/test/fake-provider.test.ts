import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agent-dock/shared';
import { FakeProvider } from '../src/providers/fake/adapter.js';

async function collect(events: AsyncGenerator<AgentEvent, void, void>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('FakeProvider', () => {
  it('completes successfully by default', async () => {
    const provider = new FakeProvider('claude');
    const handle = provider.startSession({ sessionId: 's1', cwd: '/tmp', prompt: 'hi' });
    const events = await collect(handle.events);
    expect(events.at(-1)).toMatchObject({ type: 'session.completed' });
    expect(provider.startedOptions).toHaveLength(1);
  });

  it('fails when configured with the failure scenario', async () => {
    const provider = new FakeProvider('codex', undefined, 'failure');
    const handle = provider.startSession({ sessionId: 's2', cwd: '/tmp', prompt: 'hi' });
    const events = await collect(handle.events);
    expect(events.at(-1)).toMatchObject({ type: 'session.failed' });
  });

  it('hangs until cancelled', async () => {
    const provider = new FakeProvider('claude', undefined, 'hang-until-cancelled');
    const handle = provider.startSession({ sessionId: 's3', cwd: '/tmp', prompt: 'hi' });
    const iterator = handle.events;
    await iterator.next();
    await handle.cancel();
    const rest: AgentEvent[] = [];
    for await (const event of iterator) rest.push(event);
    expect(rest.at(-1)).toEqual({ type: 'session.cancelled' });
  });
});
