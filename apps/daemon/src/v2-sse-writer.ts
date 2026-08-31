import { utf8ByteLength, type AgentEventV2Envelope, type StreamErrorV2 } from '@agent-dock/shared';

const MAX_QUEUED_EVENTS = 256;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

const TERMINAL_EVENT_TYPES = new Set<AgentEventV2Envelope['type']>([
  'session.completed',
  'session.failed',
  'session.cancelled',
  'session.interrupted',
]);

export interface V2SseOutput {
  write(chunk: string): boolean;
  end(chunk?: string): void;
  once(event: 'drain', listener: () => void): void;
}

interface QueuedFrame {
  bytes: number;
  frame: string;
  sequence: number;
  terminal: boolean;
}

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

/**
 * Per-connection SSE writer. Event producers only enqueue synchronously; socket draining never
 * stalls a provider session or another subscriber.
 */
export class BoundedV2SseWriter {
  private readonly queue: QueuedFrame[] = [];
  private queuedBytes = 0;
  private backpressured = false;
  private drainArmed = false;
  private terminalReceived = false;
  private endAfterDrain = false;
  private closed = false;
  private lastHandedOffSequence: number | undefined;

  constructor(
    private readonly output: V2SseOutput,
    private readonly onClose: () => void,
  ) {}

  start(): void {
    if (this.closed || this.backpressured) return;
    try {
      if (this.output.write(':ok\n\n')) return;
      this.backpressured = true;
      this.armDrain();
    } catch {
      this.finish();
    }
  }

  write(event: AgentEventV2Envelope): void {
    if (this.closed || this.terminalReceived) return;

    const terminal = TERMINAL_EVENT_TYPES.has(event.type);
    if (terminal) this.terminalReceived = true;
    const frame = eventFrame(event);
    const queued: QueuedFrame = {
      bytes: utf8ByteLength(frame),
      frame,
      sequence: event.sequence,
      terminal,
    };

    if (this.backpressured) {
      if (
        this.queue.length >= MAX_QUEUED_EVENTS ||
        this.queuedBytes + queued.bytes > MAX_QUEUED_BYTES
      ) {
        this.overflow();
        return;
      }
      this.queue.push(queued);
      this.queuedBytes += queued.bytes;
      return;
    }

    this.handOff(queued);
  }

  close(): void {
    this.finish();
  }

  /** Closes an already-terminal replay only when its terminal frame was not part of the cursor. */
  finishReplay(): void {
    if (!this.terminalReceived) this.finish();
  }

  private handOff(queued: QueuedFrame): void {
    let ready: boolean;
    try {
      ready = this.output.write(queued.frame);
      this.lastHandedOffSequence = queued.sequence;
    } catch {
      this.finish();
      return;
    }

    if (ready) {
      if (queued.terminal) this.finish();
      return;
    }

    this.backpressured = true;
    this.endAfterDrain = queued.terminal;
    this.armDrain();
  }

  private armDrain(): void {
    if (this.closed || this.drainArmed) return;
    this.drainArmed = true;
    try {
      this.output.once('drain', this.handleDrain);
    } catch {
      this.finish();
    }
  }

  private readonly handleDrain = (): void => {
    this.drainArmed = false;
    if (this.closed) return;
    this.backpressured = false;

    if (this.endAfterDrain) {
      this.finish();
      return;
    }

    while (!this.closed && !this.backpressured && this.queue.length > 0) {
      const queued = this.queue.shift() as QueuedFrame;
      this.queuedBytes -= queued.bytes;
      this.handOff(queued);
    }
  };

  private overflow(): void {
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.finish(overflowFrame(this.lastHandedOffSequence));
  }

  private finish(finalFrame?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    try {
      this.output.end(finalFrame);
    } catch {
      // The peer may already have gone away; local subscription cleanup must still run.
    }
    try {
      this.onClose();
    } catch {
      // A cleanup callback must not escape into the provider event producer.
    }
  }
}
