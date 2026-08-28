import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agent-dock/shared';
import { EventLog } from '../src/components/EventLog.js';

describe('EventLog', () => {
  it('shows a placeholder when there are no events', () => {
    render(<EventLog events={[]} />);
    expect(screen.getByText(/no events yet/i)).toBeInTheDocument();
  });

  it('renders assistant messages, tool events, and errors without provider-specific logic', () => {
    const events: AgentEvent[] = [
      { type: 'session.started', sessionId: 's1', provider: 'claude' },
      { type: 'assistant.message', text: 'hello there' },
      { type: 'tool.started', toolName: 'Bash', toolCallId: 'c1' },
      { type: 'error', message: 'something broke', recoverable: false },
      { type: 'session.completed' },
    ];
    render(<EventLog events={events} />);
    expect(screen.getByText('hello there')).toBeInTheDocument();
    expect(screen.getByText(/tool started: Bash/)).toBeInTheDocument();
    expect(screen.getByText(/something broke/)).toBeInTheDocument();
    expect(screen.getByText(/session completed/)).toBeInTheDocument();
  });
});
