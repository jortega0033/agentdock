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
  it('is provider-dependent once a session is selected, since only Codex app-server populates the graph', () => {
    const status = childAgentPanelStatus(true);
    expect(status.state).toBe('provider_dependent');
    expect(status.explanation).toContain('Codex app-server');
  });

  it('falls back to an unsupported placeholder when no session is selected', () => {
    const status = childAgentPanelStatus(false);
    expect(status.state).toBe('unsupported');
    expect(status.explanation).toContain('Select a session');
  });
});

describe('workflowPanelStatus', () => {
  it('is scaffold-only for this specific panel, since it never wires staged files/schemas into session creation itself', () => {
    const status = workflowPanelStatus();
    expect(status.state).toBe('scaffold_only');
    expect(status.explanation).toContain('never sent to a provider from this panel');
    // The panel is scaffold-only even though the underlying daemon API is not (issue #59) -- the
    // explanation should still say so accurately rather than claiming nothing is dispatched at all.
    expect(status.explanation).toContain('Codex app-server can accept');
  });
});
