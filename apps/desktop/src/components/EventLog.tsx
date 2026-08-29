import type { AgentEvent } from '@agent-dock/shared';

/**
 * Renders the normalized AgentEvent stream. Every branch here is keyed on `event.type`, never
 * on which provider produced it — that's the whole point of the normalized protocol.
 */
function formatEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'session.started':
      return `session started (${event.provider})`;
    case 'status':
      return `status: ${event.status}${event.detail ? ` — ${event.detail}` : ''}`;
    case 'assistant.message':
      return event.text;
    case 'thinking.delta':
      return `(thinking) ${event.text}`;
    case 'tool.started':
      return `tool started: ${event.toolName}`;
    case 'tool.completed':
      return `tool ${event.isError ? 'failed' : 'completed'}: ${event.toolName ?? 'unknown'}`;
    case 'usage':
      return `usage — in: ${event.inputTokens ?? '?'} out: ${event.outputTokens ?? '?'}${
        event.cost !== undefined ? ` cost: $${event.cost.toFixed(4)}` : ''
      }`;
    case 'error':
      return `error: ${event.message}`;
    case 'session.completed':
      return 'session completed';
    case 'session.failed':
      return `session failed: ${event.message}`;
    case 'session.cancelled':
      return 'session cancelled';
    default:
      return JSON.stringify(event);
  }
}

function cssClassFor(event: AgentEvent): string {
  if (event.type === 'error' || event.type === 'session.failed') return 'event-line event-line--error';
  if (event.type === 'session.completed') return 'event-line event-line--success';
  if (event.type === 'session.cancelled') return 'event-line event-line--muted';
  return 'event-line';
}

export function EventLog({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return <div className="event-log event-log--empty">No events yet.</div>;
  }
  return (
    <div className="event-log" role="log" aria-label="session events">
      {events.map((event, index) => (
        <div key={index} className={cssClassFor(event)}>
          <span className="event-type">{event.type}</span>
          <span className="event-text">{formatEvent(event)}</span>
        </div>
      ))}
    </div>
  );
}
