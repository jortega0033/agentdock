import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessExitResult } from '../src/process/spawn-process.js';

const spawnProcess = vi.hoisted(() => vi.fn());

vi.mock('../src/process/spawn-process.js', () => ({ spawnProcess }));

import { execCapture } from '../src/process/exec-capture.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function childStub(): { stdout: EventEmitter; stderr: EventEmitter } {
  return { stdout: new EventEmitter(), stderr: new EventEmitter() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('execCapture timeout reaping', () => {
  it('waits for requested termination before returning a timed-out result', async () => {
    vi.useFakeTimers();
    const exited = deferred<ProcessExitResult>();
    const killed = deferred<void>();
    const kill = vi.fn(() => killed.promise);
    spawnProcess.mockReturnValue({ child: childStub(), exit: exited.promise, kill });

    const result = execCapture('tool', [], { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledTimes(1);

    exited.resolve({ code: null, signal: 'SIGTERM' });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    killed.resolve();
    await expect(result).resolves.toMatchObject({ code: null, timedOut: true });
  });

  it('returns bounded timeout result when termination rejects and exit never arrives', async () => {
    vi.useFakeTimers();
    const neverExits = new Promise<ProcessExitResult>(() => undefined);
    const kill = vi.fn(async () => {
      throw new Error('termination helper failed');
    });
    spawnProcess.mockReturnValue({ child: childStub(), exit: neverExits, kill });

    const result = execCapture('tool', [], { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toEqual({ code: null, stdout: '', stderr: '', timedOut: true });
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
