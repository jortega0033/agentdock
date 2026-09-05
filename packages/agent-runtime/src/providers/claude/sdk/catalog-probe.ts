import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  query as nativeQuery,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import type { ProviderModelCatalogEntry } from '../../../types.js';
import { ClaudeSdkInputChannel } from './channel.js';
import { ClaudeAgentSdkProtocolError } from './errors.js';
import type {
  ClaudeAgentSdkFactory,
  ClaudeAgentSdkManagedSpawn,
  ClaudeAgentSdkQuery,
} from './transport.js';
import {
  buildClaudeSdkOptions,
  prepareClaudeSdkConfigDirectory,
  removeClaudeSdkConfigDirectory,
  resolveClaudeSdkConfigDir,
} from '../sdk-options.js';
import type { ClaudeSdkAuthResolution } from '../sdk-auth.js';
import { createClaudeSdkManagedProcessSpawner } from '../sdk-process.js';

const CATALOG_TIMEOUT_MS = 10_000;
const DEFAULT_MODEL_TIMEOUT_MS = 3_000;
const REAP_TIMEOUT_MS = 2_500;

export interface ClaudeModelCatalogProbeOptions {
  executable: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  auth: ClaudeSdkAuthResolution & { eligible: true };
  signal?: AbortSignal;
  runtimePlatform?: NodeJS.Platform;
  /** Root for the probe's own throwaway, isolated config directory. Defaults to the OS temp root
   * since a catalog read has no daemon session to persist state for. */
  daemonConfigRoot?: string;
  /** Test seam only. */
  factory?: ClaudeAgentSdkFactory;
  /** Test seam only. */
  spawn?: Parameters<typeof createClaudeSdkManagedProcessSpawner>[0]['spawn'];
}

const defaultFactory: ClaudeAgentSdkFactory = {
  query: (parameters) => nativeQuery(parameters),
};

function boundedBoolean(proof: Promise<boolean>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), milliseconds);
    timer.unref?.();
    void proof.then(finish, () => finish(false));
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  code: string,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(
      new ClaudeAgentSdkProtocolError('claude_sdk_closed', 'Claude SDK catalog probe was cancelled'),
    );
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
      finish(() =>
        reject(new ClaudeAgentSdkProtocolError('claude_sdk_closed', 'Claude SDK catalog probe was cancelled')),
      );
    };
    const timer = setTimeout(() => {
      finish(() => reject(new ClaudeAgentSdkProtocolError(code, message)));
    }, milliseconds);
    timer.unref?.();
    signal?.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/**
 * Reads the live Claude Agent SDK model catalog without ever delivering a real prompt/turn --
 * backs `GET /v2/providers/:providerId/models` (issue #110) the same way Codex's app-server
 * `fetchCodexModelCatalog()` does for that provider.
 *
 * The SDK's `supportedModels()`/`next()` control calls only exist on an already-started `Query`
 * (streaming-input mode), so this spawns a real Claude CLI process through the same daemon-owned
 * managed spawner and locked-down environment `startInteractiveSession()` uses, but feeds it an
 * input channel that is never given a message -- `supportedModels()` and the session's resolved
 * default model (read from the first `system`/`init` stream message, best-effort) are both
 * control-protocol reads, not conversation turns, so nothing is ever sent to the model itself.
 */
export async function probeClaudeModelCatalog(
  options: ClaudeModelCatalogProbeOptions,
): Promise<readonly ProviderModelCatalogEntry[]> {
  const factory = options.factory ?? defaultFactory;
  const platform = options.runtimePlatform ?? process.platform;
  const sessionId = randomUUID();
  const daemonConfigRoot = options.daemonConfigRoot ?? tmpdir();
  const configDirectory = resolveClaudeSdkConfigDir(daemonConfigRoot, sessionId);
  await prepareClaudeSdkConfigDirectory(daemonConfigRoot, configDirectory);

  const abortController = new AbortController();
  const relayAbort = (): void => abortController.abort();
  options.signal?.addEventListener('abort', relayAbort, { once: true });

  const channel = new ClaudeSdkInputChannel<SDKUserMessage>();
  let query: ClaudeAgentSdkQuery | undefined;
  let managedSpawn: ClaudeAgentSdkManagedSpawn | undefined;
  try {
    const sdkOptions = buildClaudeSdkOptions({
      cwd: options.cwd,
      env: options.env,
      auth: options.auth,
      trustState: 'untrusted',
      daemonConfigRoot,
      sessionId,
    });
    const managedProcessSpawner = createClaudeSdkManagedProcessSpawner({
      executable: options.executable,
      cwd: options.cwd,
      authSource: options.auth.source,
      expectedEnvironment: sdkOptions.env ?? {},
      runtimePlatform: platform,
      ...(options.spawn ? { spawn: options.spawn } : {}),
    });
    const spawnClaudeCodeProcess = (spawnOptions: SpawnOptions): SpawnedProcess => {
      managedSpawn = managedProcessSpawner(spawnOptions);
      return managedSpawn.process;
    };

    query = factory.query({
      prompt: channel.stream(),
      options: {
        ...sdkOptions,
        abortController,
        pathToClaudeCodeExecutable: options.executable,
        includePartialMessages: false,
        canUseTool: async () => ({
          behavior: 'deny',
          message: 'Model catalog probe does not execute tools',
        }),
        onUserDialog: async () => ({ behavior: 'cancelled' }),
        supportedDialogKinds: [],
        stderr: () => undefined,
        spawnClaudeCodeProcess,
      },
    });

    if (!query.supportedModels) {
      throw new ClaudeAgentSdkProtocolError(
        'claude_sdk_options_invalid',
        'Claude SDK query does not expose a model catalog',
      );
    }
    const models = await withTimeout(
      query.supportedModels(),
      CATALOG_TIMEOUT_MS,
      'claude_sdk_catalog_timeout',
      'Claude SDK model catalog request timed out',
      options.signal,
    );

    let defaultModel: string | undefined;
    if (query.next) {
      try {
        const first = await withTimeout(
          query.next(),
          DEFAULT_MODEL_TIMEOUT_MS,
          'claude_sdk_init_timeout',
          'Claude SDK init message timed out',
          options.signal,
        );
        if (!first.done && first.value.type === 'system' && first.value.subtype === 'init') {
          defaultModel = first.value.model;
        }
      } catch {
        // Best-effort only: the catalog itself is still useful without a default flag.
      }
    }

    return Object.freeze(
      models.map((model) =>
        Object.freeze({
          id: model.value,
          displayName: model.displayName,
          isDefault:
            defaultModel !== undefined &&
            (model.value === defaultModel || model.resolvedModel === defaultModel),
        }),
      ),
    );
  } finally {
    channel.close();
    query?.close();
    abortController.abort();
    options.signal?.removeEventListener('abort', relayAbort);
    if (managedSpawn) {
      const reaped = await boundedBoolean(
        managedSpawn.reaped.then(
          () => true,
          () => false,
        ),
        REAP_TIMEOUT_MS,
      );
      if (!reaped) await managedSpawn.forceClose();
    }
    await removeClaudeSdkConfigDirectory(configDirectory).catch(() => undefined);
  }
}
