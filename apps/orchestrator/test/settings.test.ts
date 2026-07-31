import assert from "node:assert/strict";
import { test } from "node:test";

import { settingsFromEnv } from "../src/settings.js";

test("loads the deployment-global v1 settings and normalizes GPTR models", () => {
  const settings = settingsFromEnv({
    OPENAI_API_KEY: "key",
    OPENAI_BASE_URL: "https://models.example/v1",
    AO_PLANNER_MODEL: "planner",
    AO_VERIFIER_MODEL: "verifier",
    GPTR_FAST_LLM: "fast",
    GPTR_SMART_LLM: "custom:smart",
    GPTR_EMBEDDING: "embedding-model",
    GPTR_EMBEDDING_BASE_URL: "https://embeddings.example/v1",
    RETRIEVER: "duckduckgo",
    AO_CONCURRENCY: "3",
    APP_TIMEZONE: "Asia/Shanghai",
  });

  assert.equal(settings.planner.model, "planner");
  assert.equal(settings.gptrFastLlm, "openai:fast");
  assert.equal(settings.gptrSmartLlm, "custom:smart");
  assert.equal(settings.gptrEmbedding, "custom:embedding-model");
  assert.equal(
    settings.gptrEmbeddingBaseUrl,
    "https://embeddings.example/v1",
  );
  assert.equal(settings.retriever, "duckduckgo");
  assert.deepEqual(settings.retrievers, ["duckduckgo"]);
  assert.equal(settings.concurrency, 3);
  assert.equal(settings.timeZone, "Asia/Shanghai");
  assert.equal(settings.gptrHealthTimeoutMs, 5_000);
  assert.equal(settings.gptrResearchTimeoutMs, 30 * 60 * 1_000);
  assert.equal(settings.gptrCleanupGraceMs, 20_000);
  assert.equal(settings.taskExecutionTimeoutMs, 2 * 60 * 60 * 1_000);
  assert.equal(settings.gptrTaskConcurrencyBudget, 4);
  assert.deepEqual(settings.gptrDeepLimits, {
    maxBreadth: 4,
    maxDepth: 3,
    maxResearchCalls: 32,
  });
});

test("loads an ordered multi-retriever default grant", () => {
  const settings = settingsFromEnv({
    OPENAI_API_KEY: "key",
    AO_PLANNER_MODEL: "planner",
    GPTR_FAST_LLM: "fast",
    GPTR_SMART_LLM: "smart",
    GPTR_EMBEDDING: "embedding-model",
    RETRIEVER: "duckduckgo, openalex",
  });

  assert.equal(settings.retriever, "duckduckgo");
  assert.deepEqual(settings.retrievers, ["duckduckgo", "openalex"]);
});

test("rejects an invalid application time zone", () => {
  assert.throws(
    () => settingsFromEnv({
      OPENAI_API_KEY: "key",
      AO_PLANNER_MODEL: "planner",
      GPTR_FAST_LLM: "fast",
      GPTR_SMART_LLM: "smart",
      GPTR_EMBEDDING: "m3e",
      APP_TIMEZONE: "Mars/Olympus",
    }),
    /APP_TIMEZONE must be a valid IANA time zone/u,
  );
});

test("validates configured execution timeouts", () => {
  assert.throws(
    () => settingsFromEnv({
      OPENAI_API_KEY: "key",
      AO_PLANNER_MODEL: "planner",
      GPTR_FAST_LLM: "fast",
      GPTR_SMART_LLM: "smart",
      GPTR_EMBEDDING: "m3e",
      GPTR_RESEARCH_TIMEOUT_MS: "0",
    }),
    /GPTR_RESEARCH_TIMEOUT_MS must be a positive integer/u,
  );

  assert.throws(
    () => settingsFromEnv({
      OPENAI_API_KEY: "key",
      AO_PLANNER_MODEL: "planner",
      GPTR_FAST_LLM: "fast",
      GPTR_SMART_LLM: "smart",
      GPTR_EMBEDDING: "m3e",
      GPTR_RESEARCH_TIMEOUT_MS: "20000",
      GPTR_CLEANUP_GRACE_MS: "20000",
    }),
    /GPTR_CLEANUP_GRACE_MS must be smaller/u,
  );
});

test("validates deployment limits for deep research", () => {
  assert.throws(
    () => settingsFromEnv({
      OPENAI_API_KEY: "key",
      AO_PLANNER_MODEL: "planner",
      GPTR_FAST_LLM: "fast",
      GPTR_SMART_LLM: "smart",
      GPTR_EMBEDDING: "m3e",
      GPTR_DEEP_MAX_RESEARCH_CALLS: "0",
    }),
    /GPTR_DEEP_MAX_RESEARCH_CALLS must be a positive integer/u,
  );
});
