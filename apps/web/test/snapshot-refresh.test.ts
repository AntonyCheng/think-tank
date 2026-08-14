import assert from "node:assert/strict";
import test from "node:test";
import { createSnapshotRefreshScheduler } from "../src/stores/snapshot-refresh";

const wait = (milliseconds: number) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

test("coalesces a burst of scheduled snapshot refreshes", async () => {
  let refreshCount = 0;
  const scheduler = createSnapshotRefreshScheduler(async () => {
    refreshCount += 1;
  }, 2);

  for (let index = 0; index < 100; index += 1) scheduler.schedule();
  await wait(30);

  assert.equal(refreshCount, 1);
  scheduler.dispose();
});

test("runs one trailing refresh when events arrive during a refresh", async () => {
  let refreshCount = 0;
  let releaseFirstRefresh: (() => void) | undefined;
  let markFirstRefreshStarted: (() => void) | undefined;
  const firstRefreshStarted = new Promise<void>((resolve) => {
    markFirstRefreshStarted = resolve;
  });
  const firstRefreshReleased = new Promise<void>((resolve) => {
    releaseFirstRefresh = resolve;
  });
  const scheduler = createSnapshotRefreshScheduler(async () => {
    refreshCount += 1;
    if (refreshCount === 1) {
      markFirstRefreshStarted?.();
      await firstRefreshReleased;
    }
  }, 2);

  const initialRefresh = scheduler.flush();
  await firstRefreshStarted;
  for (let index = 0; index < 100; index += 1) scheduler.schedule();
  releaseFirstRefresh?.();
  await initialRefresh;

  assert.equal(refreshCount, 2);
  scheduler.dispose();
});
