export interface ResearchBudgetLease {
  requestedWeight: number;
  effectiveWeight: number;
  waitedMs: number;
  queued: boolean;
  release(): void;
}

interface PendingAcquire {
  requestedWeight: number;
  effectiveWeight: number;
  enqueuedAt: number;
  queued: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (lease: ResearchBudgetLease) => void;
  reject: (reason: unknown) => void;
}

export class WeightedConcurrencyBudget {
  readonly capacity: number;
  #activeWeight = 0;
  #queue: PendingAcquire[] = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Research concurrency capacity must be a positive integer.");
    }
    this.capacity = capacity;
  }

  async acquire(
    requestedWeight: number,
    signal?: AbortSignal,
  ): Promise<ResearchBudgetLease> {
    if (!Number.isInteger(requestedWeight) || requestedWeight < 1) {
      throw new Error("Research concurrency weight must be a positive integer.");
    }
    if (signal?.aborted) {
      throw abortReason(signal);
    }

    return await new Promise<ResearchBudgetLease>((resolve, reject) => {
      const pending: PendingAcquire = {
        requestedWeight,
        effectiveWeight: Math.min(requestedWeight, this.capacity),
        enqueuedAt: Date.now(),
        queued: this.#queue.length > 0 ||
          this.#activeWeight + Math.min(requestedWeight, this.capacity) >
            this.capacity,
        signal,
        resolve,
        reject,
      };
      if (signal) {
        pending.onAbort = () => {
          const index = this.#queue.indexOf(pending);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          reject(abortReason(signal));
          this.#drain();
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.#queue.push(pending);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#queue.length > 0) {
      const pending = this.#queue[0]!;
      if (this.#activeWeight + pending.effectiveWeight > this.capacity) {
        return;
      }
      this.#queue.shift();
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      this.#activeWeight += pending.effectiveWeight;
      let released = false;
      pending.resolve({
        requestedWeight: pending.requestedWeight,
        effectiveWeight: pending.effectiveWeight,
        waitedMs: pending.queued
          ? Math.max(0, Date.now() - pending.enqueuedAt)
          : 0,
        queued: pending.queued,
        release: () => {
          if (released) return;
          released = true;
          this.#activeWeight -= pending.effectiveWeight;
          this.#drain();
        },
      });
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Research task was canceled.");
}
