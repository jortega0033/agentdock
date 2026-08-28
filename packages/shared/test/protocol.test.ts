import { describe, expect, it } from 'vitest';
import { AGENT_DOCK_PROTOCOL_VERSION } from '../src/protocol.js';

describe('AGENT_DOCK_PROTOCOL_VERSION', () => {
  it('is a stable positive integer', () => {
    expect(Number.isInteger(AGENT_DOCK_PROTOCOL_VERSION)).toBe(true);
    expect(AGENT_DOCK_PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});
