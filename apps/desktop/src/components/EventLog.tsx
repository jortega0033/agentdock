import type { AgentEventV2Envelope, ContentBlockV2 } from '@agent-dock/shared';
import emptyEventsIllustration from '../../assets/illustrations/empty-events.svg';

/**
 * Renders the normalized AgentEvent stream. Every branch here is keyed on `event.type`, never
 * on which provider produced it: that's the whole point of the normalized protocol.
 */
function formatBlock(block: ContentBlockV2): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
    case 'file':
      return `${block.type}: ${block.name}`;
    case 'structured_data':
      return 'structured data received';
    case 'tool_activity':
      return `${block.toolName}: ${block.status}`;
    case 'plan':
      return `${block.title ?? 'plan'} (${block.steps.length} steps)`;
    case 'provider_extension':
      return block.safeSummary;
  }
}

function formatEvent(event: AgentEventV2Envelope): string {
  switch (event.type) {
    case 'session.started':
      return `session started (${event.provider}, ${event.transport})`;
    case 'session.status':
      return `status: ${event.status}`;
    case 'turn.started':
      return 'turn started';
    case 'turn.completed':
      return 'turn completed';
    case 'turn.failed':
      return `turn failed: ${event.message}`;
    case 'turn.interrupted':
      return `turn interrupted${event.reason ? `: ${event.reason}` : ''}`;
    case 'content.delta':
      return event.delta;
    case 'content.completed':
      return formatBlock(event.block);
    case 'tool.started':
      return `tool started: ${event.toolName}`;
    case 'tool.completed':
      return `tool ${event.status}: ${event.toolName}${event.summary ? ` — ${event.summary}` : ''}`;
    case 'approval.requested':
      return 'approval requested';
    case 'approval.resolved':
      return `approval ${event.decision}`;
    case 'question.requested':
      return 'provider question requested';
    case 'question.resolved':
      return 'provider question answered';
    case 'question.cancelled':
      return `provider question cancelled: ${event.reason}`;
    case 'usage.tokens':
      return `usage (in: ${event.inputTokens ?? '?'} out: ${event.outputTokens ?? '?'})`;
    case 'usage.cost':
      return `cost: ${event.cost.toFixed(4)} ${event.currency}${event.estimated ? ' estimated' : ''}`;
    case 'error':
      return `error: ${event.message}`;
    case 'extension.summary':
      return event.summary;
    case 'session.completed':
      return 'session completed';
    case 'session.failed':
      return `session failed: ${event.message}`;
    case 'session.cancelled':
      return `session cancelled${event.reason ? `: ${event.reason}` : ''}`;
    case 'session.interrupted':
      return `session interrupted${event.reason ? `: ${event.reason}` : ''}`;
  }
}

function cssClassFor(event: AgentEventV2Envelope): string {
  if (event.type === 'error' || event.type === 'session.failed' || event.type === 'turn.failed')
    return 'event-line event-line--error';
  if (event.type === 'session.completed') return 'event-line event-line--success';
  if (event.type === 'session.cancelled' || event.type === 'session.interrupted')
    return 'event-line event-line--muted';
  return 'event-line';
}

export function EventLog({ events }: { events: AgentEventV2Envelope[] }) {
  if (events.length === 0) {
    return (
      <div className="event-log event-log--empty">
        <img className="event-log__empty-illustration" src={emptyEventsIllustration} alt="" />
        <strong>No events yet.</strong>
        <span>Start a session to stream provider-neutral events here.</span>
      </div>
    );
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
