import type { AgentEventV2Envelope, AgentSessionV2 } from '@agent-dock/shared';
import type {
  RendererInteraction,
  RendererInteractionResolution,
} from '../electron/interaction-broker.js';
import {
  activityHistoryReducer,
  createActivityHistoryState,
  type ActivityHistoryState,
} from './components/activity/history.js';
import type { TimelineEventInput } from './components/activity/types.js';

export type RunStatus =
  'idle' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface SessionWorkspaceEntry {
  readonly session: AgentSessionV2;
  readonly activity: ActivityHistoryState;
  readonly interactions: readonly RendererInteraction[];
  readonly lastSequence?: number;
  readonly unread: number;
  readonly archived: boolean;
  readonly streamError?: string;
}

export interface SessionWorkspaceState {
  readonly entries: Readonly<Record<string, SessionWorkspaceEntry>>;
  readonly order: readonly string[];
  readonly selectedSessionId?: string;
}

export interface SessionWorkspacePreferences {
  readonly selectedSessionId?: string;
  readonly unreadBySession: Readonly<Record<string, number>>;
  readonly archivedSessionIds: readonly string[];
}

export type SessionWorkspaceAction =
  | {
      type: 'hydrate';
      sessions: readonly AgentSessionV2[];
      preferences?: SessionWorkspacePreferences;
    }
  | { type: 'upsert'; session: AgentSessionV2; select?: boolean }
  | { type: 'select'; sessionId: string }
  | { type: 'replace_history'; sessionId: string; events: readonly AgentEventV2Envelope[] }
  | { type: 'append_event'; event: AgentEventV2Envelope }
  | { type: 'replay_reset'; session: AgentSessionV2 }
  | {
      type: 'interaction_requested';
      sessionId: string;
      interaction: RendererInteraction;
      timelineEvent: TimelineEventInput;
    }
  | {
      type: 'interaction_resolved';
      sessionId: string;
      resolution: RendererInteractionResolution;
      timelineEvent?: TimelineEventInput;
    }
  | { type: 'remove_interaction'; sessionId: string; interactionHandle: string }
  | { type: 'stream_error'; sessionId: string; message: string }
  | { type: 'toggle_archive'; sessionId: string }
  | { type: 'delete'; sessionId: string };

export function createSessionWorkspaceState(): SessionWorkspaceState {
  return { entries: {}, order: [] };
}

export function sessionWorkspaceReducer(
  state: SessionWorkspaceState,
  action: SessionWorkspaceAction,
): SessionWorkspaceState {
  switch (action.type) {
    case 'hydrate':
      return hydrateSessions(state, action.sessions, action.preferences);
    case 'upsert':
      return upsertSession(state, action.session, action.select === true);
    case 'select': {
      const entry = state.entries[action.sessionId];
      if (!entry) return state;
      return {
        ...state,
        selectedSessionId: action.sessionId,
        entries: { ...state.entries, [action.sessionId]: { ...entry, unread: 0 } },
      };
    }
    case 'replace_history': {
      const entry = state.entries[action.sessionId];
      if (!entry) return state;
      const currentEvents = entry.activity.events.filter(isAgentEvent);
      const merged = dedupeEvents([...action.events, ...currentEvents]);
      return replaceEntry(state, action.sessionId, {
        ...entry,
        activity: createActivityHistoryState(entry.activity.maxEvents, merged),
        lastSequence: merged.at(-1)?.sequence,
      });
    }
    case 'append_event': {
      const entry = state.entries[action.event.sessionId];
      if (
        !entry ||
        (entry.lastSequence !== undefined && action.event.sequence <= entry.lastSequence)
      ) {
        return state;
      }
      const terminal = terminalStatus(action.event);
      const session: AgentSessionV2 = terminal
        ? { ...entry.session, status: terminal }
        : action.event.type === 'session.status'
          ? { ...entry.session, status: action.event.status }
          : entry.session;
      return replaceEntry(state, action.event.sessionId, {
        ...entry,
        session,
        activity: activityHistoryReducer(entry.activity, { type: 'append', event: action.event }),
        lastSequence: action.event.sequence,
        unread: state.selectedSessionId === action.event.sessionId ? 0 : entry.unread + 1,
        streamError: undefined,
      });
    }
    case 'replay_reset': {
      const entry = state.entries[action.session.id];
      if (!entry) return upsertSession(state, action.session, false);
      return replaceEntry(state, action.session.id, { ...entry, session: action.session });
    }
    case 'interaction_requested': {
      const sessionId = action.sessionId;
      const entry = state.entries[sessionId];
      if (!entry) return state;
      return replaceEntry(state, sessionId, {
        ...entry,
        interactions: [...entry.interactions, action.interaction],
        activity: activityHistoryReducer(entry.activity, {
          type: 'append',
          event: action.timelineEvent,
        }),
        unread: state.selectedSessionId === sessionId ? 0 : entry.unread + 1,
      });
    }
    case 'interaction_resolved': {
      const sessionId = action.sessionId;
      const entry = state.entries[sessionId];
      if (!entry) return state;
      const next = {
        ...entry,
        interactions: entry.interactions.filter(
          (item) => item.interactionHandle !== action.resolution.interactionHandle,
        ),
      };
      return replaceEntry(
        state,
        sessionId,
        action.timelineEvent
          ? {
              ...next,
              activity: activityHistoryReducer(entry.activity, {
                type: 'append',
                event: action.timelineEvent,
              }),
            }
          : next,
      );
    }
    case 'remove_interaction': {
      const entry = state.entries[action.sessionId];
      if (!entry) return state;
      return replaceEntry(state, action.sessionId, {
        ...entry,
        interactions: entry.interactions.filter(
          (item) => item.interactionHandle !== action.interactionHandle,
        ),
      });
    }
    case 'stream_error': {
      const entry = state.entries[action.sessionId];
      return entry
        ? replaceEntry(state, action.sessionId, { ...entry, streamError: action.message })
        : state;
    }
    case 'toggle_archive': {
      const entry = state.entries[action.sessionId];
      return entry
        ? replaceEntry(state, action.sessionId, { ...entry, archived: !entry.archived })
        : state;
    }
    case 'delete': {
      if (!state.entries[action.sessionId]) return state;
      const entries = { ...state.entries };
      delete entries[action.sessionId];
      const order = state.order.filter((id) => id !== action.sessionId);
      return {
        entries,
        order,
        selectedSessionId:
          state.selectedSessionId === action.sessionId ? order[0] : state.selectedSessionId,
      };
    }
  }
}

export function projectedSessionStatus(status: AgentSessionV2['status']): RunStatus {
  return status === 'starting' || status === 'active' || status === 'idle' ? 'running' : status;
}

export function sessionWorkspacePreferences(
  state: SessionWorkspaceState,
): SessionWorkspacePreferences {
  const unreadBySession: Record<string, number> = {};
  const archivedSessionIds: string[] = [];
  for (const [sessionId, entry] of Object.entries(state.entries)) {
    if (entry.unread > 0) unreadBySession[sessionId] = entry.unread;
    if (entry.archived) archivedSessionIds.push(sessionId);
  }
  return {
    ...(state.selectedSessionId === undefined
      ? {}
      : { selectedSessionId: state.selectedSessionId }),
    unreadBySession,
    archivedSessionIds,
  };
}

function hydrateSessions(
  state: SessionWorkspaceState,
  sessions: readonly AgentSessionV2[],
  preferences?: SessionWorkspacePreferences,
): SessionWorkspaceState {
  const archived = new Set(preferences?.archivedSessionIds ?? []);
  const entries = { ...state.entries };
  for (const session of sessions) {
    const current = entries[session.id];
    entries[session.id] = current
      ? { ...current, session }
      : {
          session,
          activity: createActivityHistoryState(),
          interactions: [],
          unread: Math.max(0, Math.floor(preferences?.unreadBySession[session.id] ?? 0)),
          archived: archived.has(session.id),
        };
  }
  const order = [...sessions]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .map((session) => session.id);
  const preferred = preferences?.selectedSessionId;
  const selectedSessionId =
    (preferred && entries[preferred] ? preferred : state.selectedSessionId) ?? order[0];
  if (selectedSessionId && entries[selectedSessionId]) {
    entries[selectedSessionId] = { ...entries[selectedSessionId], unread: 0 };
  }
  return { entries, order, ...(selectedSessionId ? { selectedSessionId } : {}) };
}

function upsertSession(
  state: SessionWorkspaceState,
  session: AgentSessionV2,
  select: boolean,
): SessionWorkspaceState {
  const current = state.entries[session.id];
  const entry: SessionWorkspaceEntry = current
    ? { ...current, session }
    : {
        session,
        activity: createActivityHistoryState(),
        interactions: [],
        unread: 0,
        archived: false,
      };
  const selectedSessionId = select ? session.id : (state.selectedSessionId ?? session.id);
  return {
    entries: { ...state.entries, [session.id]: entry },
    order: [session.id, ...state.order.filter((id) => id !== session.id)],
    selectedSessionId,
  };
}

function replaceEntry(
  state: SessionWorkspaceState,
  sessionId: string,
  entry: SessionWorkspaceEntry,
): SessionWorkspaceState {
  return { ...state, entries: { ...state.entries, [sessionId]: entry } };
}

function terminalStatus(event: AgentEventV2Envelope): AgentSessionV2['status'] | undefined {
  if (event.type === 'session.completed') return 'completed';
  if (event.type === 'session.failed') return 'failed';
  if (event.type === 'session.cancelled') return 'cancelled';
  if (event.type === 'session.interrupted') return 'interrupted';
  return undefined;
}

function isAgentEvent(event: TimelineEventInput): event is AgentEventV2Envelope {
  return (
    'sequence' in event &&
    typeof event.sequence === 'number' &&
    'sessionId' in event &&
    typeof event.sessionId === 'string'
  );
}

function dedupeEvents(events: readonly AgentEventV2Envelope[]): AgentEventV2Envelope[] {
  const bySequence = new Map<number, AgentEventV2Envelope>();
  for (const event of events) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}
