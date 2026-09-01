import { describe, expect, it } from 'vitest';
import type { AgentEventV2Envelope, AgentSessionV2 } from '@agent-dock/shared';
import {
  createSessionWorkspaceState,
  sessionWorkspacePreferences,
  sessionWorkspaceReducer,
} from '../src/session-workspace.js';

const sessionIds = [
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
] as const;
const executionIds = [
  '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000002',
  '60000000-0000-4000-8000-000000000003',
] as const;
const turnId = '70000000-0000-4000-8000-000000000001';
const contentBlockId = '80000000-0000-4000-8000-000000000001';

describe('sessionWorkspaceReducer', () => {
  it('keeps three concurrent event streams isolated and marks only background sessions unread', () => {
    let state = sessionWorkspaceReducer(createSessionWorkspaceState(), {
      type: 'hydrate',
      sessions: sessionIds.map((id, index) => session(id, executionIds[index]!, index)),
      preferences: {
        selectedSessionId: sessionIds[0],
        unreadBySession: {},
        archivedSessionIds: [],
      },
    });

    state = sessionWorkspaceReducer(state, {
      type: 'append_event',
      event: contentEvent(sessionIds[1], executionIds[1], 0, 'second session'),
    });
    state = sessionWorkspaceReducer(state, {
      type: 'append_event',
      event: contentEvent(sessionIds[2], executionIds[2], 0, 'third session'),
    });

    expect(state.entries[sessionIds[0]]!.activity.events).toHaveLength(0);
    expect(state.entries[sessionIds[1]]!.activity.events).toHaveLength(1);
    expect(state.entries[sessionIds[2]]!.activity.events).toHaveLength(1);
    expect(state.entries[sessionIds[1]]!.unread).toBe(1);
    expect(state.entries[sessionIds[2]]!.unread).toBe(1);

    state = sessionWorkspaceReducer(state, { type: 'select', sessionId: sessionIds[1] });
    expect(state.entries[sessionIds[1]]!.unread).toBe(0);
    expect(JSON.stringify(state.entries[sessionIds[1]]!.activity.events)).toContain(
      'second session',
    );
    expect(JSON.stringify(state.entries[sessionIds[1]]!.activity.events)).not.toContain(
      'third session',
    );
  });

  it('merges restored history with live events by sequence without duplicates', () => {
    const snapshot = session(sessionIds[0], executionIds[0], 0);
    let state = sessionWorkspaceReducer(createSessionWorkspaceState(), {
      type: 'hydrate',
      sessions: [snapshot],
    });
    const first = contentEvent(sessionIds[0], executionIds[0], 0, 'restored');
    const second = contentEvent(sessionIds[0], executionIds[0], 1, 'live');
    state = sessionWorkspaceReducer(state, {
      type: 'replace_history',
      sessionId: sessionIds[0],
      events: [first],
    });
    state = sessionWorkspaceReducer(state, { type: 'append_event', event: first });
    state = sessionWorkspaceReducer(state, { type: 'append_event', event: second });

    expect(state.entries[sessionIds[0]]!.activity.events).toHaveLength(2);
    expect(state.entries[sessionIds[0]]!.lastSequence).toBe(1);
  });

  it('restores selected, unread, and archive preferences independently of session content', () => {
    const sessions = sessionIds.map((id, index) => session(id, executionIds[index]!, index));
    const state = sessionWorkspaceReducer(createSessionWorkspaceState(), {
      type: 'hydrate',
      sessions,
      preferences: {
        selectedSessionId: sessionIds[1],
        unreadBySession: { [sessionIds[0]]: 4, [sessionIds[1]]: 7 },
        archivedSessionIds: [sessionIds[2]],
      },
    });

    expect(state.selectedSessionId).toBe(sessionIds[1]);
    expect(state.entries[sessionIds[0]]!.unread).toBe(4);
    expect(state.entries[sessionIds[1]]!.unread).toBe(0);
    expect(state.entries[sessionIds[2]]!.archived).toBe(true);
    expect(sessionWorkspacePreferences(state)).toEqual({
      selectedSessionId: sessionIds[1],
      unreadBySession: { [sessionIds[0]]: 4 },
      archivedSessionIds: [sessionIds[2]],
    });
  });
});

function session(id: string, executionId: string, index: number): AgentSessionV2 {
  return {
    id,
    provider: 'claude',
    transport: 'fake-interactive',
    cwd: `C:\\workspace\\${index}`,
    status: 'active',
    selection: {
      transport: 'fake-interactive',
      enabled: [],
      unavailableOptional: [],
      possibleEffects: [],
      effectsComplete: true,
    },
    executionId,
    currentTurnId: turnId,
    acceptedWork: 'accepted',
    startedAt: `2026-09-01T00:00:0${index}.000Z`,
    earliestSequence: 0,
  };
}

function contentEvent(
  sessionId: string,
  executionId: string,
  sequence: number,
  delta: string,
): AgentEventV2Envelope {
  return {
    type: 'content.delta',
    sessionId,
    executionId,
    turnId,
    contentBlockId,
    sequence,
    timestamp: '2026-09-01T00:00:00.000Z',
    delta,
  };
}
