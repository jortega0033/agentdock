import { agentEventEnvelopeSchema, type AgentEventEnvelope } from '@agent-dock/shared';
import { ValidationError } from './errors.js';

/**
 * Incrementally parses the daemon's SSE byte stream into validated `AgentEventEnvelope` objects.
 * The internal buffer only ever holds an in-progress (not yet newline-terminated) frame — never
 * the whole stream — so a long-running session can't grow unbounded client-side memory.
 *
 * A frame that isn't valid JSON, or is valid JSON that doesn't match the protocol v1 schema,
 * throws a `ValidationError` and ends the generator — a malformed event from the daemon is a
 * contract violation worth surfacing loudly, not silently skipping.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<AgentEventEnvelope, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);

  try {
    while (true) {
      if (signal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf('\n\n')) >= 0) {
        const rawFrame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const dataLine = rawFrame.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue; // comment/keepalive frame (e.g. the daemon's leading ":ok")

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(dataLine.slice('data: '.length));
        } catch (err) {
          throw new ValidationError(`received a malformed SSE frame from the daemon: ${(err as Error).message}`);
        }

        const result = agentEventEnvelopeSchema.safeParse(parsedJson);
        if (!result.success) {
          throw new ValidationError(
            `received an event that does not match the AgentEvent protocol: ${result.error.message}`,
          );
        }
        yield result.data;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
