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

  it('shows the actual auth source instead of a generic yes/no when one is known', () => {
    const providers: ProviderStatusV2[] = [
      provider({ id: 'claude', name: 'Claude Code', authSource: 'claude_subscription' }),
    ];
    render(<ProviderPanel providers={providers} />);
    expect(screen.getByText('Authenticated: Claude subscription')).toBeInTheDocument();
  });

  it('falls back to the raw auth source value for an auth source this UI has no label for', () => {
    const providers: ProviderStatusV2[] = [
      provider({
        id: 'codex',
        name: 'Codex',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately outside the known AuthSource union
        authSource: 'future_auth_source' as any,
      }),
    ];
    render(<ProviderPanel providers={providers} />);
    expect(screen.getByText('Authenticated: future_auth_source')).toBeInTheDocument();
  });
});
