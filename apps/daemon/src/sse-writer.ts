import { utf8ByteLength } from '@agent-dock/shared';

/**
 * Generic bounded per-connection SSE writer shared by protocol v1 and v2. Event producers only
 * enqueue synchronously; socket draining never stalls a provider session or another subscriber.
 * Each protocol supplies its own frame format, terminal-event predicate, overflow frame, and
 * queue limits via `BoundedSseWriterConfig`; the backpressure/overflow state machine itself is
 * shared so the two protocols cannot silently drift apart on this reliability-critical path.
 */
export interface SseOutput {
  write(chunk: string): boolean;
  end(chunk?: string): void;
  once(event: 'drain', listener: () => void): void;
}

export interface BoundedSseWriterConfig<TEvent> {
  maxQueuedEvents: number;
  maxQueuedBytes: number;
  frameFor(event: TEvent): string;
  isTerminal(event: TEvent): boolean;
  /** Returns the final frame to send an overflowing subscriber before closing its connection, or
   * `undefined` for a protocol with no wire-level "you overflowed" signal (the connection is then
   * simply ended, exactly like a normal stream close). */
  overflowFrame(lastSequence: number | undefined): string | undefined;
}

interface QueuedFrame<TEvent> {
  bytes: number;
  frame: string;
  sequence: number;
  terminal: boolean;
  event: TEvent;
}

export class BoundedSseWriter<TEvent extends { sequence: number }> {
  private readonly queue: Array<QueuedFrame<TEvent>> = [];
  private queuedBytes = 0;
  private backpressured = false;
  private drainArmed = false;
  private terminalReceived = false;
  private endAfterDrain = false;
  private closed = false;
  private lastHandedOffSequence: number | undefined;

  constructor(
    private readonly output: SseOutput,
    private readonly onClose: () => void,
    private readonly config: BoundedSseWriterConfig<TEvent>,
    private readonly onHandedOff?: (event: TEvent) => void,
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

  write(event: TEvent): void {
    if (this.closed || this.terminalReceived) return;

    const terminal = this.config.isTerminal(event);
    if (terminal) this.terminalReceived = true;
    const frame = this.config.frameFor(event);
    const queued: QueuedFrame<TEvent> = {
      bytes: utf8ByteLength(frame),
      frame,
      sequence: event.sequence,
      terminal,
      event,
    };

    if (this.backpressured) {
      if (
        this.queue.length >= this.config.maxQueuedEvents ||
        this.queuedBytes + queued.bytes > this.config.maxQueuedBytes
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

  private handOff(queued: QueuedFrame<TEvent>): void {
    let ready: boolean;
    try {
      ready = this.output.write(queued.frame);
      this.lastHandedOffSequence = queued.sequence;
      try {
        this.onHandedOff?.(queued.event);
      } catch {
        // Publication bookkeeping cannot break this subscriber's event stream.
      }
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
      const queued = this.queue.shift() as QueuedFrame<TEvent>;
      this.queuedBytes -= queued.bytes;
      this.handOff(queued);
    }
  };

  private overflow(): void {
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.finish(this.config.overflowFrame(this.lastHandedOffSequence));
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
