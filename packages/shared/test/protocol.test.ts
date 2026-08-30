import { describe, expect, it } from 'vitest';
import {
  AGENT_DOCK_PROTOCOL_VERSION,
  AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS,
} from '../src/protocol.js';

describe('AGENT_DOCK_PROTOCOL_VERSION', () => {
  it('is a stable positive integer', () => {
    expect(Number.isInteger(AGENT_DOCK_PROTOCOL_VERSION)).toBe(true);
    expect(AGENT_DOCK_PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('keeps legacy v1 while advertising local v1/v2 support', () => {
    expect(AGENT_DOCK_PROTOCOL_VERSION).toBe(1);
    expect(AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS).toEqual([1, 2]);
  });
});
