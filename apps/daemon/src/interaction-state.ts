export type PendingInteractionKind = 'approval' | 'question';
export type InteractionResolutionReason =
  'cancel' | 'disconnect' | 'interrupt' | 'overflow' | 'shutdown' | 'timeout' | 'trust_revoked';

export interface PendingInteractionInput {
  requestId: string;
  turnId: string;
  kind: PendingInteractionKind;
  /** Provider wall-clock deadline; the daemon's publication budget remains monotonic. */
  providerDeadlineAtMs?: number;
}

export interface PendingInteraction extends Omit<PendingInteractionInput, 'providerDeadlineAtMs'> {
  state: 'unpublished' | 'pending' | 'resolving';
  publishedAtMonotonicMs?: number;
  deadlineMonotonicMs?: number;
}

export interface MonotonicScheduler {
  now(): number;
  set(delayMs: number, callback: () => void): unknown;
  clear(timer: unknown): void;
}

const DEFAULT_INTERACTION_TIMEOUT_MS = 5 * 60 * 1_000;

const systemScheduler: MonotonicScheduler = {
  now: () => Number(process.hrtime.bigint() / 1_000_000n),
  set: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Atomic, await-free ownership of daemon-facing interactions. Provider I/O happens only after a
 * caller wins `claim`, so user/timeout/disconnect/shutdown races have exactly one winner.
 */
export class InteractionState {
  private readonly pending = new Map<
    string,
    { interaction: PendingInteraction; providerDeadlineMonotonicMs?: number; timer?: unknown }
  >();

  constructor(
    private readonly onTimeout: (interaction: PendingInteraction) => void,
    private readonly scheduler: MonotonicScheduler = systemScheduler,
    private readonly timeoutMs = DEFAULT_INTERACTION_TIMEOUT_MS,
  ) {}

  register(input: PendingInteractionInput): boolean {
    if (this.pending.has(input.requestId)) return false;
    const { providerDeadlineAtMs, ...interaction } = input;
    const boundedProviderDeadlineAtMs =
      providerDeadlineAtMs === undefined
        ? undefined
        : Number.isFinite(providerDeadlineAtMs)
          ? providerDeadlineAtMs
          : 0;
    const providerDeadlineMonotonicMs =
      boundedProviderDeadlineAtMs === undefined
        ? undefined
        : this.scheduler.now() + Math.max(0, boundedProviderDeadlineAtMs - Date.now());
    this.pending.set(input.requestId, {
      interaction: { ...interaction, state: 'unpublished' },
      ...(providerDeadlineMonotonicMs !== undefined ? { providerDeadlineMonotonicMs } : {}),
    });
    return true;
  }

  /** Arms the deadline only after the request was actually handed to the sole responder. */
  markPublished(requestId: string): boolean {
    const record = this.pending.get(requestId);
    if (!record || record.interaction.state !== 'unpublished') return false;
    const publishedAtMonotonicMs = this.scheduler.now();
    const providerRemainingMs =
      record.providerDeadlineMonotonicMs === undefined
        ? this.timeoutMs
        : Math.max(0, record.providerDeadlineMonotonicMs - publishedAtMonotonicMs);
    const timeoutMs = Math.min(this.timeoutMs, providerRemainingMs);
    record.interaction = {
      ...record.interaction,
      state: 'pending',
      publishedAtMonotonicMs,
      deadlineMonotonicMs: publishedAtMonotonicMs + timeoutMs,
    };
    record.timer = this.scheduler.set(timeoutMs, () => {
      const claimed = this.claim(requestId);
      if (claimed) this.onTimeout(claimed);
    });
    return true;
  }

  get(requestId: string): Readonly<PendingInteraction> | undefined {
    return this.pending.get(requestId)?.interaction;
  }

  claim(
    requestId: string,
    expected?: { turnId?: string; kind?: PendingInteractionKind },
  ): PendingInteraction | undefined {
    const record = this.pending.get(requestId);
    if (!record || record.interaction.state === 'resolving') return undefined;
    if (expected?.turnId !== undefined && record.interaction.turnId !== expected.turnId) {
      return undefined;
    }
    if (expected?.kind !== undefined && record.interaction.kind !== expected.kind) return undefined;
    if (record.timer !== undefined) this.scheduler.clear(record.timer);
    record.timer = undefined;
    record.interaction = { ...record.interaction, state: 'resolving' };
    return record.interaction;
  }

  claimAll(): PendingInteraction[] {
    const claimed: PendingInteraction[] = [];
    for (const requestId of this.pending.keys()) {
      const interaction = this.claim(requestId);
      if (interaction) claimed.push(interaction);
    }
    return claimed;
  }

  claimTurn(turnId: string): PendingInteraction[] {
    const claimed: PendingInteraction[] = [];
    for (const [requestId, record] of this.pending) {
      if (record.interaction.turnId !== turnId) continue;
      const interaction = this.claim(requestId);
      if (interaction) claimed.push(interaction);
    }
    return claimed;
  }

  settle(requestId: string): boolean {
    const record = this.pending.get(requestId);
    if (!record || record.interaction.state !== 'resolving') return false;
    if (record.timer !== undefined) this.scheduler.clear(record.timer);
    this.pending.delete(requestId);
    return true;
  }

  removeResolved(requestId: string): boolean {
    const record = this.pending.get(requestId);
    if (!record) return false;
    if (record.timer !== undefined) this.scheduler.clear(record.timer);
    this.pending.delete(requestId);
    return true;
  }
}
