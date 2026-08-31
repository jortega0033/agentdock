import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProviderStatusV2 } from '@agent-dock/shared';
import { ProviderPanel } from '../src/components/ProviderPanel.js';

function provider(
  overrides: Partial<ProviderStatusV2> & Pick<ProviderStatusV2, 'id' | 'name'>,
): ProviderStatusV2 {
  return {
    installed: true,
    authenticated: 'authenticated',
    transports: [],
    capabilities: [],
    ...overrides,
    sandbox: overrides.sandbox ?? {
      providerId: overrides.id,
      platform: 'win32',
      provider: { mechanism: 'provider_policy', state: 'unknown', evidence: [] },
      agentDock: { mechanism: 'agentdock_policy', state: 'not_requested', evidence: [] },
      os: { mechanism: 'os_sandbox', state: 'unavailable', evidence: [] },
      badge: 'none',
    },
  };
}

describe('ProviderPanel', () => {
  it('shows not-installed state', () => {
    const providers: ProviderStatusV2[] = [
      provider({ id: 'claude', name: 'Claude Code', installed: false, authenticated: 'unknown' }),
    ];
    render(<ProviderPanel providers={providers} />);
    expect(screen.getByText('Installed: No')).toBeInTheDocument();
    expect(screen.getByText('Authenticated: unknown')).toBeInTheDocument();
  });

  it('shows installed-but-unauthenticated state distinctly from unknown', () => {
    const providers: ProviderStatusV2[] = [
      provider({ id: 'codex', name: 'Codex', authenticated: 'unauthenticated', version: '1.2.3' }),
    ];
    render(<ProviderPanel providers={providers} />);
    expect(screen.getByText('Installed: Yes')).toBeInTheDocument();
    expect(screen.getByText('Authenticated: no')).toBeInTheDocument();
    expect(screen.getByText('Version: 1.2.3')).toBeInTheDocument();
  });

  it('shows installed-and-authenticated state', () => {
    const providers: ProviderStatusV2[] = [provider({ id: 'claude', name: 'Claude Code' })];
    render(<ProviderPanel providers={providers} />);
    expect(screen.getByText('Authenticated: yes')).toBeInTheDocument();
  });
});
