import { ClaudeProvider, CodexProvider, ProviderRegistry, type Logger } from '@agent-dock/agent-runtime';

/**
 * Wires up every supported provider. This is the one place that needs to change to add a new
 * provider to the daemon — the routes and session manager only ever talk to ProviderRegistry.
 */
export function buildProviderRegistry(logger: Logger): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new ClaudeProvider(logger));
  registry.register(new CodexProvider(logger));
  return registry;
}
