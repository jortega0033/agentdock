/**
 * The one gate every live-provider smoke entrypoint must check before doing anything else --
 * before detecting a provider, before touching the filesystem, before any network activity. See
 * issue #65's acceptance criteria: "Without AGENT_DOCK_LIVE_PROVIDER_SMOKE=1, no provider/network
 * work occurs."
 */
export const LIVE_PROVIDER_SMOKE_ENV_VAR = 'AGENT_DOCK_LIVE_PROVIDER_SMOKE';

export function isLiveProviderSmokeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIVE_PROVIDER_SMOKE_ENV_VAR] === '1';
}
