import { describe, expect, it } from 'vitest';
import {
  ClaudeTransportModeError,
  resolveClaudeTransportMode,
} from '../src/providers/claude/transport-mode.js';

describe('resolveClaudeTransportMode', () => {
  it.each(['auto', 'sdk', 'cli'] as const)('accepts exact mode %s', (mode) => {
    expect(resolveClaudeTransportMode(mode)).toBe(mode);
  });

  it('defaults to auto only when the override is absent', () => {
    expect(resolveClaudeTransportMode(undefined)).toBe('auto');
  });

  it.each(['', 'SDK', ' sdk', 'sdk ', 'exec'])('fails closed for %j', (value) => {
    expect(() => resolveClaudeTransportMode(value)).toThrow(ClaudeTransportModeError);
  });

  it('does not include an invalid value in the error', () => {
    expect(() => resolveClaudeTransportMode('credential-canary')).toThrowError(
      'AGENT_DOCK_CLAUDE_TRANSPORT must be exactly "auto", "sdk", or "cli"',
    );
  });
});
