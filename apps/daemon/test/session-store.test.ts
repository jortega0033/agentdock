import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@agent-dock/shared';
import { MemorySessionStore } from '../src/session-store.js';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    provider: 'claude',
    cwd: '/tmp',
    prompt: 'hi',
    status: 'starting',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('MemorySessionStore', () => {
  it('returns undefined for a session that was never created', () => {
    const store = new MemorySessionStore();
    expect(store.get('missing')).toBeUndefined();
  });

  it('creates and retrieves a session by id', () => {
    const store = new MemorySessionStore();
    const session = makeSession();
    store.create(session);
    expect(store.get('sess-1')).toEqual(session);
  });

  it('update replaces the stored record', () => {
    const store = new MemorySessionStore();
    store.create(makeSession({ status: 'starting' }));
    store.update('sess-1', makeSession({ status: 'completed', completedAt: '2026-01-01T00:00:00.000Z' }));
    expect(store.get('sess-1')?.status).toBe('completed');
  });

  it('update on an id that was never created still stores it (no separate "must exist" check)', () => {
    const store = new MemorySessionStore();
    store.update('sess-2', makeSession({ id: 'sess-2' }));
    expect(store.get('sess-2')?.id).toBe('sess-2');
  });

  it('create with a duplicate id overwrites the previous record (last write wins)', () => {
    const store = new MemorySessionStore();
    store.create(makeSession({ prompt: 'first' }));
    store.create(makeSession({ prompt: 'second' }));
    expect(store.get('sess-1')?.prompt).toBe('second');
    expect(store.list()).toHaveLength(1);
  });

  it('delete removes the record', () => {
    const store = new MemorySessionStore();
    store.create(makeSession());
    store.delete('sess-1');
    expect(store.get('sess-1')).toBeUndefined();
  });

  it('delete on a nonexistent id does not throw', () => {
    const store = new MemorySessionStore();
    expect(() => store.delete('never-existed')).not.toThrow();
  });

  it('list returns every stored session', () => {
    const store = new MemorySessionStore();
    store.create(makeSession({ id: 'a' }));
    store.create(makeSession({ id: 'b' }));
    expect(store.list().map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('list returns an empty array when nothing has been created', () => {
    expect(new MemorySessionStore().list()).toEqual([]);
  });
});
