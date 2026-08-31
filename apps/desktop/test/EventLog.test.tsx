import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AgentEventV2Envelope } from '@agent-dock/shared';
import { EventLog } from '../src/components/EventLog.js';

describe('EventLog', () => {
  it('shows a placeholder when there are no events', () => {
    render(<EventLog events={[]} />);
    expect(screen.getByText(/no events yet/i)).toBeInTheDocument();
  });

  it('renders assistant messages, tool events, and errors without provider-specific logic', () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const executionId = '123e4567-e89b-42d3-a456-426614174001';
    const turnId = '123e4567-e89b-42d3-a456-426614174002';
    const contentBlockId = '123e4567-e89b-42d3-a456-426614174003';
    const timestamp = '2026-08-31T00:00:00.000Z';
    const events: AgentEventV2Envelope[] = [
      {
        type: 'session.started',
        sessionId,
        executionId,
        sequence: 0,
        timestamp,
        provider: 'claude',
        transport: 'fake',
        selection: {
          transport: 'fake',
          enabled: [],
          unavailableOptional: [],
          possibleEffects: [],
          effectsComplete: true,
        },
      },
      {
        type: 'content.delta',
        sessionId,
        executionId,
        turnId,
        contentBlockId,
        sequence: 1,
        timestamp,
        delta: 'hello there',
      },
      {
        type: 'tool.started',
        sessionId,
        executionId,
        turnId,
        contentBlockId,
        toolCallId: '123e4567-e89b-42d3-a456-426614174004',
        toolName: 'Bash',
        possibleEffects: ['command'],
        effectsComplete: true,
        sequence: 2,
        timestamp,
      },
      {
        type: 'error',
        sessionId,
        executionId,
        sequence: 3,
        timestamp,
        message: 'something broke',
        recoverable: false,
      },
      { type: 'session.completed', sessionId, executionId, sequence: 4, timestamp },
    ];
    render(<EventLog events={events} />);
    expect(screen.getByText('hello there')).toBeInTheDocument();
    expect(screen.getByText(/tool started: Bash/)).toBeInTheDocument();
    expect(screen.getByText(/something broke/)).toBeInTheDocument();
    expect(screen.getByText(/session completed/)).toBeInTheDocument();
  });
});
