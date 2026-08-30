import { ValidationError } from './errors.js';

export interface RuntimeSchema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

export interface SseParserOptions<T> {
  schema: RuntimeSchema<T>;
  label: string;
  signal?: AbortSignal;
  /** Maximum UTF-8 bytes in one SSE frame. Omit for an unbounded legacy stream. */
  maxFrameBytes?: number;
  /** Reject malformed UTF-8, including an incomplete sequence at EOF. */
  fatalUtf8?: boolean;
  /** Reject a non-empty final frame that is missing its SSE separator. */
  rejectUnterminatedFrame?: boolean;
  /** Perform protocol-specific checks after schema validation and before yielding an event. */
  validateEvent?: (event: T, frame: SseFrameMetadata) => void;
}

export interface SseFrameMetadata {
  id?: string;
}

/**
 * Incrementally parses a daemon SSE byte stream and validates every data frame with the supplied
 * protocol schema. The buffer contains only data that has not reached an SSE frame separator.
 */
export async function* parseSseStream<T>(
  body: ReadableStream<Uint8Array>,
  options: SseParserOptions<T>,
): AsyncGenerator<T, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: options.fatalUtf8 ?? false });
  let buffer: Uint8Array = new Uint8Array(0);
  const decodeFrame = (bytes: Uint8Array): string => {
    try {
      return decoder.decode(bytes);
    } catch (err) {
      throw new ValidationError(
        `received a malformed UTF-8 ${options.label} SSE frame from the daemon: ${errorMessage(err)}`,
      );
    }
  };

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  options.signal?.addEventListener('abort', onAbort);

  try {
    while (true) {
      if (options.signal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) {
        if (buffer.byteLength > 0) {
          if (options.fatalUtf8) decodeFrame(buffer);
          if (options.rejectUnterminatedFrame) {
            throw new ValidationError(
              `received an unfinished ${options.label} SSE frame at the end of the stream`,
            );
          }
        }
        return;
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const appendLength = boundedAppendLength(
          buffer.byteLength,
          value.byteLength - offset,
          options.maxFrameBytes,
        );
        buffer = appendBytes(buffer, value.subarray(offset, offset + appendLength));
        offset += appendLength;

        while (true) {
          const separator = findFrameSeparator(buffer);
          if (!separator) break;

          const rawFrameBytes = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator.length);
          assertFrameSize(rawFrameBytes.byteLength, options.maxFrameBytes, options.label);

          const rawFrame = decodeFrame(rawFrameBytes);
          const lines = rawFrame.split(/\r?\n/);
          const dataLine = lines.find((line) => line === 'data:' || line.startsWith('data: '));
          if (!dataLine) continue;

          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(dataLine.slice('data:'.length).trimStart());
          } catch (err) {
            throw new ValidationError(
              `received a malformed ${options.label} SSE frame from the daemon: ${errorMessage(err)}`,
            );
          }

          const result = options.schema.safeParse(parsedJson);
          if (!result.success) {
            throw new ValidationError(
              `received an event that does not match the ${options.label} protocol: ${result.error.message}`,
            );
          }
          const idLine = lines.find((line) => line === 'id:' || line.startsWith('id: '));
          options.validateEvent?.(result.data, {
            ...(idLine === undefined ? {} : { id: idLine.slice('id:'.length).trimStart() }),
          });
          yield result.data;
        }

        assertFrameSize(pendingFramePayloadBytes(buffer), options.maxFrameBytes, options.label);
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * A bounded parser only copies enough of a chunk to hold one maximum-size frame plus the longest
 * legal separator. This prevents an oversized single stream chunk from causing an equally large
 * second allocation before the protocol limit is checked.
 */
function boundedAppendLength(
  bufferedBytes: number,
  availableBytes: number,
  maximumFrameBytes: number | undefined,
): number {
  if (maximumFrameBytes === undefined) return availableBytes;
  const capacity = maximumFrameBytes + 4 - bufferedBytes;
  return Math.min(availableBytes, Math.max(capacity, 1));
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function findFrameSeparator(buffer: Uint8Array): { index: number; length: number } | undefined {
  for (let index = 0; index < buffer.byteLength - 1; index += 1) {
    if (buffer[index] === 0x0a && buffer[index + 1] === 0x0a) return { index, length: 2 };
    if (
      index < buffer.byteLength - 3 &&
      buffer[index] === 0x0d &&
      buffer[index + 1] === 0x0a &&
      buffer[index + 2] === 0x0d &&
      buffer[index + 3] === 0x0a
    ) {
      return { index, length: 4 };
    }
  }
  return undefined;
}

function assertFrameSize(size: number, maximum: number | undefined, label: string): void {
  if (maximum !== undefined && size > maximum) {
    throw new ValidationError(
      `received a ${label} SSE frame larger than the ${maximum}-byte protocol limit`,
    );
  }
}

/** Excludes bytes that may be the beginning of a frame separator split across chunks. */
function pendingFramePayloadBytes(buffer: Uint8Array): number {
  const length = buffer.byteLength;
  if (
    length >= 3 &&
    buffer[length - 3] === 0x0d &&
    buffer[length - 2] === 0x0a &&
    buffer[length - 1] === 0x0d
  ) {
    return length - 3;
  }
  if (length >= 2 && buffer[length - 2] === 0x0d && buffer[length - 1] === 0x0a) return length - 2;
  if (length >= 1 && (buffer[length - 1] === 0x0d || buffer[length - 1] === 0x0a))
    return length - 1;
  return length;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
