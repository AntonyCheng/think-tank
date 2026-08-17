import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  LLMConfig,
  LLMConnector,
  LLMResult,
} from "agency-orchestrator";

import {
  FailoverConnector,
  providerRoute,
} from "../src/model-provider-router.js";

class StubConnector implements LLMConnector {
  calls: LLMConfig[] = [];

  constructor(
    private readonly handler: (config: LLMConfig) => Promise<LLMResult>,
  ) {}

  async chat(
    _systemPrompt: string,
    _userMessage: string,
    config: LLMConfig,
  ): Promise<LLMResult> {
    this.calls.push(config);
    return this.handler(config);
  }
}

test("switches to the fallback provider after a transient primary failure", async () => {
  const primary = new StubConnector(async () => {
    throw new Error("API error 503: upstream unavailable");
  });
  const fallback = new StubConnector(async () => ({
    content: "fallback response",
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const connector = new FailoverConnector({
    primary: providerRoute(primary, {
      baseUrl: "https://primary.example/v1",
      apiKey: "primary-key",
      model: "primary-model",
    }),
    fallback: providerRoute(fallback, {
      baseUrl: "https://backup.example/v1",
      apiKey: "backup-key",
      model: "backup-model",
    }),
  });

  const result = await connector.chat("system", "user", {
    provider: "openai",
    model: "ignored-model",
  });

  assert.equal(result.content, "fallback response");
  assert.equal(primary.calls[0]?.model, "primary-model");
  assert.equal(fallback.calls[0]?.model, "backup-model");
  assert.equal(fallback.calls[0]?.base_url, "https://backup.example/v1");
  assert.equal(fallback.calls[0]?.api_key, "backup-key");
});

test("does not hide a primary authentication failure behind the fallback provider", async () => {
  const primary = new StubConnector(async () => {
    throw new Error("API error 401: invalid key");
  });
  const fallback = new StubConnector(async () => ({
    content: "should not run",
    usage: { input_tokens: 0, output_tokens: 0 },
  }));
  const connector = new FailoverConnector({
    primary: { connector: primary },
    fallback: { connector: fallback },
  });

  await assert.rejects(
    connector.chat("system", "user", { provider: "openai", model: "model" }),
    /401/u,
  );
  assert.equal(fallback.calls.length, 0);
});
