/** Small callback-to-async-iterator bridge with explicit failure propagation. */
export class FailableChannel<T> {
  private readonly values: Array<{ value: T; bytes: number }> = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T, void>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private error: unknown;
  private bufferedBytes = 0;

  constructor(
    private readonly maximumBufferedValues = 5_000,
    private readonly maximumBufferedBytes = 16 * 1024 * 1024,
    private readonly bufferedValueBytes: (value: T) => number = () => 1,
  ) {}

  push(value: T): boolean {
    if (this.ended) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return true;
    }
    const bytes = this.bufferedValueBytes(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
    if (
      this.values.length >= this.maximumBufferedValues ||
      bytes > this.maximumBufferedBytes - this.bufferedBytes
    ) {
      return false;
    }
    this.values.push({ value, bytes });
    this.bufferedBytes += bytes;
    return true;
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    this.values.length = 0;
    this.bufferedBytes = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, void> {
    while (true) {
      if (this.values.length > 0) {
        const next = this.values.shift() as { value: T; bytes: number };
        this.bufferedBytes -= next.bytes;
        yield next.value;
        continue;
      }
      if (this.error !== undefined) throw this.error;
      if (this.ended) return;
      const result = await new Promise<IteratorResult<T, void>>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
      if (result.done) return;
      yield result.value;
    }
  }
}
