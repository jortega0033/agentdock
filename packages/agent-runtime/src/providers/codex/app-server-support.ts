import type {
  CapabilityConstraintById,
  CapabilitySupportRecord,
  CoreCapabilityId,
  ProviderStatus,
  ProviderTransportV2,
} from '@agent-dock/shared';
import { CAPABILITY_CATALOG } from '@agent-dock/shared';
import type { ProviderV2Support } from '../../types.js';
import {
  CODEX_APP_SERVER_COMPATIBILITY,
  CODEX_APP_SERVER_FIXTURE_SET,
  CODEX_APP_SERVER_SCHEMA_SHA256,
  CODEX_APP_SERVER_TRANSPORT_ID,
} from '../compatibility-manifest.js';

export {
  CODEX_APP_SERVER_COMPATIBILITY,
  CODEX_APP_SERVER_FIXTURE_SET,
  CODEX_APP_SERVER_SCHEMA_SHA256,
  CODEX_APP_SERVER_TRANSPORT_ID,
};

export type CodexTransportMode = 'auto' | 'app-server' | 'exec';

const CODEX_TRANSPORT_MODES = new Set<CodexTransportMode>(['auto', 'app-server', 'exec']);

/**
 * App-server starts experimental as a whole, so this is a deliberately small, reviewed subset
 * of the methods emitted by the non-experimental schema bundle. Do not infer permission from a
 * prefix: additions must be reviewed and added here explicitly.
 */
export const CODEX_APP_SERVER_OUTGOING_REQUEST_METHODS = Object.freeze([
  'initialize',
  'account/read',
  'thread/start',
  'thread/resume',
  'thread/fork',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'model/list',
  'modelProvider/capabilities/read',
] as const);

export const CODEX_APP_SERVER_OUTGOING_NOTIFICATION_METHODS = Object.freeze([
  'initialized',
] as const);

export const CODEX_APP_SERVER_INCOMING_REQUEST_METHODS = Object.freeze([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
] as const);

export const CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS = Object.freeze([
  'remoteControl/status/changed',
  'warning',
  'mcpServer/startupStatus/updated',
  'account/rateLimits/updated',
  'thread/started',
  'thread/status/changed',
  'turn/started',
  'turn/completed',
  'turn/plan/updated',
  'turn/diff/updated',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'serverRequest/resolved',
  'thread/tokenUsage/updated',
  'error',
] as const);

const OUTGOING_METHODS = new Set<string>([
  ...CODEX_APP_SERVER_OUTGOING_REQUEST_METHODS,
  ...CODEX_APP_SERVER_OUTGOING_NOTIFICATION_METHODS,
]);
const INCOMING_METHODS = new Set<string>([
  ...CODEX_APP_SERVER_INCOMING_REQUEST_METHODS,
  ...CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS,
]);
const INCOMING_NOTIFICATION_METHODS = new Set<string>(
  CODEX_APP_SERVER_INCOMING_NOTIFICATION_METHODS,
);

export function isCodexAppServerOutgoingMethod(method: string): boolean {
  return OUTGOING_METHODS.has(method);
}

export function isCodexAppServerIncomingMethod(method: string): boolean {
  return INCOMING_METHODS.has(method);
}

export function isCodexAppServerIncomingNotificationMethod(method: string): boolean {
  return INCOMING_NOTIFICATION_METHODS.has(method);
}

export class CodexAppServerUnsupportedError extends Error {
  readonly code = 'codex_app_server_unsupported' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CodexAppServerUnsupportedError';
  }
}

/** Strictly parse the developer override; whitespace and aliases are intentional failures. */
export function resolveCodexTransportMode(
  value: string | undefined = process.env.AGENT_DOCK_CODEX_TRANSPORT,
): CodexTransportMode {
  if (value === undefined) return 'auto';
  if (CODEX_TRANSPORT_MODES.has(value as CodexTransportMode)) {
    return value as CodexTransportMode;
  }
  throw new CodexAppServerUnsupportedError(
    'AGENT_DOCK_CODEX_TRANSPORT must be exactly "auto", "app-server", or "exec"',
  );
}

export const CODEX_APP_SERVER_TRANSPORT: ProviderTransportV2 = {
  id: CODEX_APP_SERVER_TRANSPORT_ID,
  priority: 1,
  stability: 'stable',
  possibleEffects: [
    'read',
    'filesystem_write',
    'command',
    'network',
    'external_side_effect',
    'destructive',
  ],
  effectsComplete: false,
};

const CAPABILITY_METHODS = {
  'session.input.follow_up': ['thread/start', 'turn/start'],
  'session.input.steer': ['turn/steer'],
  'session.interrupt': ['turn/interrupt'],
  'session.cancel': ['turn/interrupt'],
  'session.resume': ['thread/resume', 'turn/start'],
  'session.fork': ['thread/fork'],
  'interaction.approval': [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'mcpServer/elicitation/request',
  ],
  'interaction.question': ['mcpServer/elicitation/request'],
  'content.streaming': ['item/agentMessage/delta'],
  'content.tools': ['item/started', 'item/completed'],
  'content.plans': ['turn/plan/updated'],
  'content.usage.tokens': ['thread/tokenUsage/updated', 'turn/completed'],
} as const satisfies Partial<Record<CoreCapabilityId, readonly string[]>>;

type SupportedCapabilityId = keyof typeof CAPABILITY_METHODS;

function runtimePlatform(): 'win32' | 'darwin' | 'linux' | 'linux_wsl2' {
  if (process.platform === 'win32' || process.platform === 'darwin') return process.platform;
  return process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP ? 'linux_wsl2' : 'linux';
}

function constraintsFor<I extends SupportedCapabilityId>(id: I): CapabilityConstraintById[I] {
  switch (id) {
    case 'session.input.follow_up':
    case 'session.input.steer':
      return {
        kind: 'text_input',
        maxCharacters: 200_000,
        attachmentKinds: [],
      } as unknown as CapabilityConstraintById[I];
    case 'session.interrupt':
    case 'session.cancel':
      return {
        kind: 'acknowledgement',
        timeoutMs: 30_000,
      } as unknown as CapabilityConstraintById[I];
    case 'session.resume':
    case 'session.fork':
      return { kind: 'continuation', native: true } as unknown as CapabilityConstraintById[I];
    case 'interaction.approval':
    case 'interaction.question':
      return {
        kind: 'interaction',
        timeoutMs: 300_000,
        maxPayloadBytes: 32 * 1024,
      } as unknown as CapabilityConstraintById[I];
    case 'content.streaming':
    case 'content.plans':
      return {
        kind: 'content',
        maxBlockBytes: 256 * 1024,
        persistence: 'live_only',
      } as unknown as CapabilityConstraintById[I];
    case 'content.tools':
      return {
        kind: 'effects',
        allowedEffects: [
          'read',
          'filesystem_write',
          'command',
          'network',
          'external_side_effect',
          'destructive',
        ],
      } as unknown as CapabilityConstraintById[I];
    case 'content.usage.tokens':
      return { kind: 'usage', scopes: ['turn'] } as unknown as CapabilityConstraintById[I];
  }
}

function sessionStatesFor(
  id: SupportedCapabilityId,
): Array<'starting' | 'active' | 'idle' | 'terminal'> {
  switch (id) {
    case 'session.input.follow_up':
      return ['starting', 'idle'];
    case 'session.input.steer':
    case 'session.interrupt':
    case 'interaction.approval':
    case 'interaction.question':
      return ['starting', 'active'];
    case 'session.cancel':
      return ['starting', 'active', 'idle'];
    case 'session.resume':
    case 'session.fork':
      return ['starting'];
    default:
      return ['starting', 'active', 'idle', 'terminal'];
  }
}

function supportRecord<I extends SupportedCapabilityId>(
  status: ProviderStatus,
  id: I,
): CapabilitySupportRecord {
  const methods = CAPABILITY_METHODS[id];
  const allStable = methods.every(
    (method) => isCodexAppServerOutgoingMethod(method) || isCodexAppServerIncomingMethod(method),
  );
  if (!allStable)
    throw new Error(`Codex app-server capability ${id} references a non-allowlisted method`);

  const continuationUnavailable =
    status.authSource === 'api_key' && (id === 'session.resume' || id === 'session.fork');
  return {
    id,
    kind: CAPABILITY_CATALOG[id].kind,
    owner: CAPABILITY_CATALOG[id].owner,
    support: continuationUnavailable ? 'unsupported' : 'supported',
    stability: 'stable',
    evidence: [
      {
        kind: 'fixture',
        reference: CODEX_APP_SERVER_COMPATIBILITY.fixtureSet,
      },
      { kind: 'vendor_declared', reference: CODEX_APP_SERVER_COMPATIBILITY.schemaArtifact },
    ],
    scope: {
      provider: status.id,
      transport: CODEX_APP_SERVER_TRANSPORT_ID,
      platform: runtimePlatform(),
      model: '*',
      authMode: '*',
      trustState: 'trusted',
      versions: {
        adapterContract: '2',
        transport: CODEX_APP_SERVER_COMPATIBILITY.providerVersion,
        runtime: process.version,
        schema: CODEX_APP_SERVER_SCHEMA_SHA256,
        fixtureSet: CODEX_APP_SERVER_COMPATIBILITY.fixtureSet,
      },
    },
    prerequisites: {
      capabilities: [],
      trustStates: ['trusted'],
      sessionStates: sessionStatesFor(id),
      services: [],
    },
    possibleEffects:
      id === 'content.tools' || id === 'interaction.approval'
        ? ['read', 'filesystem_write', 'command', 'network', 'external_side_effect', 'destructive']
        : [],
    effectsComplete: id !== 'content.tools' && id !== 'interaction.approval',
    constraints: constraintsFor(id),
    ...(continuationUnavailable
      ? { reason: 'API-key authentication does not provide bindable continuation identity' }
      : {}),
  } as CapabilitySupportRecord;
}

function hasValidatedAppServerCompatibility(status: ProviderStatus): boolean {
  return status.id === 'codex' && status.version === CODEX_APP_SERVER_COMPATIBILITY.providerVersion;
}

/**
 * Gives the adapter its safe v2 manifest. `exec` and an unknown auto version intentionally
 * return undefined so the existing one-shot bridge remains the only advertised transport.
 */
export function resolveCodexV2Support(
  status: ProviderStatus,
  mode: CodexTransportMode,
): ProviderV2Support | undefined {
  if (mode === 'exec') return undefined;
  if (!hasValidatedAppServerCompatibility(status)) {
    if (mode === 'app-server') {
      throw new CodexAppServerUnsupportedError(
        `Codex app-server requires validated codex-cli ${CODEX_APP_SERVER_COMPATIBILITY.providerVersion}; detected ${status.version ?? 'unknown'}`,
      );
    }
    return undefined;
  }

  return {
    transports: [
      {
        ...CODEX_APP_SERVER_TRANSPORT,
        possibleEffects: [...CODEX_APP_SERVER_TRANSPORT.possibleEffects],
      },
    ],
    capabilities: (Object.keys(CAPABILITY_METHODS) as SupportedCapabilityId[]).map((id) =>
      supportRecord(status, id),
    ),
  };
}
