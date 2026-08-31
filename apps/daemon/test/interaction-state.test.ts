import { describe, expect, it, vi } from 'vitest';
import {
  InteractionState,
  type MonotonicScheduler,
  type PendingInteraction,
} from '../src/interaction-state.js';

class FakeScheduler implements MonotonicScheduler {
  current = 10_000;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  private nextId = 1;

  now(): number {
    return this.current;
  }

  set(delayMs: number, callback: () => void): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id;
  }

  clear(timer: unknown): void {
    this.timers.delete(timer as number);
  }

  advance(delayMs: number): void {
    this.current += delayMs;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.current) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

function approval(requestId = 'request-1'): PendingInteraction {
  return {
    requestId,
    turnId: 'turn-1',
    kind: 'approval',
    state: 'unpublished',
  };
}

describe('InteractionState', () => {
  it('does not arm a timeout until successful responder publication', () => {
    const scheduler = new FakeScheduler();
    const expired = vi.fn();
    const state = new InteractionState(expired, scheduler);
    expect(state.register(approval())).toBe(true);

    scheduler.advance(900_000);
    expect(expired).not.toHaveBeenCalled();
    expect(state.markPublished('request-1')).toBe(true);
    scheduler.advance(299_999);
    expect(expired).not.toHaveBeenCalled();
    scheduler.advance(1);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('uses captured provider budget without consulting wall time again', () => {
    const scheduler = new FakeScheduler();
    const expired = vi.fn();
    const state = new InteractionState(expired, scheduler);
    state.register({ ...approval(), providerRemainingMs: 2_000 });
    state.markPublished('request-1');

    scheduler.advance(1_999);
    expect(expired).not.toHaveBeenCalled();
    scheduler.advance(1);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('allows exactly one race winner and validates the full interaction tuple', () => {
    const scheduler = new FakeScheduler();
    const state = new InteractionState(vi.fn(), scheduler);
    state.register(approval());
    state.markPublished('request-1');

    expect(state.claim('request-1', { turnId: 'other-turn', kind: 'approval' })).toBeUndefined();
    expect(state.claim('request-1', { turnId: 'turn-1', kind: 'question' })).toBeUndefined();
    expect(state.claim('request-1', { turnId: 'turn-1', kind: 'approval' })?.state).toBe(
      'resolving',
    );
    expect(state.claim('request-1')).toBeUndefined();
    expect(state.settle('request-1')).toBe(true);
  });

  it('rejects duplicate IDs and claims each pending request once during shutdown', () => {
    const state = new InteractionState(vi.fn(), new FakeScheduler());
    expect(state.register(approval('one'))).toBe(true);
    expect(state.register(approval('one'))).toBe(false);
    expect(state.register({ requestId: 'two', turnId: 'turn-1', kind: 'question' })).toBe(true);

    expect(state.claimAll().map((record) => record.requestId)).toEqual(['one', 'two']);
    expect(state.claimAll()).toEqual([]);
  });
});
