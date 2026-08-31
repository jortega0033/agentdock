import type { AgentEventV2Envelope, AgentSessionV2 } from '@agent-dock/shared';
import { DaemonError, DaemonUnavailableError, type SessionEventsOptions } from '@agent-dock/client';

const DEFAULT_RECONNECT_DELAY_MS = 250;

export interface InteractiveSessionStreamOptions {
  sessionId: string;
  signal: AbortSignal;
  events: (sessionId: string, options: SessionEventsOptions) => AsyncIterable<AgentEventV2Envelope>;
  snapshot?: (sessionId: string) => Promise<AgentSessionV2>;
  isActive: () => boolean;
  onEvent: (event: AgentEventV2Envelope) => void;
  onReplayGap?: (snapshot: AgentSessionV2) => void;
  onFatal?: (error: unknown) => void;
  onRetry?: (error: unknown, lastEventId: string | undefined) => void;
  reconnectDelayMs?: number;
}

/**
 * Relays one v2 stream and resumes from the last delivered sequence after a connection-local
 * failure (including `stream_overflow`). The daemon's replay window owns deduplication at the
 * cursor boundary; this loop stops only at a terminal event, explicit abort, or inactive session.
 */
export async function relayInteractiveSessionEvents(
  options: InteractiveSessionStreamOptions,
): Promise<void> {
  let lastEventId: string | undefined;

  while (!options.signal.aborted && options.isActive()) {
    try {
      for await (const event of options.events(options.sessionId, {
        signal: options.signal,
        ...(lastEventId === undefined ? {} : { lastEventId }),
      })) {
        lastEventId = String(event.sequence);
        options.onEvent(event);
        if (isTerminalSessionEvent(event)) return;
      }
    } catch (error) {
      if (options.signal.aborted || !options.isActive()) return;
      if (error instanceof DaemonError && error.status === 409 && options.snapshot) {
        try {
          const snapshot = await options.snapshot(options.sessionId);
          if (options.signal.aborted || !options.isActive()) return;
          options.onReplayGap?.(snapshot);
          lastEventId =
            snapshot.earliestSequence === 0 ? undefined : String(snapshot.earliestSequence - 1);
        } catch (snapshotError) {
          if (options.signal.aborted || !options.isActive()) return;
          if (!isRetryableStreamError(snapshotError)) {
            options.onFatal?.(snapshotError);
            return;
          }
          options.onRetry?.(snapshotError, lastEventId);
          await abortableDelay(
            options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
            options.signal,
          );
          continue;
        }
      } else if (!isRetryableStreamError(error)) {
        options.onFatal?.(error);
        return;
      }
      options.onRetry?.(error, lastEventId);
    }

    if (options.signal.aborted || !options.isActive()) return;
    await abortableDelay(options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS, options.signal);
  }
}

export class PendingInteractiveCreates {
  private closing = false;
  private readonly pending = new Map<Promise<unknown>, AbortController>();

  get isClosing(): boolean {
    return this.closing;
  }

  run<T>(
    start: (signal: AbortSignal) => Promise<T>,
    onResolved: (value: T) => void,
    onResolvedDuringShutdown?: (value: T) => Promise<void> | void,
  ): Promise<T> {
    if (this.closing) return Promise.reject(new Error('application is shutting down'));

    const controller = new AbortController();
    const tracked = Promise.resolve()
      .then(() => start(controller.signal))
      .then(async (value) => {
        if (this.closing || controller.signal.aborted) {
          await onResolvedDuringShutdown?.(value);
          throw new Error('application is shutting down');
        }
        onResolved(value);
        return value;
      })
      .finally(() => {
        this.pending.delete(tracked);
      });
    this.pending.set(tracked, controller);
    return tracked;
  }

  beginShutdown(): void {
    this.closing = true;
    for (const controller of this.pending.values()) {
      controller.abort(new Error('application is shutting down'));
    }
  }

  async waitForPending(timeoutMs: number): Promise<boolean> {
    if (this.pending.size === 0) return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = Promise.allSettled([...this.pending.keys()]).then(() => true);
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return Promise.race([settled, timedOut]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }
}

function isRetryableStreamError(error: unknown): boolean {
  if (error instanceof DaemonUnavailableError) return true;
  return (
    error instanceof DaemonError &&
    (error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500)
  );
}

function isTerminalSessionEvent(event: AgentEventV2Envelope): boolean {
  return (
    event.type === 'session.completed' ||
    event.type === 'session.failed' ||
    event.type === 'session.cancelled' ||
    event.type === 'session.interrupted'
  );
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener('abort', done, { once: true });

    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
