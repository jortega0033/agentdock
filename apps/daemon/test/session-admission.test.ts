import { describe, expect, it } from 'vitest';
import {
  SessionAdmissionController,
  SessionCapacityError,
  resolveMaxActiveSessions,
} from '../src/session-admission.js';

describe('resolveMaxActiveSessions', () => {
  it('defaults to 4 when unset or blank', () => {
    expect(resolveMaxActiveSessions(undefined)).toBe(4);
    expect(resolveMaxActiveSessions('')).toBe(4);
    expect(resolveMaxActiveSessions('   ')).toBe(4);
  });

  it('accepts the full documented range', () => {
    expect(resolveMaxActiveSessions('1')).toBe(1);
    expect(resolveMaxActiveSessions('32')).toBe(32);
    expect(resolveMaxActiveSessions('17')).toBe(17);
  });

  it('rejects 0, negative, non-integer, and above-ceiling values', () => {
    expect(() => resolveMaxActiveSessions('0')).toThrow(/AGENT_DOCK_MAX_ACTIVE_SESSIONS/);
    expect(() => resolveMaxActiveSessions('-1')).toThrow(/AGENT_DOCK_MAX_ACTIVE_SESSIONS/);
    expect(() => resolveMaxActiveSessions('33')).toThrow(/AGENT_DOCK_MAX_ACTIVE_SESSIONS/);
    expect(() => resolveMaxActiveSessions('4.5')).toThrow(/AGENT_DOCK_MAX_ACTIVE_SESSIONS/);
    expect(() => resolveMaxActiveSessions('not-a-number')).toThrow(
      /AGENT_DOCK_MAX_ACTIVE_SESSIONS/,
    );
    expect(() => resolveMaxActiveSessions('Infinity')).toThrow(/AGENT_DOCK_MAX_ACTIVE_SESSIONS/);
  });
});

describe('SessionAdmissionController', () => {
  it('rejects construction with an out-of-range or non-integer limit', () => {
    expect(() => new SessionAdmissionController({ maxActiveSessions: 0 })).toThrow();
    expect(() => new SessionAdmissionController({ maxActiveSessions: 33 })).toThrow();
    expect(() => new SessionAdmissionController({ maxActiveSessions: 1.5 })).toThrow();
  });

  it('admits up to the configured limit and rejects the next with SessionCapacityError', () => {
    const controller = new SessionAdmissionController({ maxActiveSessions: 2 });
    expect(controller.activeCount).toBe(0);
    const first = controller.acquire();
    const second = controller.acquire();
    expect(controller.activeCount).toBe(2);
    expect(() => controller.acquire()).toThrow(SessionCapacityError);
    expect(controller.activeCount).toBe(2);
    first.release();
    second.release();
  });

  it('carries the session_capacity_exceeded code for HTTP mapping', () => {
    const controller = new SessionAdmissionController({ maxActiveSessions: 1 });
    controller.acquire();
    try {
      controller.acquire();
      throw new Error('expected acquire() to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionCapacityError);
      expect((error as SessionCapacityError).code).toBe('session_capacity_exceeded');
    }
  });

  it('makes a slot immediately reusable after release', () => {
    const controller = new SessionAdmissionController({ maxActiveSessions: 1 });
    const lease = controller.acquire();
    expect(() => controller.acquire()).toThrow(SessionCapacityError);
    lease.release();
    expect(controller.activeCount).toBe(0);
    const next = controller.acquire();
    expect(controller.activeCount).toBe(1);
    next.release();
  });

  it('is idempotent: releasing the same lease twice never double-frees a slot', () => {
    const controller = new SessionAdmissionController({ maxActiveSessions: 1 });
    const lease = controller.acquire();
    lease.release();
    lease.release();
    expect(controller.activeCount).toBe(0);
    // A double release must not manufacture a phantom extra slot: two fresh acquisitions after
    // it should behave exactly as the configured limit of 1 dictates.
    const a = controller.acquire();
    expect(() => controller.acquire()).toThrow(SessionCapacityError);
    a.release();
  });

  it('tracks independent leases correctly when released out of order', () => {
    const controller = new SessionAdmissionController({ maxActiveSessions: 3 });
    const a = controller.acquire();
    const b = controller.acquire();
    const c = controller.acquire();
    expect(controller.activeCount).toBe(3);
    b.release();
    expect(controller.activeCount).toBe(2);
    a.release();
    c.release();
    expect(controller.activeCount).toBe(0);
  });

  it('exposes the configured limit', () => {
    const controller = new SessionAdmissionController({ maxActiveSessions: 7 });
    expect(controller.maxActiveSessions).toBe(7);
  });
});
