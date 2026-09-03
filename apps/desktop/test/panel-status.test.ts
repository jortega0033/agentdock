import { describe, expect, it } from 'vitest';
import {
  childAgentPanelStatus,
  componentPanelStatus,
  mcpPanelStatus,
  workflowPanelStatus,
} from '../src/panel-status.js';

describe('mcpPanelStatus', () => {
  it('is scaffold-only, since server configuration/inspection is real but no live catalog or invocation exists for any provider', () => {
    const status = mcpPanelStatus();
    expect(status.state).toBe('scaffold_only');
    expect(status.explanation).toContain('any provider');
  });
});

describe('componentPanelStatus', () => {
  it('is scaffold-only, since discovery is real but management/invocation is unconditionally unsupported for any provider', () => {
    const status = componentPanelStatus();
    expect(status.state).toBe('scaffold_only');
    expect(status.explanation).toContain('management or invocation');
  });
});

describe('childAgentPanelStatus', () => {
  it('is scaffold-only once a session is selected, since no adapter populates the graph', () => {
    expect(childAgentPanelStatus(true).state).toBe('scaffold_only');
  });

  it('falls back to an unsupported placeholder when no session is selected', () => {
    const status = childAgentPanelStatus(false);
    expect(status.state).toBe('unsupported');
    expect(status.explanation).toContain('Select a session');
  });
});

describe('workflowPanelStatus', () => {
  it('is scaffold-only regardless of provider, since no adapter dispatches staged input today', () => {
    expect(workflowPanelStatus().state).toBe('scaffold_only');
    expect(workflowPanelStatus().explanation).toContain('not included in any run');
  });
});
