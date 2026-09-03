import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { terminateProcessTree, type ProcessExitResult } from '../../../process/spawn-process.js';
import { buildLegacyProviderEnvironment } from '../../../process/provider-environment.js';
import {
  encodeWindowsJobHostArguments,
  resolveWindowsJobHostPath,
} from '../../../process/windows-job-host.js';
import { FailableChannel } from './channel.js';
import { CodexAppServerProtocolError } from './errors.js';

export interface ManagedAppServerProcessOptions {
  executable: string;
  executableArgs?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test/development override. Production resolves the helper beside the bundled daemon. */
  windowsJobHostPath?: string;
  /** Test seam only. */
  platform?: NodeJS.Platform;
  onStdout(chunk: Buffer): void;
  onStdoutEnd(): void;
  onFailure(error: Error): void;
}

const MAX_STDERR_SUMMARIES = 128;
const WINDOWS_READY_TIMEOUT_MS = 10_000;
const MAX_WINDOWS_HANDSHAKE_BYTES = 512;
const MAX_PRE_READY_STDOUT_BYTES = 1024 * 1024;
const WINDOWS_REAP_TIMEOUT_MS = 5_000;

async function waitWithin<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Owns a single app-server process group and never exposes raw stderr bytes. */
export class ManagedAppServerProcess {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly exitPromise: Promise<ProcessExitResult>;
  private readonly stderrChannel = new FailableChannel<unknown>(MAX_STDERR_SUMMARIES);
  private readonly platform: NodeJS.Platform;
  private readonly usesWindowsJobHost: boolean;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readySettled = false;
  private readySucceeded = false;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeBuffer = Buffer.alloc(0);
  private preReadyStdout: Buffer[] = [];
  private preReadyStdoutBytes = 0;
  private stdoutEndedBeforeReady = false;
  private closing = false;
  private exited = false;
  private treeReaped = false;
  private reaping: Promise<void> | undefined;
  private reapFailure: Error | undefined;
  readonly stderr = this.stderrChannel[Symbol.asyncIterator]();
  readonly ready: Promise<void>;

  get reaped(): boolean {
    return this.exited && this.treeReaped;
  }

  constructor(private readonly options: ManagedAppServerProcessOptions) {
    this.platform = options.platform ?? process.platform;
    this.usesWindowsJobHost = this.platform === 'win32';
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const providerArgs = [...(options.executableArgs ?? []), 'app-server', '--stdio'];
    const command = this.usesWindowsJobHost
      ? resolveWindowsJobHostPath(options.windowsJobHostPath)
      : options.executable;
    const args = this.usesWindowsJobHost
      ? encodeWindowsJobHostArguments({
          ownerPid: process.pid,
          executable: options.executable,
          cwd: options.cwd,
          args: providerArgs,
        })
      : providerArgs;
    this.child = spawn(command, args, {
      cwd: options.cwd,
      // Sanitized by default (issue #53): never silently inherit the daemon's full process.env.
      env: options.env ?? buildLegacyProviderEnvironment(process.env, { provider: 'codex' }),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !this.usesWindowsJobHost,
    });
    if (!this.usesWindowsJobHost) this.setReady();
    else {
      this.readyTimer = setTimeout(() => {
        this.failReady('Windows Job Object host readiness timed out');
        if (!this.exited) this.child.kill('SIGKILL');
      }, WINDOWS_READY_TIMEOUT_MS);
      this.readyTimer.unref();
    }
    this.exitPromise = new Promise<ProcessExitResult>((resolve) => {
      let settled = false;
      const settle = (result: ProcessExitResult): void => {
        if (settled) return;
        settled = true;
        this.exited = true;
        resolve(result);
      };
      this.child.once('exit', (code, signal) => settle({ code, signal }));
      this.child.once('error', (error) => {
        settle({ code: null, signal: null });
        if (!this.readySettled) this.failReady('Windows Job Object host could not start');
        else if (!this.closing) options.onFailure(this.processError(error));
      });
    });

    this.child.stdout.on('data', (chunk: Buffer | string) => {
      this.acceptStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    this.child.stdout.once('end', () => {
      if (this.usesWindowsJobHost && !this.readySettled) this.stdoutEndedBeforeReady = true;
      else this.endStdout();
    });
    this.child.stdout.once('error', (error) => {
      if (!this.closing) options.onFailure(this.processError(error));
    });
    this.child.stdin.once('error', (error) => {
      if (!this.closing) options.onFailure(this.processError(error));
    });
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (this.usesWindowsJobHost && !this.readySettled) this.acceptWindowsHandshake(buffer);
      else this.redactStderr(buffer);
    });
    this.child.stderr.once('end', () => this.stderrChannel.close());
    this.child.stderr.once('error', () => this.stderrChannel.close());
    void this.exitPromise.then(({ code, signal }) => {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      if (!this.readySettled) this.failReady('Windows Job Object host exited before readiness');
      this.stderrChannel.close();
      if (!this.closing) {
        options.onFailure(
          new CodexAppServerProtocolError(
            'process_failed',
            `Codex app-server exited unexpectedly (${signal ?? code ?? 'unknown'})`,
          ),
        );
      }
    });
  }

  async write(frame: Buffer): Promise<void> {
    await this.ready;
    if (this.closing || this.exited || this.child.stdin.destroyed) {
      throw new CodexAppServerProtocolError('closed', 'app-server stdin is closed');
    }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(frame, (error) => {
        if (error) reject(this.processError(error));
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    await this.reapTree();
  }

  async forceClose(): Promise<void> {
    return this.reapTree();
  }

  private reapTree(): Promise<void> {
    if (this.reapFailure) return Promise.reject(this.reapFailure);
    if (this.reaping) return this.reaping;
    this.reaping = this.killAndReap()
      .then(() => {
        this.treeReaped = true;
      })
      .catch((error: unknown) => {
        this.treeReaped = false;
        this.reapFailure = error instanceof Error ? error : new Error(String(error));
        throw this.reapFailure;
      });
    return this.reaping;
  }

  private async killAndReap(): Promise<void> {
    this.closing = true;
    if (this.usesWindowsJobHost) {
      // The shipped helper is the sole holder of an unnamed KILL_ON_JOB_CLOSE Job Object. Its
      // exit is therefore the proof boundary: normal exit follows ActiveProcesses==0; forced
      // exit closes the last handle and makes Windows terminate the complete owned tree.
      if (!this.exited) this.child.kill('SIGKILL');
      try {
        await waitWithin(
          this.exitPromise,
          WINDOWS_REAP_TIMEOUT_MS,
          'Windows Job Object host could not be confirmed reaped',
        );
      } catch {
        throw new CodexAppServerProtocolError(
          'process_failed',
          'Codex app-server process tree could not be confirmed reaped',
        );
      }
      return;
    }
    try {
      await terminateProcessTree(this.child, this.exitPromise, () => this.exited, {
        platform: this.platform,
      });
    } catch {
      throw new CodexAppServerProtocolError(
        'process_failed',
        'Codex app-server process tree could not be confirmed reaped',
      );
    }
  }

  private processError(error: Error): CodexAppServerProtocolError {
    const code = (error as NodeJS.ErrnoException).code;
    return new CodexAppServerProtocolError(
      'process_failed',
      `Codex app-server process I/O failed (${code ?? 'unknown'})`,
    );
  }

  private callbackError(error: unknown): CodexAppServerProtocolError {
    return error instanceof CodexAppServerProtocolError
      ? error
      : new CodexAppServerProtocolError('frame_invalid', 'App-server stream handling failed');
  }

  private setReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readySucceeded = true;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    const buffered = this.preReadyStdout;
    this.preReadyStdout = [];
    this.preReadyStdoutBytes = 0;
    for (const chunk of buffered) this.deliverStdout(chunk);
    if (this.stdoutEndedBeforeReady) this.endStdout();
    this.readyResolve();
  }

  private failReady(message: string): void {
    if (this.readySettled) return;
    this.readySettled = true;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.handshakeBuffer.byteLength > 0) {
      this.stderrChannel.push(
        `Windows Job Object host startup stderr redacted (${this.handshakeBuffer.byteLength} bytes)`,
      );
    }
    this.handshakeBuffer = Buffer.alloc(0);
    this.preReadyStdout = [];
    this.preReadyStdoutBytes = 0;
    const error = new CodexAppServerProtocolError('process_failed', message);
    this.readyReject(error);
    if (!this.closing) this.options.onFailure(error);
  }

  private acceptWindowsHandshake(chunk: Buffer): void {
    if (this.readySettled) {
      this.redactStderr(chunk);
      return;
    }
    const combined = Buffer.concat([this.handshakeBuffer, chunk]);
    const newline = combined.indexOf(0x0a);
    if (newline < 0 && combined.byteLength > MAX_WINDOWS_HANDSHAKE_BYTES) {
      this.handshakeBuffer = combined.subarray(0, MAX_WINDOWS_HANDSHAKE_BYTES);
      this.failReady('Windows Job Object host emitted an invalid readiness handshake');
      if (!this.exited) this.child.kill('SIGKILL');
      return;
    }
    if (newline < 0) {
      this.handshakeBuffer = combined;
      return;
    }
    const line = combined.subarray(0, newline + 1);
    const remainder = combined.subarray(newline + 1);
    if (
      line.byteLength > MAX_WINDOWS_HANDSHAKE_BYTES ||
      !/^ADJH\/1 READY [1-9]\d*\r?\n$/u.test(line.toString('ascii'))
    ) {
      this.failReady('Windows Job Object host emitted an invalid readiness handshake');
      if (!this.exited) this.child.kill('SIGKILL');
      return;
    }
    this.handshakeBuffer = Buffer.alloc(0);
    this.setReady();
    if (remainder.byteLength > 0) this.redactStderr(remainder);
  }

  private acceptStdout(chunk: Buffer): void {
    if (!this.usesWindowsJobHost || this.readySucceeded) {
      this.deliverStdout(chunk);
      return;
    }
    if (this.readySettled) return;
    this.preReadyStdoutBytes += chunk.byteLength;
    if (this.preReadyStdoutBytes > MAX_PRE_READY_STDOUT_BYTES) {
      this.failReady('Windows Job Object host emitted output before readiness');
      if (!this.exited) this.child.kill('SIGKILL');
      return;
    }
    this.preReadyStdout.push(chunk);
  }

  private deliverStdout(chunk: Buffer): void {
    try {
      this.options.onStdout(chunk);
    } catch (error) {
      this.options.onFailure(this.callbackError(error));
    }
  }

  private endStdout(): void {
    try {
      this.options.onStdoutEnd();
    } catch (error) {
      this.options.onFailure(this.callbackError(error));
    }
  }

  private redactStderr(chunk: Buffer): void {
    // Preserve only a bounded fact, never provider text that could contain credentials/prompts.
    this.stderrChannel.push(`Codex app-server stderr redacted (${chunk.byteLength} bytes)`);
  }
}
