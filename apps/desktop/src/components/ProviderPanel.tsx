import { PROVIDER_DISPLAY_NAMES, type ProviderStatusV2 } from '@agent-dock/shared';
import noProvidersIllustration from '../../assets/illustrations/no-providers.svg';

const AUTH_SOURCE_LABELS: Record<string, string> = {
  chatgpt: 'ChatGPT sign-in',
  api_key: 'API key',
  claude_subscription: 'Claude subscription',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex',
  foundry: 'Azure AI Foundry',
  unknown: 'source unknown',
};

function authLabel(status: ProviderStatusV2): string {
  if (status.authenticated === 'unauthenticated') return 'no';
  if (status.authenticated === 'unknown') return 'unknown';
  return status.authSource ? AUTH_SOURCE_LABELS[status.authSource] ?? status.authSource : 'yes';
}

function sandboxLabel(status: ProviderStatusV2): string {
  if (status.sandbox.badge === 'restricted_by_policy') return 'Restricted by AgentDock policy';
  if (status.sandbox.badge === 'os_sandboxed') return 'OS sandboxed';
  if (status.sandbox.badge === 'bash_sandboxed') return 'Bash sandboxed';
  return 'No sandbox verified';
}

export function ProviderPanel({ providers }: { providers: ProviderStatusV2[] }) {
  // Issue #73: the registry always reports every registered provider (each with its own real
  // `installed` flag from findExecutable()), so `providers.length === 0` essentially never
  // happens in practice -- the actual "nothing to work with" state is every entry reporting
  // `installed: false`. Only surfaced when *both* are missing; a user with one working provider
  // shouldn't be nagged about the other.
  if (providers.length === 0 || providers.every((status) => !status.installed)) {
    return (
      <div className="provider-panel provider-panel--empty">
        <img className="provider-panel__empty-illustration" src={noProvidersIllustration} alt="" />
        <strong>No providers found</strong>
        <span>
          Install {PROVIDER_DISPLAY_NAMES.claude} or {PROVIDER_DISPLAY_NAMES.codex}, then restart
          AgentDock.
        </span>
        <div className="provider-panel__install-links">
          <button type="button" onClick={() => void window.agentDock.openProviderInstallDocs('claude')}>
            {PROVIDER_DISPLAY_NAMES.claude} install docs
          </button>
          <button type="button" onClick={() => void window.agentDock.openProviderInstallDocs('codex')}>
            {PROVIDER_DISPLAY_NAMES.codex} install docs
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="provider-panel">
      {providers.map((status) => (
        <div key={status.id} className="provider-card">
          <div className="provider-card__heading">
            <div className="provider-card__name">{status.name}</div>
            <span
              className={`provider-card__dot ${status.installed ? 'provider-card__dot--ready' : ''}`}
              aria-hidden="true"
            />
          </div>
          <div>Installed: {status.installed ? 'Yes' : 'No'}</div>
          <div>Authenticated: {authLabel(status)}</div>
          <div className="provider-card__sandbox">{sandboxLabel(status)}</div>
          <div>OS isolation: {status.sandbox.os.state.replaceAll('_', ' ')}</div>
          {status.version && <div>Version: {status.version}</div>}
          {status.error && <div className="provider-card__error">{status.error}</div>}
        </div>
      ))}
    </div>
  );
}
