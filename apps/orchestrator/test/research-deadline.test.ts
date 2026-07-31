import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveResearchDeadline } from "../src/research-deadline.js";

test("keeps the Researcher deadline inside AO's outer timeout", () => {
  assert.deepEqual(resolveResearchDeadline({
    configuredResearchTimeoutMs: 1_800_000,
    aoAttemptTimeoutMs: 300_000,
    cleanupGraceMs: 20_000,
  }), {
    executionTimeoutMs: 280_000,
    connectorTimeoutMs: 295_000,
    outerTimeoutMs: 300_000,
  });
});

test("uses the configured research deadline when AO has no timeout", () => {
  assert.deepEqual(resolveResearchDeadline({
    configuredResearchTimeoutMs: 1_800_000,
    aoAttemptTimeoutMs: 0,
    cleanupGraceMs: 20_000,
  }), {
    executionTimeoutMs: 1_800_000,
    connectorTimeoutMs: 1_820_000,
  });
});

test("rejects an AO timeout that cannot accommodate worker cleanup", () => {
  assert.throws(
    () => resolveResearchDeadline({
      configuredResearchTimeoutMs: 60_000,
      aoAttemptTimeoutMs: 20_000,
      cleanupGraceMs: 20_000,
    }),
    /must exceed GPTR cleanup grace/u,
  );
});
