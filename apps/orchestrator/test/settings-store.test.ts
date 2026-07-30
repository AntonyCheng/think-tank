import assert from "node:assert/strict";
import { test } from "node:test";

import { RuntimeSettingsStore } from "../src/settings-store.js";

const baseEnv = {
  OPENAI_API_KEY: "secret",
  OPENAI_BASE_URL: "https://models.example/v1",
  AO_PLANNER_MODEL: "planner",
  AO_VERIFIER_MODEL: "",
  GPTR_FAST_LLM: "fast",
  GPTR_SMART_LLM: "smart",
  GPTR_EMBEDDING: "m3e",
  GPTR_EMBEDDING_BASE_URL: "https://embedding.example/v1",
  RETRIEVER: "duckduckgo",
  AO_CONCURRENCY: "2",
};

test("updates deployment settings without exposing the API key", () => {
  const store = new RuntimeSettingsStore(baseEnv);

  const updated = store.update({
    retriever: "tavily",
    concurrency: 3,
    gptrEmbeddingBaseUrl: "https://new-embedding.example/v1",
  });

  assert.equal(updated.retriever, "tavily");
  assert.equal(updated.concurrency, 3);
  assert.equal(
    updated.gptrEmbeddingBaseUrl,
    "https://new-embedding.example/v1",
  );
  assert.equal(updated.apiKeyConfigured, true);
  assert.equal("apiKey" in updated, false);
  assert.equal(store.getRuntimeSettings().planner.api_key, "secret");
});

test("updates the default multi-retriever grant", () => {
  const store = new RuntimeSettingsStore(baseEnv);

  const updated = store.update({
    retrievers: ["duckduckgo", "openalex"],
  });

  assert.deepEqual(updated.retrievers, ["duckduckgo", "openalex"]);
  assert.equal(updated.retriever, "duckduckgo");
  assert.deepEqual(
    store.getRuntimeSettings().retrievers,
    ["duckduckgo", "openalex"],
  );
});
