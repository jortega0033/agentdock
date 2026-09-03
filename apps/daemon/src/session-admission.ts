const MIN_ACTIVE_SESSIONS = 1;
const MAX_ACTIVE_SESSIONS_CEILING = 32;
const DEFAULT_MAX_ACTIVE_SESSIONS = 4;

/** Daemon-wide provider-process cap when no admission controller is explicitly configured. */
export const UNCONFIGURED_ADMISSION_CEILING = MAX_ACTIVE_SESSIONS_CEILING;

export class SessionCapacityError extends Error {
  readonly code = 'session_capacity_exceeded' as const;

  constructor(message = 'active session capacity exceeded') {
    super(message);
    this.name = 'SessionCapacityError';
  }
}

export interface SessionAdmissionLease {
  /** Idempotent: a second call is a no-op, so a slot is never released more than once. */
  release(): void;
}

function assertValidLimit(value: number): void {
  if (
    !Number.isInteger(value) ||
    value < MIN_ACTIVE_SESSIONS ||
    value > MAX_ACTIVE_SESSIONS_CEILING
  ) {
    throw new Error(
      `maxActiveSessions must be an integer between ${MIN_ACTIVE_SESSIONS} and ${MAX_ACTIVE_SESSIONS_CEILING}, got: ${value}`,
    );
  }
}

/**
 * Parses AGENT_DOCK_MAX_ACTIVE_SESSIONS. Fails fast (throws) on an out-of-range or non-integer
 * value rather than silently clamping, so a misconfigured deployment never launches with a
 * capacity limit it never intended.
 */
export function resolveMaxActiveSessions(rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue.trim() === '') return DEFAULT_MAX_ACTIVE_SESSIONS;
  const parsed = Number(rawValue);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < MIN_ACTIVE_SESSIONS ||
    parsed > MAX_ACTIVE_SESSIONS_CEILING
  ) {
    throw new Error(
      `AGENT_DOCK_MAX_ACTIVE_SESSIONS must be an integer between ${MIN_ACTIVE_SESSIONS} and ${MAX_ACTIVE_SESSIONS_CEILING}, got: ${JSON.stringify(rawValue)}`,
    );
  }
  return parsed;
}

export interface SessionAdmissionOptions {
  maxActiveSessions: number;
}

/**
 * Daemon-owned admission gate shared by every provider-launching caller (protocol v1's
 * SessionManager.create, protocol v2's SessionManager.createInteractive, and any future one).
 * Counts pending starts and running sessions together and rejects outright once the configured
 * cap is reached — it never queues an admission that would exceed the limit.
 */
export class SessionAdmissionController {
  private readonly limit: number;
  private held = 0;

  constructor(options: SessionAdmissionOptions) {
    assertValidLimit(options.maxActiveSessions);
    this.limit = options.maxActiveSessions;
  }

  get maxActiveSessions(): number {
    return this.limit;
  }

  get activeCount(): number {
    return this.held;
  }

  /** Throws SessionCapacityError instead of queueing when already at the configured limit. */
  acquire(): SessionAdmissionLease {
    if (this.held >= this.limit) throw new SessionCapacityError();
    this.held += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.held -= 1;
      },
    };
  }
}
