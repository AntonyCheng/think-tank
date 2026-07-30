import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  LLMConfig,
  LLMConnector,
  LLMResult,
} from "agency-orchestrator";

import { RoutingConnector } from "../src/routing-connector.js";

class StubConnector implements LLMConnector {
  readonly name: string;
  calls: LLMConfig[] = [];

  constructor(name: string) {
    this.name = name;
  }

  async chat(
    _systemPrompt: string,
    _userMessage: string,
    config: LLMConfig,
  ): Promise<LLMResult> {
    this.calls.push(config);
    return {
      content: this.name,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}

test("routes expert work to GPTR and acceptance JSON to the verifier", async () => {
  const research = new StubConnector("research");
  const verifier = new StubConnector("verifier");
  const connector = new RoutingConnector({
    research,
    verifier: {
      apiKey: "key",
      baseUrl: "https://models.example/v1",
      model: "verifier-model",
      connector: verifier,
    },
  });

  const expertResult = await connector.chat("expert", "research task", {
    provider: "openai",
    model: "planner",
  });
  const verifyResult = await connector.chat(
    "reviewer",
    'Output {"pass": true/false, "failed": [{"criterion": "", "why": ""}]}',
    { provider: "openai", model: "planner" },
  );

  assert.equal(expertResult.content, "research");
  assert.equal(verifyResult.content, "verifier");
  assert.equal(research.calls.length, 1);
  assert.equal(verifier.calls[0]?.model, "verifier-model");
});

test("reuses the previous report through synthesis during acceptance rework", async () => {
  const research = new StubConnector("# Revised report\n\nComplete result.");
  const connector = new RoutingConnector({ research });
  const originalProfile = {
    schemaVersion: 1,
    mode: "deep",
    source: {
      mode: "web",
      retrievers: ["duckduckgo"],
    },
    quality: { curateSources: false },
    limits: {
      maxSearchResultsPerQuery: 5,
      maxIterations: 3,
      maxSubtopics: 3,
    },
    deep: {
      breadth: 3,
      depth: 2,
      concurrency: 2,
    },
  };
  const message = [
    "Below is your previous deliverable. Revise it in place — do NOT rewrite from scratch:",
    "",
    "# Previous report",
    "",
    "Existing evidence.",
    "",
    "---",
    "Acceptance review found the following criteria NOT met:",
    "- Add a conclusion.",
  ].join("\n");

  await connector.chat("expert", message, {
    provider: "openai",
    params: { think_tank: originalProfile },
  });

  const routedProfile = research.calls[0]?.params?.think_tank as any;
  assert.equal(routedProfile.mode, "synthesis");
  assert.equal(Object.hasOwn(routedProfile, "deep"), false);
  assert.equal(routedProfile.limits.maxIterations, 3);
  assert.equal(originalProfile.mode, "deep");
  assert.equal(Object.hasOwn(originalProfile, "deep"), true);
});
