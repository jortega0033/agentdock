/**
 * Async push/pull queue bridging callback-driven producers (child process events) to
 * `for await` consumers (provider adapters, SSE routes). Bounded so a runaway or malicious CLI
 * emitting output faster than it's consumed can't grow memory without limit.
 *
 * On overflow, `push()` drops the item and returns `false` rather than auto-closing the channel:
 * a caller that silently stopped delivering here would violate the "exactly one terminal event,
 * always last" guarantee every consumer of this channel depends on (see run-session.ts, which
 * reacts to a `false` return by pushing an explicit `EVENT_OVERFLOW` error and terminal event via
 * `closeWith()`, bypassing the cap, since those are the one or two events that must still get
 * through). A channel that has overflowed and been abandoned by its producer without calling
 * `close()`/`closeWith()` stays open but simply never receives more items; nothing in this class
 * itself decides when to terminate on overflow, since only the producer knows the correct
 * terminal event to send.
 */
export class AsyncChannel<T> {
  private queue: T[] = [];
  private waiters: Array<(result: IteratorResult<T, void>) => void> = [];
  private closed = false;

  constructor(private readonly maxBufferedItems = 10_000) {}

  /**
   * Returns `false` if the item was dropped: the channel is already closed, or full. This is
   * the only overflow signal (no separate `didOverflow` flag/getter): the caller learns about an
   * overflow at the exact push call that hit it, synchronously, which is the only place it can
   * actually do anything useful about it (see run-session.ts's `closeWithOverflow`). A query-
   * after-the-fact flag would just be state nothing reads.
   */
  push(value: T): boolean {
    if (this.closed) return false;
    if (this.queue.length >= this.maxBufferedItems) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.queue.push(value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  /**
   * Enqueues `finalValues` bypassing the buffer cap, then closes. For the one or two terminal
   * events (an overflow error, then session.failed) that must reach the consumer even though the
   * channel has already hit its normal limit; those are producer-emitted, not attacker-supplied
   * volume, so bypassing the cap here can't be abused the way unbounded normal pushes could.
   */
  closeWith(finalValues: T[]): void {
    if (this.closed) return;
    for (const value of finalValues) {
      const waiter = this.waiters.shift();
      if (waiter) waiter({ value, done: false });
      else this.queue.push(value);
    }
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, void> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift() as T;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T, void>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}
