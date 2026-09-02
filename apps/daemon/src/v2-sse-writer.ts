import type { AgentEventV2Envelope, StreamErrorV2 } from '@agent-dock/shared';
import { BoundedSseWriter, type SseOutput } from './sse-writer.js';

const MAX_QUEUED_EVENTS = 256;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

const TERMINAL_EVENT_TYPES = new Set<AgentEventV2Envelope['type']>([
  'session.completed',
  'session.failed',
  'session.cancelled',
  'session.interrupted',
]);

export type V2SseOutput = SseOutput;

function eventFrame(event: AgentEventV2Envelope): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function overflowFrame(lastSequence: number | undefined): string {
  const error: StreamErrorV2 = {
    type: 'stream.error',
    code: 'stream_overflow',
    ...(lastSequence === undefined ? {} : { lastSequence }),
  };
  return `event: ${error.type}\ndata: ${JSON.stringify(error)}\n\n`;
}

/** Per-connection SSE writer for protocol v2. See sse-writer.ts for the shared bounded/backpressure
 * state machine; this is only the v2-specific frame format, terminal set, and queue limits. */
export class BoundedV2SseWriter extends BoundedSseWriter<AgentEventV2Envelope> {
  constructor(
    output: V2SseOutput,
    onClose: () => void,
    onHandedOff?: (event: AgentEventV2Envelope) => void,
  ) {
    super(
      output,
      onClose,
      {
        maxQueuedEvents: MAX_QUEUED_EVENTS,
        maxQueuedBytes: MAX_QUEUED_BYTES,
        frameFor: eventFrame,
        isTerminal: (event) => TERMINAL_EVENT_TYPES.has(event.type),
        overflowFrame,
      },
      onHandedOff,
    );
  }
}
