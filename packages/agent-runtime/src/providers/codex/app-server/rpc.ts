import { validateJsonBounds } from '@agent-dock/shared';
import {
  isCodexAppServerIncomingMethod,
  isCodexAppServerIncomingNotificationMethod,
  isCodexAppServerOutgoingMethod,
} from '../app-server-support.js';
import { deferred, type Deferred } from './deferred.js';
import { CodexAppServerProtocolError } from './errors.js';

export type RpcId = string | number;
type JsonObject = Record<string, unknown>;

interface PendingRequest {
  method: string;
  result: Deferred<unknown>;
}

export interface IncomingRequestResponder {
  readonly id: RpcId;
  readonly method: string;
  readonly params: unknown;
  respond(result: unknown): Promise<void>;
  reject(code: number, safeMessage: string): Promise<void>;
}

export interface CodexAppServerRpcOptions {
  write(frame: Buffer): Promise<void>;
  onNotification(method: string, params: unknown): void;
  onRequest(request: IncomingRequestResponder): void | Promise<void>;
  onFatal(error: Error): void;
}

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_COMPLETED_REQUEST_IDS = 10_000;
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256)
  );
}

function idKey(id: RpcId): string {
  return typeof id === 'number' ? `number:${id}` : `string:${id}`;
}

/** Strict newline-delimited JSON RPC peer for the headerless Codex app-server protocol. */
export class CodexAppServerRpc {
  private partial = Buffer.alloc(0);
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly completed = new Set<string>();
  private readonly completedOrder: string[] = [];
  private readonly incomingRequestIds = new Set<string>();
  private fatal = false;

  constructor(private readonly options: CodexAppServerRpcOptions) {}

  async request(
    method: string,
    params: unknown,
    immediatelyBeforeWrite?: () => void,
    afterWrite?: () => void,
  ): Promise<unknown> {
    this.assertOutgoing(method);
    if (this.fatal) throw new CodexAppServerProtocolError('closed', 'app-server RPC is closed');
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    if (!Number.isSafeInteger(this.nextRequestId)) {
      throw new CodexAppServerProtocolError('state_invalid', 'app-server request id exhausted');
    }
    const frame = this.encodeValue({ method, id, params });
    const result = deferred<unknown>();
    const key = idKey(id);
    this.pending.set(key, { method, result });
    try {
      immediatelyBeforeWrite?.();
      await this.options.write(frame);
      afterWrite?.();
    } catch (error) {
      this.pending.delete(key);
      void result.promise.catch(() => undefined);
      result.reject(error);
      throw error;
    }
    return result.promise;
  }

  async notify(method: string): Promise<void> {
    this.assertOutgoing(method);
    if (this.fatal) throw new CodexAppServerProtocolError('closed', 'app-server RPC is closed');
    await this.writeValue({ method });
  }

  acceptStdout(chunk: Buffer): void {
    if (this.fatal) return;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.byteLength : newline;
      const segment = chunk.subarray(offset, end);
      if (this.partial.byteLength + segment.byteLength > MAX_FRAME_BYTES) {
        this.fail(
          new CodexAppServerProtocolError(
            'frame_too_large',
            'Codex app-server frame exceeded 1 MiB',
          ),
        );
        return;
      }
      if (segment.byteLength > 0) {
        this.partial =
          this.partial.byteLength === 0
            ? Buffer.from(segment)
            : Buffer.concat([this.partial, segment]);
      }
      if (newline === -1) return;
      const frame = this.partial;
      this.partial = Buffer.alloc(0);
      offset = newline + 1;
      if (frame.byteLength > 0 && frame.at(-1) === 0x0d) {
        this.handleFrame(frame.subarray(0, frame.byteLength - 1));
      } else {
        this.handleFrame(frame);
      }
      if (this.fatal) return;
    }
  }

  endStdout(): void {
    if (!this.fatal && this.partial.byteLength > 0) {
      this.fail(
        new CodexAppServerProtocolError(
          'frame_invalid',
          'Codex app-server ended with an incomplete JSON line',
        ),
      );
    }
  }

  fail(error: Error): void {
    if (this.fatal) return;
    this.fatal = true;
    this.partial = Buffer.alloc(0);
    for (const pending of this.pending.values()) pending.result.reject(error);
    this.pending.clear();
    this.incomingRequestIds.clear();
    this.options.onFatal(error);
  }

  shutdown(): void {
    if (this.fatal) return;
    this.fatal = true;
    const error = new CodexAppServerProtocolError('closed', 'app-server RPC closed');
    for (const pending of this.pending.values()) pending.result.reject(error);
    this.pending.clear();
    this.incomingRequestIds.clear();
    this.partial = Buffer.alloc(0);
  }

  abandonIncomingRequest(id: RpcId): boolean {
    return this.incomingRequestIds.delete(idKey(id));
  }

  private handleFrame(frame: Buffer): void {
    if (frame.byteLength === 0) {
      this.fail(new CodexAppServerProtocolError('frame_invalid', 'Empty app-server JSON line'));
      return;
    }
    let value: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
      value = JSON.parse(text) as unknown;
    } catch {
      this.fail(
        new CodexAppServerProtocolError(
          'frame_invalid',
          'Codex app-server emitted invalid UTF-8 JSON',
        ),
      );
      return;
    }
    const boundsIssue = validateJsonBounds(value, {
      maxBytes: MAX_FRAME_BYTES,
      maxDepth: 16,
      maxItems: 1_024,
      maxStringBytes: MAX_FRAME_BYTES,
    });
    if (boundsIssue) {
      this.fail(
        new CodexAppServerProtocolError(
          'frame_invalid',
          'App-server JSON exceeded structural bounds',
        ),
      );
      return;
    }
    if (!isObject(value) || 'jsonrpc' in value) {
      this.fail(new CodexAppServerProtocolError('frame_invalid', 'Malformed app-server envelope'));
      return;
    }
    const hasId = Object.hasOwn(value, 'id');
    const hasMethod = Object.hasOwn(value, 'method');
    const hasResult = Object.hasOwn(value, 'result');
    const hasError = Object.hasOwn(value, 'error');
    if (hasMethod) {
      if (hasResult || hasError) {
        this.fail(
          new CodexAppServerProtocolError('frame_invalid', 'Malformed RPC method envelope'),
        );
        return;
      }
      if (typeof value.method !== 'string' || value.method.length === 0) {
        this.fail(new CodexAppServerProtocolError('frame_invalid', 'Invalid app-server method'));
        return;
      }
      if (hasId) this.handleIncomingRequest(value);
      else {
        if (!isCodexAppServerIncomingNotificationMethod(value.method)) {
          this.fail(
            new CodexAppServerProtocolError(
              'forbidden_method',
              `Unsupported Codex server notification: ${value.method}`,
            ),
          );
          return;
        }
        try {
          this.options.onNotification(value.method, value.params);
        } catch (error) {
          this.fail(
            error instanceof Error
              ? error
              : new CodexAppServerProtocolError('frame_invalid', 'Notification handling failed'),
          );
        }
      }
      return;
    }
    if (!hasId || hasResult === hasError) {
      this.fail(new CodexAppServerProtocolError('response_invalid', 'Malformed RPC response'));
      return;
    }
    this.handleResponse(value);
  }

  private handleResponse(value: JsonObject): void {
    if (!isRpcId(value.id)) {
      this.fail(new CodexAppServerProtocolError('response_invalid', 'Invalid RPC response id'));
      return;
    }
    const key = idKey(value.id);
    const pending = this.pending.get(key);
    if (!pending) {
      const qualifier = this.completed.has(key) ? 'duplicate' : 'unknown';
      this.fail(
        new CodexAppServerProtocolError(
          'response_invalid',
          `Codex app-server returned a ${qualifier} response id`,
        ),
      );
      return;
    }
    this.pending.delete(key);
    this.rememberCompleted(key);
    if (Object.hasOwn(value, 'error')) {
      const errorCode =
        isObject(value.error) && typeof value.error.code === 'number'
          ? value.error.code
          : 'unknown';
      pending.result.reject(
        new CodexAppServerProtocolError(
          'response_invalid',
          `Codex app-server rejected ${pending.method} (${errorCode})`,
        ),
      );
      return;
    }
    pending.result.resolve(value.result);
  }

  private handleIncomingRequest(value: JsonObject): void {
    if (!isRpcId(value.id) || typeof value.method !== 'string') {
      this.fail(new CodexAppServerProtocolError('frame_invalid', 'Invalid server request'));
      return;
    }
    const key = idKey(value.id);
    if (this.incomingRequestIds.has(key)) {
      this.fail(new CodexAppServerProtocolError('response_invalid', 'Duplicate server request id'));
      return;
    }
    if (!isCodexAppServerIncomingMethod(value.method)) {
      this.fail(
        new CodexAppServerProtocolError(
          'forbidden_method',
          `Unsupported Codex server request: ${value.method}`,
        ),
      );
      return;
    }
    this.incomingRequestIds.add(key);
    let responded = false;
    const respond = async (payload: JsonObject): Promise<void> => {
      if (responded || !this.incomingRequestIds.delete(key)) {
        throw new CodexAppServerProtocolError(
          'response_invalid',
          'Server request already resolved',
        );
      }
      responded = true;
      await this.writeValue({ id: value.id, ...payload });
    };
    const request: IncomingRequestResponder = {
      id: value.id,
      method: value.method,
      params: value.params,
      respond: (result) => respond({ result }),
      reject: (code, safeMessage) => respond({ error: { code, message: safeMessage } }),
    };
    let handling: void | Promise<void>;
    try {
      handling = this.options.onRequest(request);
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new CodexAppServerProtocolError('interaction_invalid', 'Server request failed'),
      );
      return;
    }
    Promise.resolve(handling).catch((error: unknown) => {
      this.fail(
        error instanceof Error
          ? error
          : new CodexAppServerProtocolError('interaction_invalid', 'Server request failed'),
      );
    });
  }

  private async writeValue(value: JsonObject): Promise<void> {
    await this.options.write(this.encodeValue(value));
  }

  private encodeValue(value: JsonObject): Buffer {
    let encoded: Buffer;
    try {
      encoded = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    } catch {
      throw new CodexAppServerProtocolError('frame_invalid', 'RPC payload is not JSON data');
    }
    if (encoded.byteLength > MAX_FRAME_BYTES) {
      throw new CodexAppServerProtocolError('frame_too_large', 'Outgoing RPC frame exceeded 1 MiB');
    }
    return encoded;
  }

  private assertOutgoing(method: string): void {
    if (!isCodexAppServerOutgoingMethod(method)) {
      throw new CodexAppServerProtocolError(
        'forbidden_method',
        `Codex app-server method is not allowlisted: ${method}`,
      );
    }
  }

  private rememberCompleted(key: string): void {
    this.completed.add(key);
    this.completedOrder.push(key);
    if (this.completedOrder.length <= MAX_COMPLETED_REQUEST_IDS) return;
    const evicted = this.completedOrder.shift();
    if (evicted !== undefined) this.completed.delete(evicted);
  }
}
