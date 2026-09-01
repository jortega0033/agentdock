import { PROVIDER_DISPLAY_NAMES, type ProviderStatusV2 } from '@agent-dock/shared';
import noProvidersIllustration from '../../assets/illustrations/no-providers.svg';

function authLabel(status: ProviderStatusV2): string {
  if (status.authenticated === 'authenticated') return 'yes';
  if (status.authenticated === 'unauthenticated') return 'no';
  return 'unknown';
}

function sandboxLabel(status: ProviderStatusV2): string {
  if (status.sandbox.badge === 'restricted_by_policy') return 'Restricted by AgentDock policy';
  if (status.sandbox.badge === 'os_sandboxed') return 'OS sandboxed';
  if (status.sandbox.badge === 'bash_sandboxed') return 'Bash sandboxed';
  return 'No sandbox verified';
}

export function ProviderPanel({ providers }: { providers: ProviderStatusV2[] }) {
  if (providers.length === 0) {
    return (
      <div className="provider-panel provider-panel--empty">
        <img className="provider-panel__empty-illustration" src={noProvidersIllustration} alt="" />
        <strong>No providers found</strong>
        <span>
          Install {PROVIDER_DISPLAY_NAMES.claude} or {PROVIDER_DISPLAY_NAMES.codex}, then restart
          AgentDock.
        </span>
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
