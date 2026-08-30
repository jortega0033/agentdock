import type { ProviderStatus } from '@agent-dock/shared';
import noProvidersIllustration from '../../assets/illustrations/no-providers.svg';

function authLabel(status: ProviderStatus): string {
  if (status.authenticated === 'authenticated') return 'yes';
  if (status.authenticated === 'unauthenticated') return 'no';
  return 'unknown';
}

export function ProviderPanel({ providers }: { providers: ProviderStatus[] }) {
  if (providers.length === 0) {
    return (
      <div className="provider-panel provider-panel--empty">
        <img className="provider-panel__empty-illustration" src={noProvidersIllustration} alt="" />
        <strong>No providers found</strong>
        <span>Install Claude Code or Codex, then restart AgentDock.</span>
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
          {status.version && <div>Version: {status.version}</div>}
          {status.error && <div className="provider-card__error">{status.error}</div>}
        </div>
      ))}
    </div>
  );
}
