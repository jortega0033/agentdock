import type { ProviderStatus } from '@agent-dock/shared';
import type { ProviderContinuationEvidence, ProviderModelCatalogEntry } from '../../../types.js';
import { CodexAppServerProtocolError } from './errors.js';
import { ManagedAppServerProcess } from './managed-process.js';
import { CodexAppServerRpc } from './rpc.js';
import {
  parseCodexAccountScope,
  parseCodexModelCatalog,
  resolveCodexSelectedModel,
  toCodexContinuationEvidence,
} from './scope-evidence.js';

export interface CodexAppServerScopeProbeOptions {
  executable: string;
  cwd: string;
  providerStatus: ProviderStatus;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Test seam only. */
  executableArgs?: readonly string[];
  /** Test seam only. */
  processPlatform?: NodeJS.Platform;
  /** Test/development override for the packaged Windows Job Object host. */
  windowsJobHostPath?: string;
}

export interface CodexAppServerCatalogProbeOptions {
  executable: string;
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Test seam only. */
  executableArgs?: readonly string[];
  /** Test seam only. */
  processPlatform?: NodeJS.Platform;
  /** Test/development override for the packaged Windows Job Object host. */
  windowsJobHostPath?: string;
}

const SCOPE_PROBE_TIMEOUT_MS = 4_000;

function waitForProbe<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new CodexAppServerProtocolError('closed', 'Scope probe was cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      callback();
    };
    const aborted = (): void => {
      finish(() => reject(new CodexAppServerProtocolError('closed', 'Scope probe was cancelled')));
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(new CodexAppServerProtocolError('process_failed', 'Scope probe timed out')),
      );
    }, SCOPE_PROBE_TIMEOUT_MS);
    timer.unref?.();
    signal?.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

interface CodexAppServerRpcHostOptions {
  executable: string;
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  executableArgs?: readonly string[];
  processPlatform?: NodeJS.Platform;
  windowsJobHostPath?: string;
}

/**
 * Opens a short-lived app-server process, completes the `initialize`/`initialized` handshake, runs
 * `body` against the live RPC connection, and always tears the process down afterward -- the shared
 * scaffold behind every read-only scope/catalog probe. No thread or turn request is ever sent, so
 * unsupported versions can prove exec equivalence without becoming rich transports.
 */
async function withCodexAppServerRpc<T>(
  options: CodexAppServerRpcHostOptions,
  body: (rpc: CodexAppServerRpc) => Promise<T>,
): Promise<T> {
  const rpcRef: { current?: CodexAppServerRpc } = {};
  const processHost = new ManagedAppServerProcess({
    executable: options.executable,
    executableArgs: options.executableArgs,
    cwd: options.cwd,
    env: options.env,
    platform: options.processPlatform,
    windowsJobHostPath: options.windowsJobHostPath,
    onStdout: (chunk) => rpcRef.current?.acceptStdout(chunk),
    onStdoutEnd: () => rpcRef.current?.endStdout(),
    onFailure: (error) => rpcRef.current?.fail(error),
  });
  const rpc = new CodexAppServerRpc({
    write: (frame) => processHost.write(frame),
    onNotification: () => undefined,
    onRequest: () => {
      throw new CodexAppServerProtocolError(
        'forbidden_method',
        'Codex app-server requested interaction during a read-only probe',
      );
    },
    onFatal: () => undefined,
  });
  rpcRef.current = rpc;

  let succeeded = false;
  try {
    const result = await waitForProbe(
      (async () => {
        await processHost.ready;
        await rpc.request('initialize', {
          clientInfo: { name: 'agent_dock', title: 'Agent Dock', version: '0.1.0' },
          capabilities: null,
        });
        await rpc.notify('initialized');
        return body(rpc);
      })(),
      options.signal,
    );
    succeeded = true;
    return result;
  } finally {
    rpc.shutdown();
    if (succeeded) await processHost.close();
    else await processHost.forceClose();
  }
}

/**
 * Reads only stable, non-mutating app-server account/model metadata. No thread or turn request is
 * sent, so unsupported versions can prove exec equivalence without becoming rich transports.
 */
export async function probeCodexAppServerScope(
  options: CodexAppServerScopeProbeOptions,
): Promise<Readonly<ProviderContinuationEvidence> | undefined> {
  return withCodexAppServerRpc(options, async (rpc) => {
    const account = parseCodexAccountScope(await rpc.request('account/read', { refreshToken: false }));
    if (
      !options.providerStatus.authSource ||
      options.providerStatus.authSource === 'unknown' ||
      account.authSource !== options.providerStatus.authSource
    ) {
      throw new CodexAppServerProtocolError(
        'state_invalid',
        'Codex authentication source changed during scope probe',
      );
    }
    const catalog = parseCodexModelCatalog(
      await rpc.request('model/list', { limit: 1_024, includeHidden: false }),
    );
    const selectedModel = resolveCodexSelectedModel(catalog, options.providerStatus.selectedModel);
    return toCodexContinuationEvidence(account, selectedModel);
  });
}

/**
 * Reads the live Codex app-server model catalog without resolving account scope or a selected
 * model -- backs `GET /v2/providers/:providerId/models` so a caller can discover valid `model`
 * values for `POST /v2/sessions` before requesting one.
 */
export async function fetchCodexModelCatalog(
  options: CodexAppServerCatalogProbeOptions,
): Promise<readonly ProviderModelCatalogEntry[]> {
  return withCodexAppServerRpc(options, async (rpc) =>
    parseCodexModelCatalog(await rpc.request('model/list', { limit: 1_024, includeHidden: false })),
  );
}
