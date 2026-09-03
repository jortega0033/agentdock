import type { AgentEventEnvelope } from '@agent-dock/shared';
import { BoundedSseWriter, type SseOutput } from './sse-writer.js';

const MAX_QUEUED_EVENTS = 256;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

const TERMINAL_EVENT_TYPES = new Set<AgentEventEnvelope['type']>([
  'session.completed',
  'session.failed',
  'session.cancelled',
]);

export type V1SseOutput = SseOutput;

function eventFrame(event: AgentEventEnvelope): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Per-connection SSE writer for protocol v1. See sse-writer.ts for the shared bounded/backpressure
 * state machine. Protocol v1 has no wire-level "stream error" event (deliberately not expanded
 * here -- see issue #51's non-goals): an overflowing subscriber's connection is simply ended, the
 * same as a normal stream close, with no extra frame. The session's own replay history is
 * untouched, since overflow is purely a per-subscriber queue limit; see
 * docs/protocol-v1.md#reconnecting-after-a-dropped-stream for the client-facing reconnect
 * contract this relies on.
 */
export class BoundedV1SseWriter extends BoundedSseWriter<AgentEventEnvelope> {
  constructor(
    output: V1SseOutput,
    onClose: () => void,
    onHandedOff?: (event: AgentEventEnvelope) => void,
  ) {
    super(
      output,
      onClose,
      {
        maxQueuedEvents: MAX_QUEUED_EVENTS,
        maxQueuedBytes: MAX_QUEUED_BYTES,
        frameFor: eventFrame,
        isTerminal: (event) => TERMINAL_EVENT_TYPES.has(event.type),
        overflowFrame: () => undefined,
      },
      onHandedOff,
    );
  }
}
