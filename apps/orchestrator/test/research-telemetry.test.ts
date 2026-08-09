import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ResearchTelemetryTracker,
  type ResearchRunIdentity,
} from "../src/research-telemetry.js";

const standardRun: ResearchRunIdentity = {
  aoStepId: "market_analysis",
  researchRunId: "research-1",
  mode: "standard",
  queuedAt: "2026-07-29T01:59:59.500Z",
  startedAt: "2026-07-29T02:00:00.000Z",
  queueWaitMs: 500,
};

test("maps raw GPTR events to deduplicated user research phases", () => {
  const tracker = new ResearchTelemetryTracker();

  const preparing = tracker.observe({
    timestamp: "2026-07-29T02:00:00.000Z",
    type: "research.mode.selected",
    data: { effectiveMode: "standard" },
  }, standardRun);
  const duplicate = tracker.observe({
    timestamp: "2026-07-29T02:00:01.000Z",
    type: "starting_research",
    data: {},
  }, standardRun);
  const collecting = tracker.observe({
    timestamp: "2026-07-29T02:00:03.000Z",
    type: "scraping_urls",
    data: { output: "Scraping content from 8 URLs" },
  }, standardRun);

  assert.equal(preparing.publicEvent?.phase, "preparing");
  assert.equal(duplicate.publicEvent, undefined);
  assert.equal(collecting.publicEvent?.phase, "collecting");
  assert.equal(collecting.publicEvent?.aoStepId, "market_analysis");
  assert.equal(collecting.publicEvent?.researchRunId, "research-1");
  assert.equal(collecting.publicEvent?.elapsedMs, 3_000);
  assert.equal(collecting.diagnosticRecord.rawType, "scraping_urls");
});

test("projects safe research activities and counts sources before completion", () => {
  const tracker = new ResearchTelemetryTracker();

  const first = tracker.observe({
    timestamp: "2026-07-29T02:00:01.000Z",
    type: "logs",
    data: {
      content: "added_source_url",
      output:
        "✅ Added source url to research: https://example.com/economy#section",
      metadata: "https://example.com/economy#section",
    },
  }, standardRun);
  const duplicate = tracker.observe({
    timestamp: "2026-07-29T02:00:02.000Z",
    type: "logs",
    data: {
      content: "added_source_url",
      output:
        "✅ Added source url to research: https://example.com/economy",
      metadata: "https://example.com/economy",
    },
  }, standardRun);

  assert.equal(first.activityEvent?.kind, "source");
  assert.equal(
    first.activityEvent?.sourceUrl,
    "https://example.com/economy",
  );
  assert.equal(first.activityEvent?.taskUniqueSourceCount, 1);
  assert.equal(first.activityEvent?.runSourceCount, 1);
  assert.equal(first.activityEvent?.taskActivityCount, 1);
  assert.equal(first.snapshot.summary.uniqueSourceCount, 1);
  assert.equal(first.snapshot.summary.activityCount, 1);
  assert.equal(first.snapshot.runs[0]?.sourceCount, 1);
  assert.equal(duplicate.activityEvent, undefined);
  assert.equal(duplicate.snapshot.summary.uniqueSourceCount, 1);
  assert.equal(duplicate.snapshot.summary.activityCount, 1);
});

test("projects validated specified URLs as live source activities", () => {
  const tracker = new ResearchTelemetryTracker();

  const validating = tracker.observe({
    timestamp: "2026-07-29T02:00:00.000Z",
    type: "source.validation_started",
    data: { sourceCount: 1 },
  }, standardRun);
  const materialized = tracker.observe({
    timestamp: "2026-07-29T02:00:01.000Z",
    type: "source.materialized",
    data: {
      url: "https://example.com/report#section",
      title: "Annual report",
      mediaType: "text/html",
      byteSize: 128,
    },
  }, standardRun);

  assert.equal(
    validating.activityEvent?.message,
    "正在校验并读取 1 个指定来源。",
  );
  assert.equal(materialized.activityEvent?.kind, "source");
  assert.equal(
    materialized.activityEvent?.message,
    "已读取指定来源：example.com",
  );
  assert.equal(
    materialized.activityEvent?.sourceUrl,
    "https://example.com/report",
  );
  assert.equal(materialized.snapshot.summary.uniqueSourceCount, 1);
});

test("keeps internal prompts out of public research activities", () => {
  const tracker = new ResearchTelemetryTracker();
  const update = tracker.observe({
    timestamp: "2026-07-29T02:00:01.000Z",
    type: "logs",
    data: {
      content: "subqueries",
      output: [
        "queries: ['safe public query']",
        "<expert_system_prompt>private role</expert_system_prompt>",
        "<task>private task</task>",
      ].join("\n"),
    },
  }, standardRun);

  assert.equal(update.activityEvent?.kind, "planning");
  assert.equal(update.activityEvent?.message, "已生成本轮子问题与检索查询。");
  assert.doesNotMatch(
    update.activityEvent?.message ?? "",
    /private role|private task/u,
  );

  const unknown = tracker.observe({
    timestamp: "2026-07-29T02:00:02.000Z",
    type: "raw_model_context",
    data: { output: "private model context" },
  }, standardRun);
  assert.equal(unknown.activityEvent, undefined);
});

test("projects retriever configuration and bounded degradation in Chinese", () => {
  const tracker = new ResearchTelemetryTracker();
  const configured = tracker.observe({
    timestamp: "2026-07-29T02:00:01.000Z",
    type: "retriever.configured",
    data: {
      retrievers: ["duckduckgo", "openalex"],
      timeoutMs: 20_000,
      maxResultsPerQuery: 8,
    },
  }, standardRun);
  const degraded = tracker.observe({
    timestamp: "2026-07-29T02:00:02.000Z",
    type: "retriever.degraded",
    data: {
      retriever: "openalex",
      status: "timed_out",
      attempts: 2,
    },
  }, standardRun);
  const querying = tracker.observe({
    timestamp: "2026-07-29T02:00:01.500Z",
    type: "retriever.query_started",
    data: { retriever: "duckduckgo", attempt: 1 },
  }, standardRun);
  const duplicateQuerying = tracker.observe({
    timestamp: "2026-07-29T02:00:01.750Z",
    type: "retriever.query_started",
    data: { retriever: "duckduckgo", attempt: 2 },
  }, standardRun);
  const summary = tracker.observe({
    timestamp: "2026-07-29T02:00:03.000Z",
    type: "retriever.summary",
    data: {
      configured: ["duckduckgo", "openalex"],
      accepted: 7,
      duplicates: 2,
      domainRejected: 1,
    },
  }, standardRun);

  assert.equal(configured.publicEvent?.phase, "searching");
  assert.equal(
    configured.activityEvent?.message,
    "已启用 2 个检索器：DuckDuckGo、OpenAlex。",
  );
  assert.equal(
    degraded.activityEvent?.message,
    "OpenAlex 检索超时，本轮已使用其他来源继续研究。",
  );
  assert.equal(
    querying.activityEvent?.message,
    "DuckDuckGo 正在查询相关资料。",
  );
  assert.equal(duplicateQuerying.activityEvent, undefined);
  assert.equal(
    summary.activityEvent?.message,
    "检索完成：保留 7 条结果，去除 2 条重复结果，按域名规则排除 1 条。",
  );
});

/* test("projects bounded managed MCP activity without private configuration", () => {
  const tracker = new ResearchTelemetryTracker();
  const configured = tracker.observe({
    timestamp: "2026-07-29T02:00:01.000Z",
    type: "mcp.configured",
    data: {
      profiles: ["policy-library"],
      strategy: "fast",
      webEnabled: true,
    },
  }, standardRun);
  const started = tracker.observe({
    timestamp: "2026-07-29T02:00:02.000Z",
    type: "mcp.tool.started",
    data: {
      profileId: "policy-library",
      tool: "search_policy",
      callId: "call_01",
    },
  }, standardRun);
  const completed = tracker.observe({
    timestamp: "2026-07-29T02:00:03.000Z",
    type: "mcp.tool.completed",
    data: {
      profileId: "policy-library",
      tool: "search_policy",
      callId: "call_01",
      characters: 100_000,
      truncated: true,
    },
  }, standardRun);
  const summary = tracker.observe({
    timestamp: "2026-07-29T02:00:04.000Z",
    type: "mcp.summary",
    data: {
      configured: ["policy-library"],
      calls: 1,
      accepted: 1,
      failed: 0,
      timedOut: 0,
      truncated: 1,
    },
  }, standardRun);

  assert.equal(configured.publicEvent?.phase, "searching");
  assert.equal(
    configured.activityEvent?.message,
    "已配置 1 个受管 MCP 来源，采用只读 fast 策略并保留 Web 补充。",
  );
  assert.equal(
    started.activityEvent?.message,
    "正在调用受管 MCP 工具：search_policy。",
  );
  assert.equal(
    completed.activityEvent?.message,
    "已接收 search_policy 的受管 MCP 证据，输出已按上限截断。",
  );
  assert.equal(summary.snapshot.runs[0]?.phase, "collecting");
  assert.equal(
    summary.activityEvent?.message,
    "受管 MCP 完成：调用 1 次，保留 1 条证据，失败 0 次，其中超时 0 次。",
  );
  const publicText = [configured, started, completed, summary]
    .map((item) => item.activityEvent?.message)
    .join(" ");
  assert.doesNotMatch(
    publicText,
    /authorization|internal\.example|private-secret|call_01/u,
  );
}); */

test("completes a research run with exact sources, elapsed time, and GPTR cost", () => {
  const tracker = new ResearchTelemetryTracker();
  tracker.observe({
    timestamp: "2026-07-29T02:00:01.000Z",
    type: "searching",
    data: {},
  }, standardRun);

  const completed = tracker.complete({
    timestamp: "2026-07-29T02:02:30.000Z",
    sourceUrls: [
      "https://example.com/a",
      "https://example.com/a",
      "https://example.org/b",
    ],
    cost: 0,
  }, standardRun);

  assert.equal(completed.publicEvent.phase, "completed");
  assert.equal(completed.publicEvent.state, "completed");
  assert.equal(completed.publicEvent.elapsedMs, 150_000);
  assert.equal(completed.publicEvent.sourceCount, 2);
  assert.deepEqual(completed.publicEvent.cost, {
    status: "reported",
    currency: "USD",
    amount: 0,
    provenance: "gptr",
    estimated: true,
  });
  assert.deepEqual(completed.snapshot.summary, {
    runCount: 1,
    completedRunCount: 1,
    uniqueSourceCount: 2,
    activityCount: 1,
    reportedCostUsd: 0,
    reportedCostRuns: 1,
    totalElapsedMs: 150_000,
  });
});

test("emits meaningful deep progress changes without inventing a percentage", () => {
  const tracker = new ResearchTelemetryTracker();
  const deepRun: ResearchRunIdentity = {
    ...standardRun,
    researchRunId: "research-deep",
    mode: "deep",
  };

  const first = tracker.observe({
    timestamp: "2026-07-29T02:00:05.000Z",
    type: "deep_research.progress",
    data: {
      currentLevel: 2,
      totalLevels: 3,
      completedQueries: 1,
      totalQueries: 4,
      currentBreadth: 1,
      totalBreadth: 4,
    },
  }, deepRun);
  const advanced = tracker.observe({
    timestamp: "2026-07-29T02:00:10.000Z",
    type: "deep_research.progress",
    data: {
      currentLevel: 2,
      totalLevels: 3,
      completedQueries: 2,
      totalQueries: 4,
      currentBreadth: 2,
      totalBreadth: 4,
    },
  }, deepRun);

  assert.deepEqual(first.publicEvent?.deep, {
    currentLevel: 2,
    totalLevels: 3,
    completedQueries: 1,
    totalQueries: 4,
    currentBranch: 1,
    totalBranches: 4,
  });
  assert.deepEqual(advanced.publicEvent?.deep, {
    currentLevel: 2,
    totalLevels: 3,
    completedQueries: 2,
    totalQueries: 4,
    currentBranch: 2,
    totalBranches: 4,
  });
  assert.equal(
    Object.hasOwn(advanced.publicEvent ?? {}, "percentage"),
    false,
  );

  const completed = tracker.complete({
    timestamp: "2026-07-29T02:00:20.000Z",
    sourceUrls: [],
    cost: null,
  }, deepRun);
  assert.deepEqual(completed.publicEvent.deep, advanced.publicEvent?.deep);
});

test("bounds and redacts diagnostic event data", () => {
  const tracker = new ResearchTelemetryTracker();
  const update = tracker.observe({
    timestamp: "2026-07-29T02:00:01.000Z",
    type: "logs",
    data: {
      apiKey: "secret-key",
      authorization: "Bearer secret",
      output: "x".repeat(5_000),
      message: [
        "<expert_system_prompt>private instructions</expert_system_prompt>",
        "可保留的诊断信息",
      ].join("\n"),
    },
  }, standardRun);

  assert.equal(update.diagnosticRecord.data.apiKey, "[REDACTED]");
  assert.equal(update.diagnosticRecord.data.authorization, "[REDACTED]");
  assert.equal(
    String(update.diagnosticRecord.data.output).length,
    4_096,
  );
  assert.doesNotMatch(
    String(update.diagnosticRecord.data.message),
    /private instructions/u,
  );
  assert.match(
    String(update.diagnosticRecord.data.message),
    /可保留的诊断信息/u,
  );
  assert.equal(update.diagnosticRecord.truncated, true);
});

test("closes failed and canceled research runs without exposing error details", () => {
  for (const [state, phase] of [
    ["failed", "failed"],
    ["canceled", "canceled"],
  ] as const) {
    const tracker = new ResearchTelemetryTracker();
    const result = tracker.fail({
      timestamp: "2026-07-29T02:00:10.000Z",
      state,
      error: new Error("provider secret detail"),
    }, standardRun);

    assert.equal(result.publicEvent.state, state);
    assert.equal(result.publicEvent.phase, phase);
    assert.equal(result.publicEvent.elapsedMs, 10_000);
    assert.deepEqual(result.diagnosticRecord.data, {
      errorName: "Error",
    });
  }
});
