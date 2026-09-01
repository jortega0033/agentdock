import type { ProviderStatus } from '@agent-dock/shared';
import type {
  AgentProvider,
  InteractiveProviderSessionHandle,
  ProviderDetectionOptions,
  ProviderSessionHandle,
  ProviderV2Support,
  StartInteractiveSessionOptions,
  StartSessionOptions,
} from '../../types.js';
import { ProviderTransportStartupError } from '../../types.js';
import { type Logger, noopLogger } from '../../logger.js';
import { execCapture } from '../../process/exec-capture.js';
import { runProviderSession } from '../common/run-session.js';
import { superviseInteractiveSession } from '../common/session-supervisor.js';
import { buildClaudeArgs } from './build-args.js';
import { detectClaude } from './detect.js';
import { parseClaudeLine } from './parser.js';
import { createClaudeAgentSdkTransport } from './sdk/index.js';
import { resolveClaudeSdkAuth } from './sdk-auth.js';
import {
  resolveClaudeSdkExecutable,
  type ClaudeSdkExecutableResolution,
} from './sdk-executable.js';
import { buildClaudeSdkOptions } from './sdk-options.js';
import { createClaudeSdkManagedProcessSpawner, sameClaudeSdkPath } from './sdk-process.js';
import { CLAUDE_AGENT_SDK_TRANSPORT_ID, resolveClaudeSdkV2Support } from './sdk-support.js';
import { CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION } from './sdk-version.js';
import { resolveClaudeTransportMode } from './transport-mode.js';
import { ProviderCliMcpControlPlane } from '../../mcp-control.js';

export const CLAUDE_PROMPT_VIA_STDIN = true;

type ClaudeSdkTransport = ReturnType<typeof createClaudeAgentSdkTransport>;

export interface ClaudeProviderDependencies {
  env(): NodeJS.ProcessEnv;
  runtimePlatform(): NodeJS.Platform;
  detectCli(options?: ProviderDetectionOptions): Promise<ProviderStatus>;
  resolveSdkExecutable(): ClaudeSdkExecutableResolution;
  probeSdkVersion(executable: string): Promise<string | undefined>;
  createSdkTransport: typeof createClaudeAgentSdkTransport;
  createManagedSpawner: typeof createClaudeSdkManagedProcessSpawner;
}

export function parseClaudeSdkVersion(output: string): string | undefined {
  // Version output is provider-controlled; inspect a bounded prefix so malformed output cannot
  // force an unbounded regex scan or pathological backtracking.
  const version = output
    .slice(0, 4_096)
    .match(
      /(?<!\d)\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z]{1,32}(?:\.[0-9A-Za-z]{1,32}){0,8})?(?:\+[0-9A-Za-z]{1,32}(?:\.[0-9A-Za-z]{1,32}){0,8})?\b/,
    );
  return version?.[0];
}

/**
 * Runs only the bundled SDK binary's version command. Keep this intentionally smaller than the
 * session environment: the Windows loader needs SystemRoot, but no credentials or SDK controls.
 */
export function buildClaudeSdkVersionProbeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const systemRoot = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
  return systemRoot === undefined ? {} : { SystemRoot: systemRoot };
}

async function probeClaudeSdkVersion(executable: string): Promise<string | undefined> {
  const result = await execCapture(executable, ['--version'], {
    env: buildClaudeSdkVersionProbeEnvironment(),
    timeoutMs: 8_000,
  });
  return result.code === 0 && !result.timedOut ? parseClaudeSdkVersion(result.stdout) : undefined;
}

/**
 * Claude provider. Permitted API/cloud auth uses the pinned Agent SDK transport; subscription
 * login and incompatible runtimes retain the existing local CLI path.
 */
export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly name = 'Claude Agent';
  readonly mcp = new ProviderCliMcpControlPlane({ provider: 'claude', executableName: 'claude' });

  private readonly dependencies: ClaudeProviderDependencies;

  constructor(
    private readonly logger: Logger = noopLogger,
    dependencies: Partial<ClaudeProviderDependencies> = {},
  ) {
    this.dependencies = {
      env: () => process.env,
      runtimePlatform: () => process.platform,
      detectCli: () => detectClaude(this.logger),
      resolveSdkExecutable: () => resolveClaudeSdkExecutable(),
      probeSdkVersion: probeClaudeSdkVersion,
      createSdkTransport: createClaudeAgentSdkTransport,
      createManagedSpawner: createClaudeSdkManagedProcessSpawner,
      ...dependencies,
    };
  }

  async detect(options?: ProviderDetectionOptions): Promise<ProviderStatus> {
    let mode;
    try {
      mode = resolveClaudeTransportMode(this.dependencies.env().AGENT_DOCK_CLAUDE_TRANSPORT);
    } catch {
      return this.dependencies.detectCli(options);
    }
    if (mode === 'cli') return this.dependencies.detectCli(options);

    const env = this.dependencies.env();
    const auth = resolveClaudeSdkAuth(env);
    const executable = this.dependencies.resolveSdkExecutable();
    if (!auth.eligible || !executable.ok || this.dependencies.runtimePlatform() !== 'win32') {
      return this.dependencies.detectCli(options);
    }
    const version = await this.dependencies.probeSdkVersion(executable.path);
    if (version !== CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION) {
      return this.dependencies.detectCli(options);
    }
    return {
      id: 'claude',
      name: 'Claude Agent',
      installed: true,
      authenticated: 'authenticated',
      authSource: auth.source,
      capabilities: {
        cancellation: true,
        tools: true,
        usage: true,
        thinking: true,
      },
      executablePath: executable.path,
      version,
    };
  }

  getV2Support(status: ProviderStatus): ProviderV2Support | undefined {
    const env = this.dependencies.env();
    const mode = resolveClaudeTransportMode(env.AGENT_DOCK_CLAUDE_TRANSPORT);
    const executable = this.dependencies.resolveSdkExecutable();
    const platform = this.dependencies.runtimePlatform();
    const assetMatches =
      executable.ok &&
      status.executablePath !== undefined &&
      sameClaudeSdkPath(executable.path, status.executablePath, platform);
    return resolveClaudeSdkV2Support(status, mode, env, {
      runtimePlatform: platform,
      sdkAssetAvailable: assetMatches,
      sdkClaudeCodeVersion: assetMatches ? status.version : undefined,
    });
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    let mode;
    try {
      mode = resolveClaudeTransportMode(this.dependencies.env().AGENT_DOCK_CLAUDE_TRANSPORT);
    } catch (error) {
      throw new ProviderTransportStartupError(
        'claude_transport_mode_invalid',
        'not_delivered',
        error instanceof Error ? error.message : 'Claude transport mode is invalid',
      );
    }
    if (mode === 'sdk') {
      throw new ProviderTransportStartupError(
        'claude_cli_transport_not_selected',
        'not_delivered',
        'Claude CLI transport is not selected',
      );
    }
    return runProviderSession(
      {
        providerId: 'claude',
        executableNames: ['claude'],
        buildArgs: buildClaudeArgs,
        parseLine: parseClaudeLine,
        promptViaStdin: CLAUDE_PROMPT_VIA_STDIN,
      },
      options,
      this.logger,
    );
  }

  async startInteractiveSession(
    options: StartInteractiveSessionOptions,
  ): Promise<InteractiveProviderSessionHandle> {
    const fail = (reasonCode: string, message: string): never => {
      throw new ProviderTransportStartupError(reasonCode, 'not_delivered', message);
    };
    let mode;
    try {
      mode = resolveClaudeTransportMode(this.dependencies.env().AGENT_DOCK_CLAUDE_TRANSPORT);
    } catch (error) {
      return fail(
        'claude_transport_mode_invalid',
        error instanceof Error ? error.message : 'Claude transport mode is invalid',
      );
    }
    if (mode === 'cli') {
      return fail('claude_sdk_not_selected', 'Claude Agent SDK transport is not selected');
    }
    if (options.transport.id !== CLAUDE_AGENT_SDK_TRANSPORT_ID) {
      return fail(
        'claude_sdk_transport_mismatch',
        'Selected transport does not match Claude Agent SDK',
      );
    }
    if (options.workspaceTrust?.state !== 'trusted') {
      return fail(
        'claude_sdk_workspace_untrusted',
        'Claude Agent SDK requires a trusted workspace',
      );
    }
    if (!options.providerStateDirectory) {
      return fail(
        'claude_sdk_state_unavailable',
        'Claude Agent SDK requires a daemon-owned state directory',
      );
    }
    if (options.continuation) {
      return fail(
        'claude_sdk_continuation_unavailable',
        'Claude Agent SDK continuation identity is not safely bindable',
      );
    }

    const status = options.providerStatus;
    const env = options.env ?? this.dependencies.env();
    const auth = resolveClaudeSdkAuth(env);
    const executable = this.dependencies.resolveSdkExecutable();
    const platform = this.dependencies.runtimePlatform();
    if (
      !status ||
      status.id !== 'claude' ||
      !status.installed ||
      status.authenticated !== 'authenticated' ||
      !auth.eligible ||
      status.authSource !== auth.source ||
      !status.executablePath ||
      !executable.ok ||
      !sameClaudeSdkPath(status.executablePath, executable.path, platform)
    ) {
      return fail(
        'claude_sdk_launch_unverified',
        'Claude Agent SDK requires an exact authenticated executable snapshot',
      );
    }
    const version = await this.dependencies.probeSdkVersion(executable.path);
    if (
      platform !== 'win32' ||
      version !== CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION ||
      status.version !== version
    ) {
      return fail(
        'claude_sdk_version_unsupported',
        'Detected Claude Agent SDK executable version is not validated',
      );
    }
    resolveClaudeSdkV2Support(status, mode, env, {
      runtimePlatform: platform,
      sdkAssetAvailable: true,
      sdkClaudeCodeVersion: version,
    });

    const sdkOptions = buildClaudeSdkOptions({
      cwd: options.cwd,
      env,
      auth,
      trustState: 'trusted',
      daemonConfigRoot: options.providerStateDirectory,
      sessionId: options.sessionId,
    });
    const managedProcessSpawner = this.dependencies.createManagedSpawner({
      executable: executable.path,
      cwd: options.cwd,
      authSource: auth.source,
      expectedEnvironment: sdkOptions.env ?? {},
      runtimePlatform: platform,
    });
    const { continuation: _continuation, transport: _transport, ...transportOptions } = options;
    void _continuation;
    void _transport;
    const transport: ClaudeSdkTransport = this.dependencies.createSdkTransport({
      ...transportOptions,
      executable: executable.path,
      daemonConfigRoot: options.providerStateDirectory,
      sdkOptions,
      managedProcessSpawner,
      requestedTransportMode: mode,
    });
    try {
      return await superviseInteractiveSession(transport, options);
    } catch (error) {
      if (error instanceof ProviderTransportStartupError) throw error;
      throw new ProviderTransportStartupError(
        'claude_sdk_startup_failed',
        transport.workDeliveryState,
        error instanceof Error ? error.message : 'Claude Agent SDK startup failed',
      );
    }
  }
}
