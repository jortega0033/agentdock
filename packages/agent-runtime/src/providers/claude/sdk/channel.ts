interface PendingValue<T> {
  value: T;
  accepted: Promise<void>;
  accept(): void;
  reject(error: unknown): void;
}

function pendingValue<T>(value: T): PendingValue<T> {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const accepted = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { value, accepted, accept: resolve, reject };
}

/** A bounded, acknowledged input stream for the SDK's streaming prompt mode. */
export class ClaudeSdkInputChannel<T> {
  private readonly values: PendingValue<T>[] = [];
  private readonly waiters: Array<(value: PendingValue<T> | undefined) => void> = [];
  private ended = false;

  enqueue(value: T): Promise<void> {
    if (this.ended) return Promise.reject(new Error('Claude SDK input is closed'));
    if (this.values.length >= 32)
      return Promise.reject(new Error('Claude SDK input queue is full'));
    const pending = pendingValue(value);
    const waiter = this.waiters.shift();
    if (waiter) waiter(pending);
    else this.values.push(pending);
    return pending.accepted;
  }

  close(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    for (const pending of this.values.splice(0)) pending.reject(error ?? new Error('closed'));
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }

  async *stream(): AsyncGenerator<T, void, void> {
    while (true) {
      const pending =
        this.values.shift() ??
        (await new Promise<PendingValue<T> | undefined>((resolve) => {
          if (this.ended) resolve(undefined);
          else this.waiters.push(resolve);
        }));
      if (!pending) return;
      // Pulling the item is the SDK accepted-work boundary. Resolve before yield so a disconnect
      // immediately after next() cannot leave accepted work classified as replayable.
      pending.accept();
      yield pending.value;
    }
  }
}

/** Bounded callback-to-iterator bridge for normalized provider events. */
export class ClaudeSdkEventChannel<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve(value: IteratorResult<T, void>): void;
    reject(error: unknown): void;
  }> = [];
  private ended = false;
  private failure: unknown;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else if (this.values.length < 5_000) this.values.push(value);
    else this.fail(new Error('Claude SDK event queue is full'));
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
    this.failure = error;
    this.values.length = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async *stream(): AsyncGenerator<T, void, void> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T;
        continue;
      }
      if (this.failure !== undefined) throw this.failure;
      if (this.ended) return;
      const result = await new Promise<IteratorResult<T, void>>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
      if (result.done) return;
      yield result.value;
    }
  }
}
