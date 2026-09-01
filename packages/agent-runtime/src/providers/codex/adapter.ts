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
import { runProviderSession } from '../common/run-session.js';
import { superviseInteractiveSession } from '../common/session-supervisor.js';
import { buildCodexArgs } from './build-args.js';
import { detectCodex } from './detect.js';
import { parseCodexLine } from './parser.js';
import {
  CODEX_APP_SERVER_TRANSPORT_ID,
  resolveCodexTransportMode,
  resolveCodexV2Support,
} from './app-server-support.js';
import { createCodexAppServerTransport } from './app-server/index.js';
import { ProviderCliMcpControlPlane } from '../../mcp-control.js';

export const CODEX_PROMPT_VIA_STDIN = false;

/**
 * Codex CLI adapter. Runs `codex exec --json ...` (or `codex exec resume <id> --json ...` to
 * continue a prior thread) and normalizes its JSONL event stream. Authentication is entirely
 * owned by the `codex` binary via `codex login`; this adapter never reads Codex's credential
 * storage and never passes an API key.
 *
 * Command construction is isolated to `buildArgs` below specifically so a future migration to
 * `codex app-server` only touches this adapter: the daemon API and desktop UI depend on
 * ProviderSessionHandle/AgentEvent, not on how the process was invoked.
 */
export class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const;
  readonly name = 'Codex';
  readonly mcp = new ProviderCliMcpControlPlane({ provider: 'codex', executableName: 'codex' });

  constructor(private readonly logger: Logger = noopLogger) {}

  detect(options?: ProviderDetectionOptions): Promise<ProviderStatus> {
    return detectCodex(this.logger, options);
  }

  getV2Support(status: ProviderStatus): ProviderV2Support | undefined {
    return resolveCodexV2Support(status, resolveCodexTransportMode());
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    let mode;
    try {
      mode = resolveCodexTransportMode();
    } catch (error) {
      throw new ProviderTransportStartupError(
        'codex_transport_mode_invalid',
        'not_delivered',
        error instanceof Error ? error.message : 'Codex transport mode is invalid',
      );
    }
    if (mode === 'app-server') {
      throw new ProviderTransportStartupError(
        'codex_exec_transport_not_selected',
        'not_delivered',
        'Codex exec transport is not selected',
      );
    }
    return runProviderSession(
      {
        providerId: 'codex',
        executableNames: ['codex'],
        buildArgs: buildCodexArgs,
        parseLine: parseCodexLine,
        promptViaStdin: CODEX_PROMPT_VIA_STDIN,
      },
      options,
      this.logger,
    );
  }

  async startInteractiveSession(
    options: StartInteractiveSessionOptions,
  ): Promise<InteractiveProviderSessionHandle> {
    const mode = resolveCodexTransportMode();
    const fail = (reasonCode: string, message: string): never => {
      throw new ProviderTransportStartupError(reasonCode, 'not_delivered', message);
    };
    if (mode === 'exec') {
      return fail('codex_app_server_not_selected', 'Codex app-server transport is not selected');
    }
    if (options.transport.id !== CODEX_APP_SERVER_TRANSPORT_ID) {
      return fail(
        'codex_app_server_transport_mismatch',
        'Selected transport does not match Codex app-server',
      );
    }
    const status = options.providerStatus;
    if (!status || status.id !== 'codex' || !status.installed || !status.executablePath) {
      return fail(
        'codex_app_server_launch_unverified',
        'Codex app-server requires an exact detected executable snapshot',
      );
    }
    try {
      if (!resolveCodexV2Support(status, mode)) {
        return fail(
          'codex_app_server_version_unsupported',
          'Detected Codex version is not validated for app-server',
        );
      }
    } catch (error) {
      return fail(
        'codex_app_server_version_unsupported',
        error instanceof Error ? error.message : 'Detected Codex version is not validated',
      );
    }
    if (status.authenticated !== 'authenticated') {
      return fail(
        'codex_app_server_auth_unverified',
        'Codex runtime authentication must be verified before app-server launch',
      );
    }
    if (options.workspaceTrust?.state !== 'trusted') {
      return fail(
        'codex_app_server_workspace_untrusted',
        'Codex app-server requires a verified trusted workspace',
      );
    }

    const { continuation, ...transportOptions } = options;
    const transport = createCodexAppServerTransport({
      ...transportOptions,
      ...(continuation
        ? {
            continuation: {
              kind: continuation.kind,
              threadId: continuation.providerSessionId,
            },
          }
        : {}),
      executable: status.executablePath,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      requestedTransportMode: mode,
    });
    try {
      return await superviseInteractiveSession(transport, options);
    } catch (error) {
      if (error instanceof ProviderTransportStartupError) throw error;
      const deliveryState =
        transport.workDeliveryState === 'not_delivered' && transport.reaped
          ? 'not_delivered'
          : transport.workDeliveryState === 'delivered'
            ? 'delivered'
            : 'ambiguous';
      throw new ProviderTransportStartupError(
        'codex_app_server_startup_failed',
        deliveryState,
        error instanceof Error ? error.message : 'Codex app-server startup failed',
      );
    }
  }
}
