import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProviderStatus } from '@agent-dock/shared';
import { ProviderPanel } from '../src/components/ProviderPanel.js';

describe('ProviderPanel', () => {
  it('shows not-installed state', () => {
    const providers: ProviderStatus[] = [
      { id: 'claude', name: 'Claude Code', installed: false, authenticated: 'unknown' },
    ];
    render(<ProviderPanel providers={providers} />);
    expect(screen.getByText('Installed: No')).toBeInTheDocument();
    expect(screen.getByText('Authenticated: unknown')).toBeInTheDocument();
  });

  it('shows installed-but-unauthenticated state distinctly from unknown', () => {
    const providers: ProviderStatus[] = [
      { id: 'codex', name: 'Codex', installed: true, authenticated: false, version: '1.2.3' },
    ];
    render(<ProviderPanel providers={providers} />);
    expect(screen.getByText('Installed: Yes')).toBeInTheDocument();
    expect(screen.getByText('Authenticated: no')).toBeInTheDocument();
    expect(screen.getByText('Version: 1.2.3')).toBeInTheDocument();
  });

  it('shows installed-and-authenticated state', () => {
    const providers: ProviderStatus[] = [
      { id: 'claude', name: 'Claude Code', installed: true, authenticated: true },
    ];
    render(<ProviderPanel providers={providers} />);
    expect(screen.getByText('Authenticated: yes')).toBeInTheDocument();
  });
});
