import type { ProviderId, ProviderStatus } from '@agent-dock/shared';
import type { AgentProvider } from './types.js';

/**
 * Central lookup for every registered AgentProvider. The daemon depends on this rather than
 * importing ClaudeProvider/CodexProvider directly, so adding a provider is: implement
 * AgentProvider, register() it here (or wherever the daemon builds its registry), done.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, AgentProvider>();

  register(provider: AgentProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: ProviderId): AgentProvider | undefined {
    return this.providers.get(id);
  }

  list(): AgentProvider[] {
    return [...this.providers.values()];
  }

  async detectAll(): Promise<ProviderStatus[]> {
    return Promise.all(this.list().map((provider) => provider.detect()));
  }
}
