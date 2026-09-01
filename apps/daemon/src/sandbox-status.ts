import type { ProviderId, SandboxStatusV2 } from '@agent-dock/shared';

function runtimePlatform(): SandboxStatusV2['platform'] {
  if (process.platform === 'win32' || process.platform === 'darwin') return process.platform;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return 'linux_wsl2';
  return 'linux';
}

/** Reports each enforcement layer independently; it never upgrades policy into OS isolation. */
export function providerSandboxStatus(
  providerId: ProviderId,
  agentDockPolicyEnforced: boolean,
  platform: SandboxStatusV2['platform'] = runtimePlatform(),
): SandboxStatusV2 {
  return {
    providerId,
    platform,
    provider: { mechanism: 'provider_policy', state: 'unknown', evidence: [] },
    agentDock: agentDockPolicyEnforced
      ? {
          mechanism: 'agentdock_policy',
          state: 'enforced',
          evidence: [
            {
              kind: 'runtime_report',
              reference: 'agentdock:permission-policy-v1',
              verifiedAt: new Date().toISOString(),
            },
          ],
        }
      : { mechanism: 'agentdock_policy', state: 'not_requested', evidence: [] },
    os: {
      mechanism: 'os_sandbox',
      // Codex 0.147.0 readiness reports only ready/notConfigured/updateRequired. It does not reveal
      // whether setup used the elevated or unelevated implementation. Until AgentDock owns an
      // explicit setup flow, make no Windows OS-isolation claim instead of treating them alike.
      state: platform === 'win32' ? 'unavailable' : 'unknown',
      evidence: [],
    },
    badge: agentDockPolicyEnforced ? 'restricted_by_policy' : 'none',
  };
}
