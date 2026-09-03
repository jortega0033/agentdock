import { describe, expect, it, vi } from 'vitest';
import { createDemoBridge } from '../src/demo-bridge.js';
import { providers, providersV2 } from '../src/fixtures/provider-fixtures.js';

describe('createDemoBridge', () => {
  it('is stamped with a non-enumerable demo marker', () => {
    const bridge = createDemoBridge();
    expect((bridge as unknown as { __agentDockDemo?: boolean }).__agentDockDemo).toBe(true);
    expect(Object.keys(bridge)).not.toContain('__agentDockDemo');
  });

  it('never touches a real filesystem path', async () => {
    const bridge = createDemoBridge();
    await expect(bridge.selectDirectory()).resolves.toBe('demo-workspace');
  });

  it('serves the exact same provider fixtures as the shared fixture module, so the two bridges cannot silently diverge', async () => {
    const bridge = createDemoBridge();
    await expect(bridge.listProviders()).resolves.toBe(providers);
    await expect(bridge.listProvidersV2()).resolves.toBe(providersV2);
  });

  it('holds an approval interaction until respondApproval is called, then unblocks the rest of the timeline', async () => {
    const bridge = createDemoBridge();
    const interactions: unknown[] = [];
    const events: string[] = [];
    bridge.onInteractionRequested((_sessionId, interaction) => interactions.push(interaction));
    bridge.onInteractiveSessionEvent((_sessionId, event) => events.push(event.type));

    await bridge.createInteractiveSession({
      provider: 'claude',
      cwd: 'demo-workspace',
      prompt: 'test',
      capabilities: { required: [], optional: [], allowExperimental: false },
    });

    await vi.waitFor(() => expect(interactions).toHaveLength(1));
    expect(events).not.toContain('session.completed');

    const interaction = interactions[0] as { interactionHandle: string; kind: string };
    expect(interaction.kind).toBe('approval');

    await bridge.respondApproval(interaction.interactionHandle, 'allow_once');
    await vi.waitFor(() => expect(events).toContain('session.completed'));
  });
});
