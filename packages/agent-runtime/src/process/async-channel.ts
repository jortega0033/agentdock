/**
 * Async push/pull queue bridging callback-driven producers (child process events) to
 * `for await` consumers (provider adapters, SSE routes). Bounded so a runaway or malicious CLI
 * emitting output faster than it's consumed can't grow memory without limit — once full, the
 * channel closes itself with an error rather than buffering forever.
 */
export class AsyncChannel<T> {
  private queue: T[] = [];
  private waiters: Array<(result: IteratorResult<T, void>) => void> = [];
  private closed = false;
  private overflowed = false;

  constructor(private readonly maxBufferedItems = 10_000) {}

  push(value: T): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxBufferedItems) {
      this.overflowed = true;
      this.close();
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.queue.push(value);
  }

  get didOverflow(): boolean {
    return this.overflowed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
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
