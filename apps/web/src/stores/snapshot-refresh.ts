export interface SnapshotRefreshScheduler {
  schedule: () => void;
  flush: () => Promise<void>;
  dispose: () => void;
}

export function createSnapshotRefreshScheduler(
  refresh: () => Promise<void>,
  delayMs = 750,
): SnapshotRefreshScheduler {
  let disposed = false;
  let requested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  const clearScheduled = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const run = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (running) return running;
    requested = false;
    running = refresh().finally(() => {
      running = undefined;
      if (!disposed && requested && timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          void run().catch(() => undefined);
        }, delayMs);
      }
    });
    return running;
  };

  return {
    schedule() {
      if (disposed) return;
      requested = true;
      if (running || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void run().catch(() => undefined);
      }, delayMs);
    },
    async flush() {
      if (disposed) return;
      requested = true;
      clearScheduled();
      while (!disposed && requested) {
        if (running) {
          await running;
        } else {
          await run();
        }
        clearScheduled();
      }
    },
    dispose() {
      disposed = true;
      requested = false;
      clearScheduled();
    },
  };
}
