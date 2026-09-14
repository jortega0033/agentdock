import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderComponentDescriptorV2, ProviderComponentListV2 } from '@agent-dock/shared';
import { ComponentPanel } from '../src/components/ComponentPanel.js';
import { clearBridgeOverride, setBridgeOverride } from '../src/bridge.js';
import type { AgentDockBridge } from '../src/window.js';

function item(
  overrides: Partial<ProviderComponentDescriptorV2> = {},
): ProviderComponentDescriptorV2 {
  return {
    id: 'project/plugin/risky-plugin',
    provider: 'claude',
    kind: 'plugin',
    name: 'Risky Plugin',
    scope: 'project',
    source: 'filesystem',
    enabled: true,
    trusted: false,
    dependencies: [],
    capabilities: [],
    supportsDirectInvoke: false,
    supportsManage: false,
    manifestPreview: {
      hooks: 0,
      mcpServers: 0,
      executables: 0,
      environmentVariables: 0,
      skills: 0,
      agents: 0,
    },
    ...overrides,
  };
}

function installComponentsBridge(page: ProviderComponentListV2): void {
  setBridgeOverride({
    listProviderComponents: vi.fn().mockResolvedValue(page),
  } as unknown as AgentDockBridge);
}

afterEach(() => {
  clearBridgeOverride();
});

describe('ComponentPanel risk findings (issue #130)', () => {
  it('renders concise findings under the manifest preview, never claiming safety by their absence', async () => {
    installComponentsBridge({
      items: [
        item({
          riskFindings: [
            {
              id: 'declares_executable_command',
              severity: 'info',
              summary: 'Manifest declares one or more hook/command entries that can execute on this machine.',
            },
            {
              id: 'declares_command_and_environment_access',
              severity: 'warning',
              summary:
                'Manifest declares both an executable command and environment-variable access -- review before trusting.',
            },
          ],
        }),
      ],
      revision: 'rev-1',
    });

    render(<ComponentPanel provider="claude" cwd="/workspace" />);

    expect(
      await screen.findByText(
        'Manifest declares one or more hook/command entries that can execute on this machine.',
      ),
    ).toBeInTheDocument();
    const warning = screen.getByText(
      'Manifest declares both an executable command and environment-variable access -- review before trusting.',
    );
    expect(warning).toHaveClass('component-risk-finding--warning');
  });

  it('shows nothing extra for a component with no findings, and never claims it is safe', async () => {
    installComponentsBridge({ items: [item()], revision: 'rev-2' });

    render(<ComponentPanel provider="claude" cwd="/workspace" />);

    await waitFor(() => expect(screen.getByText('Risky Plugin')).toBeInTheDocument());
    expect(screen.queryByLabelText('Static review findings')).not.toBeInTheDocument();
    expect(screen.queryByText(/safe/i)).not.toBeInTheDocument();
  });
});
