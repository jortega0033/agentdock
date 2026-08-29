import type { ProviderStatus } from '@agent-dock/shared';

function authLabel(status: ProviderStatus): string {
  if (status.authenticated === 'authenticated') return 'yes';
  if (status.authenticated === 'unauthenticated') return 'no';
  return 'unknown';
}

export function ProviderPanel({ providers }: { providers: ProviderStatus[] }) {
  return (
    <div className="provider-panel">
      {providers.map((status) => (
        <div key={status.id} className="provider-card">
          <div className="provider-card__name">{status.name}</div>
          <div>Installed: {status.installed ? 'Yes' : 'No'}</div>
          <div>Authenticated: {authLabel(status)}</div>
          {status.version && <div>Version: {status.version}</div>}
          {status.error && <div className="provider-card__error">{status.error}</div>}
        </div>
      ))}
    </div>
  );
}
