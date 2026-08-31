import { describe, expect, it, vi } from 'vitest';
import { streamErrorV2Schema, type AgentEventV2Envelope } from '@agent-dock/shared';
import { BoundedV2SseWriter, type V2SseOutput } from '../src/v2-sse-writer.js';

const sessionId = '123e4567-e89b-42d3-a456-426614174000';
const executionId = '123e4567-e89b-42d3-a456-426614174001';
const turnId = '123e4567-e89b-42d3-a456-426614174002';
const contentBlockId = '123e4567-e89b-42d3-a456-426614174003';

class TestOutput implements V2SseOutput {
  readonly writes: string[] = [];
  readonly endings: Array<string | undefined> = [];
  private drainListener: (() => void) | undefined;

  constructor(private readonly readiness: boolean[] = []) {}

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return this.readiness.shift() ?? true;
  }

  end(chunk?: string): void {
    this.endings.push(chunk);
  }

  once(_event: 'drain', listener: () => void): void {
    this.drainListener = listener;
  }

  drain(): void {
    const listener = this.drainListener;
    this.drainListener = undefined;
    listener?.();
  }
}

function contentEvent(sequence: number, size = 1): AgentEventV2Envelope {
  return {
    type: 'content.delta',
    sessionId,
    executionId,
    turnId,
    contentBlockId,
    sequence,
    timestamp: '2026-08-31T00:00:00.000Z',
    delta: 'x'.repeat(size),
  };
}

function terminalEvent(sequence: number): AgentEventV2Envelope {
  return {
    type: 'session.completed',
    sessionId,
    executionId,
    sequence,
    timestamp: '2026-08-31T00:00:00.000Z',
  };
}

function frameData(frame: string | undefined): unknown {
  const data = frame?.split('\n').find((line) => line.startsWith('data: '));
  return data ? JSON.parse(data.slice('data: '.length)) : undefined;
}

describe('BoundedV2SseWriter', () => {
  it('includes the initial SSE comment in connection-local backpressure accounting', () => {
    const output = new TestOutput([false]);
    const onClose = vi.fn();
    const writer = new BoundedV2SseWriter(output, onClose);
    writer.start();
    for (let sequence = 0; sequence <= 256; sequence += 1) writer.write(contentEvent(sequence));

    expect(output.writes).toEqual([':ok\n\n']);
    expect(streamErrorV2Schema.parse(frameData(output.endings[0]))).toEqual({
      type: 'stream.error',
      code: 'stream_overflow',
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('writes immediately, queues under backpressure, and ends only after a queued terminal drains', () => {
    const output = new TestOutput([true, false, true, false]);
    const onClose = vi.fn();
    const writer = new BoundedV2SseWriter(output, onClose);

    writer.write(contentEvent(0));
    writer.write(contentEvent(1));
    writer.write(contentEvent(2));
    writer.write(terminalEvent(3));

    expect(output.writes).toHaveLength(2);
    expect(output.endings).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();

    output.drain();

    expect(output.writes.map(frameData)).toEqual([
      contentEvent(0),
      contentEvent(1),
      contentEvent(2),
      terminalEvent(3),
    ]);
    expect(output.endings).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();

    output.drain();

    expect(output.endings).toEqual([undefined]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reports responder publication only when each frame is handed to the socket', () => {
    const output = new TestOutput([false, true]);
    const handedOff = vi.fn();
    const writer = new BoundedV2SseWriter(output, vi.fn(), handedOff);
    const first = contentEvent(0);
    const queued = contentEvent(1);

    writer.write(first);
    writer.write(queued);

    expect(handedOff).toHaveBeenCalledTimes(1);
    expect(handedOff).toHaveBeenLastCalledWith(first);

    output.drain();

    expect(handedOff).toHaveBeenCalledTimes(2);
    expect(handedOff).toHaveBeenLastCalledWith(queued);
  });

  it('does not discard a replayed terminal frame when the terminal snapshot is already known', () => {
    const output = new TestOutput([false, true]);
    const onClose = vi.fn();
    const writer = new BoundedV2SseWriter(output, onClose);

    writer.start();
    writer.write(terminalEvent(0));
    writer.finishReplay();

    expect(output.endings).toEqual([]);
    output.drain();
    expect(output.writes.map(frameData)).toEqual([undefined, terminalEvent(0)]);
    expect(output.endings).toEqual([undefined]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('discards a 257th queued event and ends with stream_overflow at the last handed-off sequence', () => {
    const output = new TestOutput([false]);
    const onClose = vi.fn();
    const writer = new BoundedV2SseWriter(output, onClose);

    writer.write(contentEvent(0));
    for (let sequence = 1; sequence <= 257; sequence += 1) writer.write(contentEvent(sequence));

    expect(output.writes).toHaveLength(1);
    expect(streamErrorV2Schema.parse(frameData(output.endings[0]))).toEqual({
      type: 'stream.error',
      code: 'stream_overflow',
      lastSequence: 0,
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    output.drain();
    writer.close();
    expect(output.endings).toHaveLength(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('applies the 4 MiB byte bound before the event-count bound', () => {
    const output = new TestOutput([false]);
    const writer = new BoundedV2SseWriter(output, vi.fn());

    writer.write(contentEvent(0));
    for (let sequence = 1; sequence <= 20 && output.endings.length === 0; sequence += 1) {
      writer.write(contentEvent(sequence, 256 * 1024));
    }

    expect(output.writes).toHaveLength(1);
    expect(streamErrorV2Schema.parse(frameData(output.endings[0])).code).toBe('stream_overflow');
  });

  it('keeps connection state independent and closes each subscription exactly once', () => {
    const blockedOutput = new TestOutput([false]);
    const readyOutput = new TestOutput([true]);
    const blockedClose = vi.fn();
    const readyClose = vi.fn();
    const blocked = new BoundedV2SseWriter(blockedOutput, blockedClose);
    const ready = new BoundedV2SseWriter(readyOutput, readyClose);

    blocked.write(contentEvent(0));
    ready.write(terminalEvent(0));

    expect(blockedOutput.endings).toEqual([]);
    expect(readyOutput.endings).toEqual([undefined]);
    expect(readyClose).toHaveBeenCalledTimes(1);

    blocked.close();
    blocked.close();
    blockedOutput.drain();
    expect(blockedClose).toHaveBeenCalledTimes(1);
    expect(blockedOutput.endings).toHaveLength(1);
  });
});
