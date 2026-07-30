import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WeightedConcurrencyBudget,
} from "../src/research-concurrency-budget.js";

test("weighted budget queues work until enough task permits are free", async () => {
  const budget = new WeightedConcurrencyBudget(3);
  const first = await budget.acquire(2);
  let secondAcquired = false;
  const secondPromise = budget.acquire(2).then((lease) => {
    secondAcquired = true;
    return lease;
  });

  await Promise.resolve();
  assert.equal(secondAcquired, false);

  first.release();
  const second = await secondPromise;
  assert.equal(second.requestedWeight, 2);
  assert.equal(second.effectiveWeight, 2);
  second.release();
});

test("weighted budget clamps oversized work to the task capacity", async () => {
  const budget = new WeightedConcurrencyBudget(3);

  const lease = await budget.acquire(8);

  assert.equal(lease.requestedWeight, 8);
  assert.equal(lease.effectiveWeight, 3);
  assert.equal(lease.queued, false);
  assert.equal(lease.waitedMs, 0);
  lease.release();
});

test("weighted budget removes canceled queued work", async () => {
  const budget = new WeightedConcurrencyBudget(1);
  const first = await budget.acquire(1);
  const controller = new AbortController();
  const queued = budget.acquire(1, controller.signal);

  controller.abort(new Error("task canceled"));

  await assert.rejects(queued, /task canceled/u);
  first.release();
  const final = await budget.acquire(1);
  final.release();
});
