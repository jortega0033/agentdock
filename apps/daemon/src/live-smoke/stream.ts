const TERMINAL_EVENT_TYPES = new Set([
  'session.completed',
  'session.failed',
  'session.cancelled',
  'session.interrupted',
]);
const CONTENT_EVENT_TYPES = new Set(['content.delta', 'content.block']);

export type SmokeStreamOutcome =
  | { outcome: 'success'; terminalType: string; hasContent: boolean }
  | { outcome: 'timeout' }
  | { outcome: 'protocol_violation'; reason: string };

export interface ConsumeSmokeStreamOptions {
  timeoutMs: number;
  /**
   * Called for every event before it's classified, so a caller can react to an in-flight
   * interaction request (e.g. answer an approval so a real agentic turn can keep going) without
   * this function's own success/violation decision depending on that behavior.
   */
  onEvent?: (event: unknown) => void | Promise<void>;
}

function hasTextContent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const text = (event as { text?: unknown; delta?: unknown }).text ?? (event as { delta?: unknown }).delta;
  return typeof text === 'string' && text.length > 0;
}

function eventType(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const type = (event as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

const TIMED_OUT = Symbol('live-smoke-stream-timeout');

/**
 * Consumes a session's event stream and decides what issue #65 requires: success needs
 * non-empty normalized content and *exactly one* terminal completion. A second terminal event, or
 * an item with no recognizable `type`, is a real protocol violation -- a bug in the daemon or the
 * provider adapter, not something this harness should silently tolerate or paper over. A stream
 * that never yields another event within `timeoutMs` -- including one that hangs forever waiting
 * on the *first* event -- is a hang, reported distinctly from a violation so operators know
 * whether to look at timing or at conformance. Each wait is raced against the timeout individually
 * (not just checked between iterations), so a stream that stops producing events entirely is
 * caught even though `for await` alone would block forever on it.
 *
 * Deliberately takes `AsyncIterable<unknown>`, not `AsyncIterable<AgentEventV2Envelope>`: real
 * wire events haven't been schema-validated by the time they reach here, and a malformed item is
 * exactly the case this function must catch rather than crash on.
 */
export async function consumeSmokeStream(
  events: AsyncIterable<unknown>,
  options: ConsumeSmokeStreamOptions,
): Promise<SmokeStreamOutcome> {
  const iterator = events[Symbol.asyncIterator]();
  let terminalType: string | undefined;
  let hasContent = false;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), options.timeoutMs);
    });
    let step: IteratorResult<unknown> | typeof TIMED_OUT;
    try {
      const rawNext = iterator.next();
      // If `timeout` wins the race below, `rawNext` is left running and may reject later, after
      // this function has already returned. Node reports a promise with no handler attached as
      // an unhandled rejection even then, so a no-op handler is attached here unconditionally --
      // this doesn't change what `Promise.race` below observes (subscribing another handler
      // never consumes or alters a promise), it only keeps a late rejection from crashing the
      // process well after this smoke case already reported its outcome.
      rawNext.catch(() => {});
      step = await Promise.race([rawNext, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (step === TIMED_OUT) {
      void iterator.return?.().catch(() => {});
      return { outcome: 'timeout' };
    }
    if (step.done) break;
    const event = step.value;
    await options.onEvent?.(event);
    const type = eventType(event);
    if (type === undefined) {
      void iterator.return?.().catch(() => {});
      return { outcome: 'protocol_violation', reason: 'event has no recognizable type' };
    }
    if (CONTENT_EVENT_TYPES.has(type) && hasTextContent(event)) {
      hasContent = true;
    }
    if (TERMINAL_EVENT_TYPES.has(type)) {
      if (terminalType !== undefined) {
        void iterator.return?.().catch(() => {});
        return {
          outcome: 'protocol_violation',
          reason: `received a second terminal event (${type}) after ${terminalType}`,
        };
      }
      terminalType = type;
    }
  }
  if (terminalType === undefined) {
    return { outcome: 'protocol_violation', reason: 'stream ended without a terminal event' };
  }
  return { outcome: 'success', terminalType, hasContent };
}
