import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { EvidenceLedger } from "../src/evidence-bundle.js";
import { GptrConnector } from "../src/gptr-connector.js";
import {
  resolveResearchProfile,
  type ResearchCapabilities,
} from "../src/research-profile.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("maps an AO chat call to a GPT Researcher request", async () => {
  let receivedBody: unknown;
  let receivedUrl = "";
  const progress: Array<{ type: string; researchId: string }> = [];
  let invocationTimes:
    | { queuedAt: string; startedAt: string; queueWaitMs: number }
    | undefined;
  globalThis.fetch = async (_input, init) => {
    receivedUrl = String(_input);
    receivedBody = JSON.parse(String(init?.body));
    const messages = [
      JSON.stringify({
        type: "event",
        event: {
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "logs",
          data: { content: "Searching sources" },
        },
      }),
      JSON.stringify({
        type: "result",
        result: {
        report: "# report",
        sourceUrls: ["https://example.com"],
        sources: [],
        researchEvidence: {
          queries: [{
            kind: "subquery",
            text: "current evidence",
          }],
          sources: [{
            visibility: "public",
            url: "https://example.com",
            title: "Example evidence",
          }],
          researchContext: {
            content: "bounded context",
            originalCharacters: 15,
            truncated: false,
          },
        },
        cost: 0.01,
        events: [],
        },
      }),
    ].join("\n") + "\n";
    const encoded = new TextEncoder().encode(messages);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoded.slice(0, 37));
          controller.enqueue(encoded.slice(37));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      },
    );
  };

  const capabilities: ResearchCapabilities = {
    modes: ["standard"],
    sourceModes: ["web"],
    retrievers: ["duckduckgo"],
    maxRetrievers: 1,
    sourceCuration: false,
    domainFilters: false,
  };
  const taskProfile = resolveResearchProfile(
    null,
    { defaultRetriever: "duckduckgo" },
    capabilities,
  );
  const stepProfile = resolveResearchProfile(
    { limits: { maxIterations: 6 } },
    { defaultRetriever: "duckduckgo" },
    capabilities,
  );
  const evidenceLedger = new EvidenceLedger();
  const connector = new GptrConnector({
    serviceUrl: "http://127.0.0.1:8010",
    retriever: "duckduckgo",
    researchProfile: taskProfile,
    researchCapabilities: capabilities,
    runtimeContext: {
      startedAt: "2026-07-29T03:20:00.000Z",
      timeZone: "Asia/Shanghai",
      localDate: "2026-07-29",
      localTime: "11:20:00",
      weekday: "星期三",
    },
    baseUrl: "https://models.example/v1/",
    apiKey: "test-key",
    fastLlm: "openai:fast-model",
    smartLlm: "openai:smart-model",
    embedding: "openai:embedding-model",
    embeddingBaseUrl: "https://embeddings.example/v1/",
    evidenceLedger,
    onResearchEvent: (event, invocation) => {
      invocationTimes ??= {
        queuedAt: invocation.queuedAt,
        startedAt: invocation.startedAt,
        queueWaitMs: invocation.budget.waitedMs,
      };
      progress.push({
        type: event.type,
        researchId:
          `${invocation.id}:${invocation.researchProfile.limits.maxIterations}`,
      });
    },
  });

  const result = await connector.chat("expert role", "research task", {
    provider: "openai",
    params: {
      think_tank: stepProfile,
      think_tank_runtime: {
        aoStepId: "market_analysis",
        dependsOn: [],
      },
    },
  });

  assert.deepEqual(receivedBody, {
    systemPrompt: "expert role",
    task: "research task",
    reportSource: "web",
    retriever: "duckduckgo",
    researchProfile: stepProfile,
    runtimeContext: {
      startedAt: "2026-07-29T03:20:00.000Z",
      timeZone: "Asia/Shanghai",
      localDate: "2026-07-29",
      localTime: "11:20:00",
      weekday: "星期三",
    },
    baseUrl: "https://models.example/v1/",
    apiKey: "test-key",
    fastLlm: "openai:fast-model",
    smartLlm: "openai:smart-model",
    embedding: "openai:embedding-model",
    embeddingBaseUrl: "https://embeddings.example/v1/",
  });
  assert.match(receivedUrl, /\/research\/stream$/u);
  assert.deepEqual(progress, [{
    type: "research.mode.selected",
    researchId: "research-1:6",
  }, {
    type: "logs",
    researchId: "research-1:6",
  }]);
  assert.ok(invocationTimes);
  assert.ok(
    Date.parse(invocationTimes.queuedAt) <=
      Date.parse(invocationTimes.startedAt),
  );
  assert.equal(invocationTimes.queueWaitMs, 0);
  assert.equal(result.content, "# report");
  assert.deepEqual(result.usage, {
    input_tokens: 0,
    output_tokens: 0,
  });
  const [bundle] = evidenceLedger.snapshot();
  assert.equal(bundle?.aoStepId, "market_analysis");
  assert.equal(bundle?.researchRunId, "research-1");
  assert.equal(bundle?.mode, "standard");
  assert.deepEqual(bundle?.queries, [{
    id: "query-1",
    kind: "subquery",
    text: "current evidence",
  }]);
  assert.deepEqual(bundle?.sources, [{
    id: "source-1",
    visibility: "public",
    url: "https://example.com/",
    title: "Example evidence",
    sourceType: "web",
    observedAt: bundle?.completedAt,
  }]);
});

test("maps a URL-only profile without requiring a Web policy", async () => {
  let receivedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const message = JSON.stringify({
      type: "result",
      result: {
        report: "# URL report",
        sourceUrls: ["https://example.com/report"],
        sources: [],
        cost: 0.01,
        events: [],
      },
    }) + "\n";
    return new Response(message, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  };
  const capabilities: ResearchCapabilities = {
    modes: ["standard"],
    sourceModes: ["web", "urls"],
    retrievers: ["duckduckgo"],
    maxRetrievers: 1,
    sourceCuration: false,
    domainFilters: true,
    urlSourceModes: ["standard"],
    domainFilterModes: ["standard"],
  };
  const profile = resolveResearchProfile(
    {
      source: {
        mode: "urls",
        urls: ["https://example.com/report"],
      },
    },
    { defaultRetriever: "duckduckgo" },
    capabilities,
  );
  const connector = new GptrConnector({
    serviceUrl: "http://127.0.0.1:8010",
    retriever: "duckduckgo",
    researchProfile: profile,
    researchCapabilities: capabilities,
  });

  const result = await connector.chat("expert role", "URL task", {
    provider: "openai",
  });

  assert.equal(result.content, "# URL report");
  assert.equal(receivedBody?.retriever, "duckduckgo");
  assert.deepEqual(receivedBody?.researchProfile, profile);
});

test("sends only declared dependency evidence to a synthesis step", async () => {
  let receivedBody: any;
  globalThis.fetch = async (_input, init) => {
    receivedBody = JSON.parse(String(init?.body));
    const encoded = new TextEncoder().encode(
      `${JSON.stringify({
        type: "result",
        result: {
          report: "# synthesis",
          sourceUrls: [],
          sources: [],
          researchEvidence: {
            queries: [],
            sources: [],
            researchContext: {
              content: "",
              originalCharacters: 0,
              truncated: false,
            },
          },
          cost: 0,
          events: [],
        },
      })}\n`,
    );
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      }),
      { status: 200 },
    );
  };

  const capabilities: ResearchCapabilities = {
    modes: ["standard", "synthesis"],
    sourceModes: ["web"],
    retrievers: ["duckduckgo"],
    maxRetrievers: 1,
    sourceCuration: false,
    domainFilters: false,
  };
  const standardProfile = resolveResearchProfile(
    null,
    { defaultRetriever: "duckduckgo" },
    capabilities,
  );
  const synthesisProfile = resolveResearchProfile(
    { mode: "synthesis" },
    { defaultRetriever: "duckduckgo" },
    capabilities,
  );
  const evidenceLedger = new EvidenceLedger();
  for (const [aoStepId, url] of [
    ["market", "https://example.com/market"],
    ["unrelated", "https://example.com/unrelated"],
  ] as const) {
    evidenceLedger.record({
      aoStepId,
      researchRunId: `research-${aoStepId}`,
      dependsOn: [],
      profile: standardProfile,
      startedAt: "2026-07-29T10:00:00.000Z",
      completedAt: "2026-07-29T10:01:00.000Z",
      report: `# ${aoStepId}`,
      cost: 0,
      capture: {
        queries: [],
        sources: [{
          visibility: "public",
          url,
          title: aoStepId,
        }],
        researchContext: {
          content: `${aoStepId} context`,
          originalCharacters: aoStepId.length + 8,
          truncated: false,
        },
      },
    });
  }
  const connector = new GptrConnector({
    serviceUrl: "http://127.0.0.1:8010",
    retriever: "duckduckgo",
    researchProfile: synthesisProfile,
    researchCapabilities: capabilities,
    evidenceLedger,
  });

  await connector.chat("writer", "combine evidence", {
    provider: "openai",
    params: {
      think_tank_runtime: {
        aoStepId: "final",
        dependsOn: ["market"],
      },
    },
  });

  assert.equal(receivedBody.researchProfile.mode, "synthesis");
  assert.deepEqual(
    receivedBody.upstreamEvidence.map(
      (bundle: { aoStepId: string }) => bundle.aoStepId,
    ),
    ["market"],
  );
  assert.equal(
    receivedBody.upstreamEvidence[0].sources[0].url,
    "https://example.com/market",
  );
});

test("aborts the GPTR stream when the task is canceled", async () => {
  globalThis.fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    });
  const controller = new AbortController();
  const connector = new GptrConnector({
    serviceUrl: "http://127.0.0.1:8010",
    retriever: "duckduckgo",
    signal: controller.signal,
  });

  const result = connector.chat("expert role", "research task", {
    provider: "openai",
  });
  controller.abort(new Error("任务已由用户取消。"));

  await assert.rejects(result, /任务已由用户取消/u);
});

test("reports a terminal research failure with its stable run identity", async () => {
  globalThis.fetch = async () =>
    new Response("upstream unavailable", { status: 502 });
  let observed:
    | {
        state: string;
        aoStepId: string;
        researchRunId: string;
        error: unknown;
      }
    | undefined;
  const connector = new GptrConnector({
    serviceUrl: "http://127.0.0.1:8010",
    retriever: "duckduckgo",
    onResearchFailure: (failure, invocation) => {
      observed = {
        state: failure.state,
        aoStepId: invocation.aoStepId,
        researchRunId: invocation.id,
        error: failure.error,
      };
    },
  });

  await assert.rejects(
    connector.chat("expert", "task", {
      provider: "openai",
      params: {
        think_tank_runtime: {
          aoStepId: "risk_analysis",
          dependsOn: [],
        },
      },
    }),
    /returned 502/u,
  );

  assert.equal(observed?.state, "failed");
  assert.equal(observed?.aoStepId, "risk_analysis");
  assert.equal(observed?.researchRunId, "research-1");
  assert.ok(observed?.error instanceof Error);
});

test("clamps native deep concurrency to the task research budget", async () => {
  let receivedBody: any;
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  globalThis.fetch = async (_input, init) => {
    receivedBody = JSON.parse(String(init?.body));
    const encoded = new TextEncoder().encode(
      `${JSON.stringify({
        type: "result",
        result: {
          report: "# deep report",
          sourceUrls: [],
          sources: [],
          cost: 0,
          events: [],
        },
      })}\n`,
    );
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      }),
      { status: 200 },
    );
  };
  const capabilities: ResearchCapabilities = {
    modes: ["standard", "deep", "synthesis"],
    sourceModes: ["web"],
    retrievers: ["duckduckgo"],
    maxRetrievers: 1,
    sourceCuration: false,
    domainFilters: false,
    deepResearch: {
      maxBreadth: 4,
      maxDepth: 3,
      maxResearchCalls: 32,
    },
  };
  const requestedProfile = resolveResearchProfile(
    {
      mode: "deep",
      deep: { breadth: 3, depth: 2, concurrency: 6 },
    },
    { defaultRetriever: "duckduckgo" },
    capabilities,
  );
  const connector = new GptrConnector({
    serviceUrl: "http://127.0.0.1:8010",
    retriever: "duckduckgo",
    researchProfile: requestedProfile,
    researchCapabilities: capabilities,
    taskConcurrencyBudget: 3,
    onResearchEvent: (event) => events.push(event),
  });

  await connector.chat("expert role", "deep research task", {
    provider: "openai",
  });

  assert.equal(receivedBody.researchProfile.deep.concurrency, 3);
  assert.deepEqual(
    events.map((event) => event.type),
    ["research.mode.selected", "research.budget.adjusted"],
  );
  assert.deepEqual(events[1]?.data, {
    capacity: 3,
    requestedWeight: 6,
    effectiveWeight: 3,
  });
});
