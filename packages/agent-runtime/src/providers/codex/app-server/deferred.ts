export interface Deferred<T> {
  promise: Promise<T>;
  settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value: T): void {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error: unknown): void {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}
