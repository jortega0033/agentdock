export type ClaudeTransportMode = 'auto' | 'sdk' | 'cli';

const CLAUDE_TRANSPORT_MODES = new Set<ClaudeTransportMode>(['auto', 'sdk', 'cli']);

export class ClaudeTransportModeError extends Error {
  readonly code = 'claude_transport_mode_invalid' as const;

  constructor() {
    super('AGENT_DOCK_CLAUDE_TRANSPORT must be exactly "auto", "sdk", or "cli"');
    this.name = 'ClaudeTransportModeError';
  }
}

/** Strictly parses the operator override; whitespace, case changes, and aliases fail closed. */
export function resolveClaudeTransportMode(
  value: string | undefined = process.env.AGENT_DOCK_CLAUDE_TRANSPORT,
): ClaudeTransportMode {
  if (value === undefined) return 'auto';
  if (CLAUDE_TRANSPORT_MODES.has(value as ClaudeTransportMode)) {
    return value as ClaudeTransportMode;
  }
  throw new ClaudeTransportModeError();
}
