import type { ProviderStatus, ProviderStatusV2, WorkspaceTrustViewV2 } from '@agent-dock/shared';
import { PROVIDER_DISPLAY_NAMES } from '@agent-dock/shared';

/** Documentation screenshots and the shipped demo mode must never present fictitious data as
 * real. This renderer-side fixture cannot import `@agent-dock/agent-runtime` (that package is
 * daemon/Node-only and crossing that boundary into the Electron renderer bundle is exactly the
 * separation this repo's security model depends on), so the versions below are plain literals
 * kept in manual sync with the daemon's pinned/verified values --
 * `CLAUDE_AGENT_SDK_CLAUDE_CODE_VERSION` in `packages/agent-runtime/src/providers/claude/sdk-version.ts`
 * and `CODEX_LEGACY_COMPATIBILITY.providerVersion` in
 * `packages/agent-runtime/src/providers/compatibility-manifest.ts`. Update both together, and
 * keep every version suffixed "(demo)" so a reader can never mistake this fixture-driven data for
 * a live provider read. */
export const CLAUDE_DEMO_VERSION = '2.1.251 (demo)';
export const CODEX_DEMO_VERSION = '0.147.0 (demo)';
export const DEMO_TRANSPORT_ID = 'demo-interactive';

export const providers: ProviderStatus[] = [
  {
    id: 'claude',
    name: PROVIDER_DISPLAY_NAMES.claude,
    installed: true,
    authenticated: 'authenticated',
    version: CLAUDE_DEMO_VERSION,
    capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
  },
  {
    id: 'codex',
    name: PROVIDER_DISPLAY_NAMES.codex,
    installed: true,
    authenticated: 'authenticated',
    version: CODEX_DEMO_VERSION,
    capabilities: { resume: true, cancellation: true, tools: true, usage: true },
  },
];

export const providersV2: ProviderStatusV2[] = providers.map((provider) => ({
  id: provider.id,
  name: provider.name,
  installed: provider.installed,
  authenticated: provider.authenticated,
  transports: [
    {
      id: DEMO_TRANSPORT_ID,
      priority: 0,
      stability: 'stable',
      possibleEffects: ['read', 'filesystem_write', 'command'],
      effectsComplete: true,
    },
  ],
  capabilities: [],
  sandbox: {
    providerId: provider.id,
    platform: 'win32',
    provider: { mechanism: 'provider_policy', state: 'unknown', evidence: [] },
    agentDock: {
      mechanism: 'agentdock_policy',
      state: 'enforced',
      evidence: [
        {
          kind: 'fixture',
          reference: 'asset-capture',
          verifiedAt: '2026-08-30T12:00:00.000Z',
        },
      ],
    },
    os: { mechanism: 'os_sandbox', state: 'unavailable', evidence: [] },
    badge: 'restricted_by_policy',
  },
  ...(provider.version === undefined ? {} : { version: provider.version }),
}));

export const workspaceTrust: WorkspaceTrustViewV2 = {
  schemaVersion: 1,
  workspaceId: 'a'.repeat(64),
  incarnation: 'b'.repeat(64),
  displayName: 'agent-dock',
  reusable: true,
  state: 'trusted',
};
