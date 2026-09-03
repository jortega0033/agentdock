import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { AgentDockClient } from '@agent-dock/client';
import {
  CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION,
  CLAUDE_LEGACY_COMPATIBILITY,
  CODEX_APP_SERVER_COMPATIBILITY,
  CODEX_LEGACY_COMPATIBILITY,
  createConsoleLogger,
} from '@agent-dock/agent-runtime';
import type { CapabilityRequest, ProviderId } from '@agent-dock/shared';
import { buildProviderRegistry } from '../providers.js';
import { isLiveProviderSmokeEnabled } from './opt-in.js';
import { checkVersionSupported } from './version-gate.js';
import { withSyntheticWorkspace } from './synthetic-workspace.js';
import { startLiveSmokeDaemon } from './daemon-instance.js';
import { runCancellationCase, runContinuationCase, runFreshRunCase } from './run-case.js';
import { appendEvidenceRecord, buildEvidenceRecord, LiveSmokeRedactionError } from './evidence.js';
import { isFailedResult, type LiveSmokeResultCode, type LiveSmokeTransportId } from './types.js';

const execFileAsync = promisify(execFile);
const SMOKE_TIMEOUT_MS = 120_000;
const SMOKE_PROMPT =
  'Reply with a single short sentence confirming you received this message. Do not use any tools.';

interface SmokeCaseDefinition {
  id: LiveSmokeTransportId;
  provider: ProviderId;
  preferredTransport: string;
  /**
   * `negotiateCapabilities`'s `preferredTransport` only picks among transports already present
   * in whichever provider manifest the daemon resolved for this request -- it cannot switch
   * between the legacy one-shot bridge and the interactive (SDK/app-server) manifest. That
   * selection happens earlier, per-request, from `AGENT_DOCK_CLAUDE_TRANSPORT`/
   * `AGENT_DOCK_CODEX_TRANSPORT` (see `requestedTransportMode()` in
   * `apps/daemon/src/routes/v2-sessions.ts`). Without setting this explicitly, a machine with
   * both a real CLI and a working SDK/app-server installed would silently run the interactive
   * transport for what's labeled a "legacy one-shot" case.
   */
  transportEnv: { name: 'AGENT_DOCK_CLAUDE_TRANSPORT' | 'AGENT_DOCK_CODEX_TRANSPORT'; value: string };
  pinnedVersion: string;
}

const CASES: SmokeCaseDefinition[] = [
  {
    id: 'claude-agent-sdk',
    provider: 'claude',
    preferredTransport: 'claude-agent-sdk',
    transportEnv: { name: 'AGENT_DOCK_CLAUDE_TRANSPORT', value: 'sdk' },
    pinnedVersion: CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION,
  },
  {
    id: 'claude-legacy-one-shot',
    provider: 'claude',
    preferredTransport: CLAUDE_LEGACY_COMPATIBILITY.transport,
    transportEnv: { name: 'AGENT_DOCK_CLAUDE_TRANSPORT', value: 'cli' },
    pinnedVersion: CLAUDE_LEGACY_COMPATIBILITY.providerVersion,
  },
  {
    id: 'codex-app-server',
    provider: 'codex',
    preferredTransport: CODEX_APP_SERVER_COMPATIBILITY.transport,
    transportEnv: { name: 'AGENT_DOCK_CODEX_TRANSPORT', value: 'app-server' },
    pinnedVersion: CODEX_APP_SERVER_COMPATIBILITY.providerVersion,
  },
  {
    id: 'codex-legacy-one-shot',
    provider: 'codex',
    preferredTransport: CODEX_LEGACY_COMPATIBILITY.transport,
    transportEnv: { name: 'AGENT_DOCK_CODEX_TRANSPORT', value: 'exec' },
    pinnedVersion: CODEX_LEGACY_COMPATIBILITY.providerVersion,
  },
];

async function resolveCommit(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD']);
  return stdout.trim();
}

function capabilitiesFor(preferredTransport: string): CapabilityRequest {
  return {
    required: [{ id: 'session.cancel' }],
    optional: [
      { id: 'interaction.approval' },
      { id: 'interaction.question' },
      { id: 'content.streaming' },
      { id: 'session.resume' },
      { id: 'session.fork' },
    ],
    preferredTransport,
    allowExperimental: true,
  };
}

async function runOneCase(
  evidencePath: string,
  commit: string,
  definition: SmokeCaseDefinition,
): Promise<LiveSmokeResultCode> {
  const startedAt = Date.now();
  const registry = buildProviderRegistry(createConsoleLogger('live-smoke-detect', 'info'));
  const adapter = registry.get(definition.provider);
  if (!adapter) throw new Error(`no provider adapter registered for ${definition.provider}`);
  const status = await adapter.detect();

  async function record(
    resultCode: LiveSmokeResultCode,
    capabilitiesTested: string[] = [],
  ): Promise<void> {
    const base = {
      commit,
      os: platform(),
      provider: definition.provider,
      transport: definition.id,
      authSourceCategory: status.authSource ?? 'none',
      capabilitiesTested,
      resultCode,
      durationMs: Date.now() - startedAt,
    } as const;
    try {
      await appendEvidenceRecord(
        evidencePath,
        buildEvidenceRecord({ ...base, providerVersion: status.version }),
      );
    } catch (error) {
      if (!(error instanceof LiveSmokeRedactionError)) throw error;
      // A malformed field (most likely a bogus `--version` string) must never sink the whole
      // evidence row for this case -- losing evidence entirely is worse than omitting one field.
      console.warn(
        `live-provider-smoke: dropping an unsafe field from the ${definition.id} evidence row: ${error.message}`,
      );
      await appendEvidenceRecord(evidencePath, buildEvidenceRecord({ ...base, providerVersion: undefined }));
    }
  }

  if (!status.installed) {
    await record('skipped_missing_binary');
    return 'skipped_missing_binary';
  }
  if (status.authenticated !== 'authenticated') {
    await record('skipped_missing_auth');
    return 'skipped_missing_auth';
  }
  const versionGate = checkVersionSupported(status.version, definition.pinnedVersion);
  if (!versionGate.supported) {
    await record('skipped_version_stale');
    return 'skipped_version_stale';
  }

  const previousTransportEnv = process.env[definition.transportEnv.name];
  process.env[definition.transportEnv.name] = definition.transportEnv.value;
  const daemon = await startLiveSmokeDaemon();
  try {
    const client = new AgentDockClient({ baseUrl: daemon.baseUrl, token: daemon.token });
    return await withSyntheticWorkspace(async (workspace) => {
      const capabilities = capabilitiesFor(definition.preferredTransport);
      const fresh = await runFreshRunCase(client.v2, {
        provider: definition.provider,
        transport: definition.id,
        cwd: workspace.cwd,
        prompt: SMOKE_PROMPT,
        timeoutMs: SMOKE_TIMEOUT_MS,
        capabilities,
      });
      const allTested = new Set(fresh.capabilitiesTested);
      if (fresh.resultCode === 'success' && fresh.session) {
        if (allTested.has('session.cancel')) {
          const cancellation = await withSyntheticWorkspace(async (cancelWorkspace) => {
            const cancelSession = await runFreshRunCase(client.v2, {
              provider: definition.provider,
              transport: definition.id,
              cwd: cancelWorkspace.cwd,
              prompt:
                'Count slowly from 1 to 100, writing each number on its own line, waiting a moment between each.',
              timeoutMs: SMOKE_TIMEOUT_MS,
              capabilities,
            });
            if (cancelSession.session) {
              return runCancellationCase(client.v2, cancelSession.session, SMOKE_TIMEOUT_MS);
            }
            return undefined;
          });
          if (cancellation) for (const id of cancellation.capabilitiesTested) allTested.add(id);
        }
        for (const kind of ['resume', 'fork'] as const) {
          if (!allTested.has(`session.${kind}`)) continue;
          const continuation = await runContinuationCase(client.v2, kind, fresh.session.id, {
            provider: definition.provider,
            transport: definition.id,
            cwd: workspace.cwd,
            prompt: SMOKE_PROMPT,
            timeoutMs: SMOKE_TIMEOUT_MS,
            capabilities,
          });
          for (const id of continuation.capabilitiesTested) allTested.add(id);
          if (continuation.resultCode !== 'success') {
            await record(continuation.resultCode, [...allTested]);
            return continuation.resultCode;
          }
        }
      }
      await record(fresh.resultCode, [...allTested]);
      return fresh.resultCode;
    });
  } finally {
    if (previousTransportEnv === undefined) delete process.env[definition.transportEnv.name];
    else process.env[definition.transportEnv.name] = previousTransportEnv;
    await daemon.close();
  }
}

async function main(): Promise<void> {
  if (!isLiveProviderSmokeEnabled()) {
    console.log('live-provider-smoke: AGENT_DOCK_LIVE_PROVIDER_SMOKE is not set to "1", skipping.');
    return;
  }
  const commit = await resolveCommit();
  const evidencePath = join(process.cwd(), 'live-provider-smoke-evidence.jsonl');
  let sawFailure = false;
  for (const definition of CASES) {
    console.log(`live-provider-smoke: running ${definition.id}...`);
    const resultCode = await runOneCase(evidencePath, commit, definition);
    console.log(`live-provider-smoke: ${definition.id} -> ${resultCode}`);
    if (isFailedResult(resultCode)) sawFailure = true;
  }
  console.log(`live-provider-smoke: evidence written to ${evidencePath}`);
  if (sawFailure) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error('live-provider-smoke: fatal error', error);
    process.exitCode = 1;
  });
}
