import { randomUUID } from 'node:crypto';
import { spawnProcess, type SpawnResult } from '../process/spawn-process.js';

/** Bounds chosen to be generous for real MCP servers while making resource exhaustion bounded,
 * not to model any particular server's real limits. */
export const MCP_MAX_LINE_BYTES = 4 * 1024 * 1024;
export const MCP_MAX_PENDING_LINES = 256;
export const MCP_MAX_STDERR_BYTES = 16 * 1024;
export const MCP_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class McpTransportError extends Error {
  constructor(
    readonly code:
      | 'spawn_failed'
      | 'crashed'
      | 'closed'
      | 'timeout'
      | 'overflow'
      | 'protocol_error',
    message: string,
  ) {
    super(message);
    this.name = 'McpTransportError';
  }
}

interface JsonRpcRequestFrame {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}
interface JsonRpcNotificationFrame {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
interface JsonRpcResponseFrame {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Newline-delimited JSON-RPC 2.0 over a spawned process's stdio -- the wire framing every real
 * MCP stdio server speaks (no Content-Length headers, unlike LSP). Owns spawn, line framing with
 * a bounded buffer, bounded stderr capture, per-request timeout, and always reaps the process tree
 * through `spawnProcess`'s existing Windows Job Object / POSIX process-group discipline -- this
 * class never implements its own kill logic.
 */
export class StdioJsonRpcTransport {
  private readonly spawned: SpawnResult;
  private readonly pending = new Map<string, PendingRequest>();
  private lineBuffer = '';
  private stderrBuffer = '';
  private closed = false;
  private crashError: McpTransportError | undefined;
  readonly crashSignal: Promise<void>;
  private resolveCrash!: () => void;

  constructor(command: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) {
    this.spawned = spawnProcess(command, args, { cwd: opts.cwd, env: opts.env });
    this.crashSignal = new Promise((resolve) => {
      this.resolveCrash = resolve;
    });
    this.spawned.child.stdout.setEncoding('utf8');
    this.spawned.child.stdout.on('data', (chunk: string) => this.onStdoutChunk(chunk));
    this.spawned.child.stderr.setEncoding('utf8');
    this.spawned.child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-MCP_MAX_STDERR_BYTES);
    });
    void this.spawned.exit.then((result) => {
      if (this.closed) return;
      this.failAllPending(
        new McpTransportError(
          'crashed',
          `MCP server process exited unexpectedly (code=${String(result.code)}, signal=${String(result.signal)})`,
        ),
      );
    });
  }

  get pid(): number | undefined {
    return this.spawned.child.pid;
  }

  get stderrTail(): string {
    return this.stderrBuffer;
  }

  private onStdoutChunk(chunk: string): void {
    this.lineBuffer += chunk;
    if (this.lineBuffer.length > MCP_MAX_LINE_BYTES && !this.lineBuffer.includes('\n')) {
      this.failAllPending(
        new McpTransportError('overflow', 'MCP server sent a line exceeding the maximum frame size'),
      );
      void this.close();
      return;
    }
    let newlineIndex: number;
    let framesSeen = 0;
    while ((newlineIndex = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      framesSeen += 1;
      if (framesSeen > MCP_MAX_PENDING_LINES) {
        this.failAllPending(
          new McpTransportError('overflow', 'MCP server sent more frames than this connection allows'),
        );
        void this.close();
        return;
      }
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // A non-JSON-RPC line (stray log output) is ignored, not fatal.
    }
    if (!parsed || typeof parsed !== 'object' || !('id' in parsed)) return;
    const frame = parsed as JsonRpcResponseFrame;
    const key = String(frame.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (frame.error) {
      pending.reject(new McpTransportError('protocol_error', frame.error.message));
      return;
    }
    pending.resolve(frame.result);
  }

  private failAllPending(error: McpTransportError): void {
    this.crashError = error;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.resolveCrash();
  }

  async request(method: string, params: unknown, timeoutMs = MCP_DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) throw new McpTransportError('closed', 'MCP connection is closed');
    if (this.crashError) throw this.crashError;
    const id = randomUUID();
    const frame: JsonRpcRequestFrame = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpTransportError('timeout', `MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const written = this.spawned.child.stdin.write(`${JSON.stringify(frame)}\n`);
      if (!written) {
        // Backpressure alone isn't fatal; the write is still queued. Nothing further to do here.
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || this.crashError) return;
    const frame: JsonRpcNotificationFrame = { jsonrpc: '2.0', method, params };
    this.spawned.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(new McpTransportError('closed', 'MCP connection was closed'));
    try {
      this.spawned.child.stdin.end();
    } catch {
      // stdin may already be gone if the process crashed; the tree-kill below still runs.
    }
    await this.spawned.kill();
  }
}
