import assert from "node:assert/strict";
import { test } from "node:test";

import { preflightRuntimeSettings } from "../src/settings-preflight.js";
import type { RuntimeSettings } from "../src/settings.js";

const settings: RuntimeSettings = {
  planner: {
    provider: "openai",
    api_key: "model-secret",
    base_url: "https://models.example/v1",
    model: "planner",
    max_tokens: 100,
  },
  gptrServiceUrl: "http://127.0.0.1:8010",
  retriever: "duckduckgo",
  retrievers: ["duckduckgo"],
  retrieverApiKeys: {},
  gptrFastLlm: "openai:fast",
  gptrSmartLlm: "openai:smart",
  gptrEmbedding: "custom:m3e",
  gptrEmbeddingBaseUrl: "https://embedding.example/v1",
  gptrEmbeddingApiKey: "embedding-secret",
  timeZone: "Asia/Shanghai",
  concurrency: 2,
  modelPreflightTimeoutMs: 30_000,
  gptrHealthTimeoutMs: 5_000,
  gptrResearchTimeoutMs: 60_000,
  gptrCleanupGraceMs: 5_000,
  taskExecutionTimeoutMs: 120_000,
  gptrTaskConcurrencyBudget: 2,
  gptrDeepLimits: { maxBreadth: 2, maxDepth: 2, maxResearchCalls: 4 },
};

test("returns the redacted embedding response body for a failed check", async () => {
  const checks = await preflightRuntimeSettings(
    settings,
    async () => new Response(
      JSON.stringify({
        error: `Invalid embedding key embedding-secret; expected model m3e-v2`,
      }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    ),
    "embedding",
  );

  assert.deepEqual(checks, [{
    id: "embedding",
    label: "Embedding 模型",
    status: "failed",
    detail: 'Embedding 接口响应（HTTP 422）：\n{"error":"Invalid embedding key [redacted]; expected model m3e-v2"}',
  }]);
});

test("limits preflight to the requested scope", async () => {
  const observed: string[] = [];
  const bodies: string[] = [];
  const checks = await preflightRuntimeSettings(
    settings,
    async (url, options) => {
      observed.push(String(url));
      bodies.push(String(options?.body));
      return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    "embedding",
  );

  assert.deepEqual(checks.map((check) => check.id), ["embedding"]);
  assert.deepEqual(observed, ["https://embedding.example/v1/embeddings"]);
  assert.deepEqual(JSON.parse(bodies[0]!), {
    model: "m3e",
    input: ["健康检查"],
  });
});
