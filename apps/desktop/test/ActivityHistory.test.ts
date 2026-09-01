import { describe, expect, it } from 'vitest';
import {
  activityHistoryReducer,
  createActivityHistoryState,
} from '../src/components/activity/history.js';

const event = (id: number) => ({ type: 'vendor.event', id });

describe('activityHistoryReducer', () => {
  it('retains arrival order and counts every event omitted by the bound', () => {
    let state = createActivityHistoryState(2);

    for (let id = 1; id <= 5; id += 1) {
      state = activityHistoryReducer(state, { type: 'append', event: event(id) });
    }

    expect(state.events).toEqual([event(4), event(5)]);
    expect(state.omittedEventCount).toBe(3);
  });

  it('keeps omitted counts cumulative across multiple evictions', () => {
    let state = createActivityHistoryState(2, [event(1), event(2)]);
    state = activityHistoryReducer(state, { type: 'append', event: event(3) });
    state = activityHistoryReducer(state, { type: 'append', event: event(4) });

    expect(state.events).toEqual([event(3), event(4)]);
    expect(state.omittedEventCount).toBe(2);
  });

  it('starts a fresh bounded history on reset', () => {
    let state = createActivityHistoryState(2, [event(1), event(2), event(3)]);
    state = activityHistoryReducer(state, {
      type: 'reset',
      events: [event(8), event(9), event(10)],
    });

    expect(state.events).toEqual([event(9), event(10)]);
    expect(state.omittedEventCount).toBe(1);
    expect(state.maxEvents).toBe(2);
  });

  it('normalizes invalid limits and never creates an empty queue', () => {
    const state = createActivityHistoryState(0, [event(1), event(2)]);

    expect(state.maxEvents).toBe(1);
    expect(state.events).toEqual([event(2)]);
    expect(state.omittedEventCount).toBe(1);
  });
});
