import { MAX_ACTIVITY_TIMELINE_EVENTS } from './model.js';
import type { TimelineEventInput } from './types.js';

/** State kept by the renderer before projecting events into timeline cards. */
export interface ActivityHistoryState {
  readonly events: readonly TimelineEventInput[];
  readonly omittedEventCount: number;
  readonly maxEvents: number;
}

export type ActivityHistoryAction =
  | { readonly type: 'append'; readonly event: TimelineEventInput }
  | { readonly type: 'reset'; readonly events?: readonly TimelineEventInput[] };

export function createActivityHistoryState(
  maxEvents = MAX_ACTIVITY_TIMELINE_EVENTS,
  events: readonly TimelineEventInput[] = [],
): ActivityHistoryState {
  const limit = normalizeLimit(maxEvents);
  const retained = events.slice(-limit);
  return {
    events: retained,
    omittedEventCount: events.length - retained.length,
    maxEvents: limit,
  };
}

/**
 * Append events without allowing an unbounded renderer queue. Omitted counts
 * are cumulative until reset, including events evicted by later appends.
 */
export function activityHistoryReducer(
  state: ActivityHistoryState,
  action: ActivityHistoryAction,
): ActivityHistoryState {
  if (action.type === 'reset') {
    return createActivityHistoryState(state.maxEvents, action.events ?? []);
  }

  const events = [...state.events, action.event];
  if (events.length <= state.maxEvents) {
    return { ...state, events };
  }

  return {
    ...state,
    events: events.slice(-state.maxEvents),
    omittedEventCount: state.omittedEventCount + events.length - state.maxEvents,
  };
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return MAX_ACTIVITY_TIMELINE_EVENTS;
  return Math.max(1, Math.floor(value));
}
