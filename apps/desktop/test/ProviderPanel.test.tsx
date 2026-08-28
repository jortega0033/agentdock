import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '@agent-dock/shared';
import { ProviderPanel } from '../src/components/ProviderPanel.js';

const CAPS: ProviderCapabilities = { resume: true, cancellation: true, tools: true, usage: true, thinking: true };

describe('ProviderPanel', () => {
  it('shows not-installed state', () => {
    const providers: ProviderStatus[] = [
      { id: 'claude', name: 'Claude Code', installed: false, authenticated: 'unknown', capabilities: CAPS },
    ];
    render(<ProviderPanel providers={providers} />);
    expect(screen.getByText('Installed: No')).toBeInTheDocument();
    expect(screen.getByText('Authenticated: unknown')).toBeInTheDocument();
  });

  it('shows installed-but-unauthenticated state distinctly from unknown', () => {
    const providers: ProviderStatus[] = [
      { id: 'codex', name: 'Codex', installed: true, authenticated: false, version: '1.2.3', capabilities: CAPS },
    ];
    render(<ProviderPanel providers={providers} />);
    expect(screen.getByText('Installed: Yes')).toBeInTheDocument();
    expect(screen.getByText('Authenticated: no')).toBeInTheDocument();
    expect(screen.getByText('Version: 1.2.3')).toBeInTheDocument();
  });

  it('shows installed-and-authenticated state', () => {
    const providers: ProviderStatus[] = [
      { id: 'claude', name: 'Claude Code', installed: true, authenticated: true, capabilities: CAPS },
    ];
    render(<ProviderPanel providers={providers} />);
    expect(screen.getByText('Authenticated: yes')).toBeInTheDocument();
  });
});
