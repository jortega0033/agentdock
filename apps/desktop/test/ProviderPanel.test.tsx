import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('shows not-installed state for one provider while another is installed', () => {
    // Two entries -- matches what the real daemon always returns (one per registered provider,
    // see provider-v2.ts) -- so this exercises the per-card renderer, not the panel-level
    // install-docs empty state below, which only triggers when *every* provider is missing.
    const providers: ProviderStatusV2[] = [
      provider({ id: 'claude', name: 'Claude Code', installed: false, authenticated: 'unknown' }),
      provider({ id: 'codex', name: 'Codex' }),
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

  describe('no provider installed (issue #73)', () => {
    beforeEach(() => {
      // Only this one bridge method is exercised by this describe block; the rest are unused in
      // these assertions, so the mock is deliberately incomplete rather than the full interface.
      window.agentDock = {
        openProviderInstallDocs: vi.fn().mockResolvedValue(undefined),
      } as unknown as typeof window.agentDock;
    });

    it('shows install-doc links when the provider list is empty', () => {
      render(<ProviderPanel providers={[]} />);
      expect(screen.getByText('No providers found')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Claude Agent install docs/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Codex install docs/i })).toBeInTheDocument();
    });

    it('shows install-doc links when every known provider reports not installed', () => {
      const providers: ProviderStatusV2[] = [
        provider({ id: 'claude', name: 'Claude Code', installed: false, authenticated: 'unknown' }),
        provider({ id: 'codex', name: 'Codex', installed: false, authenticated: 'unknown' }),
      ];
      render(<ProviderPanel providers={providers} />);
      expect(screen.getByText('No providers found')).toBeInTheDocument();
      expect(screen.queryByText('Installed: No')).not.toBeInTheDocument();
    });

    it('does not show install-doc links when at least one provider is installed', () => {
      const providers: ProviderStatusV2[] = [
        provider({ id: 'claude', name: 'Claude Code', installed: false, authenticated: 'unknown' }),
        provider({ id: 'codex', name: 'Codex' }),
      ];
      render(<ProviderPanel providers={providers} />);
      expect(screen.queryByText('No providers found')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /install docs/i }),
      ).not.toBeInTheDocument();
    });

    it('opens the correct provider install docs when its link is clicked', () => {
      render(<ProviderPanel providers={[]} />);
      fireEvent.click(screen.getByRole('button', { name: /Codex install docs/i }));
      expect(window.agentDock.openProviderInstallDocs).toHaveBeenCalledWith('codex');
      expect(window.agentDock.openProviderInstallDocs).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: /Claude Agent install docs/i }));
      expect(window.agentDock.openProviderInstallDocs).toHaveBeenCalledWith('claude');
    });
  });
});
