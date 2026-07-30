import assert from "node:assert/strict";
import { test } from "node:test";

import { ResearchTaskManager } from "../src/research-tasks.js";
import {
  resolveResearchProfile,
  type ResearchCapabilities,
} from "../src/research-profile.js";
import type { EvidenceBundle } from "../src/evidence-bundle.js";
import { InMemoryResearchTaskStore } from "../src/research-task-store.js";
import type {
  ResearchActivity,
  ResearchRunProgress,
  ResearchTelemetrySnapshot,
} from "../src/research-telemetry.js";

const evidenceBundle: EvidenceBundle = {
  schemaVersion: 1,
  aoStepId: "market_analysis",
  researchRunId: "research-1",
  attempt: 1,
  mode: "standard",
  startedAt: "2026-07-29T10:00:00.000Z",
  completedAt: "2026-07-29T10:02:00.000Z",
  derivedFromStepIds: [],
  queries: [{
    id: "query-1",
    kind: "subquery",
    text: "2026 AI market",
  }],
  sources: [{
    id: "source-1",
    visibility: "public",
    url: "https://example.com/market",
    title: "Market evidence",
    observedAt: "2026-07-29T10:02:00.000Z",
  }],
  researchContext: {
    content: "bounded evidence",
    originalCharacters: 16,
    truncated: false,
  },
  method: {
    sourceMode: "web",
    retrievers: ["duckduckgo"],
  },
  report: {
    format: "markdown",
    content: "# Market report",
    revision: 1,
  },
  cost: 0.1,
};

test("queues a research task and preserves its event history", async () => {
  const manager = new ResearchTaskManager(async (_topic, onEvent) => {
    onEvent({
      type: "workflow.composed",
      timestamp: new Date().toISOString(),
      workflowPath: "workflow.yaml",
      warnings: [],
    });
    onEvent({
      type: "step.started",
      timestamp: new Date().toISOString(),
      stepId: "research",
      status: "running",
    });
    return {
      workflowPath: "workflow.yaml",
      output: "# report",
      workflow: {
        name: "test",
        success: true,
        steps: [],
        totalDuration: 1,
        totalTokens: { input: 0, output: 0 },
      },
    };
  });

  const submitted = manager.submit(" research topic ");
  assert.equal(submitted.status, "queued");
  assert.equal(submitted.topic, "research topic");

  await waitFor(() => manager.get(submitted.id)?.status === "completed");
  const completed = manager.get(submitted.id);
  assert.equal(completed?.output, "# report");
  assert.equal(completed?.workflowPath, "workflow.yaml");

  const events: string[] = [];
  manager.subscribe(submitted.id, (event) => events.push(event.type));
  assert.deepEqual(events, [
    "task.queued",
    "task.running",
    "workflow.composed",
    "step.started",
    "task.completed",
  ]);
});

test("persists full evidence bundles without flooding observable events", async () => {
  const manager = new ResearchTaskManager(async (_topic, onEvent) => {
    onEvent({
      type: "evidence.bundle.recorded",
      timestamp: new Date().toISOString(),
      bundle: evidenceBundle,
    });
    return {
      workflowPath: "workflow.yaml",
      output: "# report",
      evidenceBundles: [evidenceBundle],
      workflow: {
        name: "test",
        success: true,
        steps: [],
        totalDuration: 1,
        totalTokens: { input: 0, output: 0 },
      },
    };
  });

  const submitted = manager.submit("evidence topic");
  await waitFor(() => manager.get(submitted.id)?.status === "completed");

  assert.deepEqual(
    manager.get(submitted.id)?.evidenceBundles,
    [evidenceBundle],
  );
  const evidenceEvents: Array<Record<string, unknown>> = [];
  manager.subscribe(submitted.id, (event) => {
    if (event.type === "evidence.bundle.recorded") {
      evidenceEvents.push(event.data);
    }
  });
  assert.deepEqual(evidenceEvents, [{
    aoStepId: "market_analysis",
    researchRunId: "research-1",
    attempt: 1,
    mode: "standard",
    queryCount: 1,
    sourceCount: 1,
  }]);
});

test("persists structured research progress while keeping diagnostics private", async () => {
  const store = new InMemoryResearchTaskStore();
  const progress: ResearchRunProgress = {
    schemaVersion: 1,
    aoStepId: "market_analysis",
    researchRunId: "research-1",
    mode: "deep",
    state: "running",
    phase: "analyzing",
    startedAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:20.000Z",
    queueWaitMs: 0,
    elapsedMs: 20_000,
    sourceCount: 0,
    deep: {
      currentLevel: 1,
      totalLevels: 2,
      completedQueries: 2,
      totalQueries: 3,
      currentBranch: 2,
      totalBranches: 3,
    },
    cost: {
      status: "unavailable",
      currency: "USD",
      provenance: "gptr",
      estimated: true,
    },
  };
  const telemetry: ResearchTelemetrySnapshot = {
    schemaVersion: 1,
    runs: [progress],
    summary: {
      runCount: 1,
      completedRunCount: 0,
      uniqueSourceCount: 0,
      reportedCostUsd: 0,
      reportedCostRuns: 0,
      totalElapsedMs: 20_000,
    },
  };
  const manager = new ResearchTaskManager(
    async (_topic, onEvent) => {
      onEvent({
        type: "research.diagnostic",
        timestamp: progress.updatedAt,
        diagnostic: {
          timestamp: progress.updatedAt,
          aoStepId: progress.aoStepId,
          researchRunId: progress.researchRunId,
          rawType: "deep_research.progress",
          rawStage: "deep_research.progress",
          data: { completedQueries: 2 },
          truncated: false,
        },
      });
      onEvent({
        type: "research.progress",
        timestamp: progress.updatedAt,
        progress,
        telemetry,
      });
      return {
        workflowPath: "workflow.yaml",
        output: "# report",
        researchTelemetry: telemetry,
        workflow: {
          name: "test",
          success: true,
          steps: [],
          totalDuration: 1,
          totalTokens: { input: 0, output: 0 },
        },
      };
    },
    store,
  );

  const submitted = manager.submit("structured progress");
  await waitFor(() => manager.get(submitted.id)?.status === "completed");

  assert.deepEqual(manager.get(submitted.id)?.researchTelemetry, telemetry);
  assert.equal(store.loadDiagnostics(submitted.id).length, 1);
  const publicTypes: string[] = [];
  manager.subscribe(submitted.id, (event) => publicTypes.push(event.type));
  assert.deepEqual(publicTypes, [
    "task.queued",
    "task.running",
    "research.progress",
    "task.completed",
  ]);
});

test("persists safe research activities with live telemetry for SSE replay", async () => {
  const activity: ResearchActivity = {
    schemaVersion: 1,
    aoStepId: "market_analysis",
    researchRunId: "research-1",
    sequence: 1,
    timestamp: "2026-07-29T10:00:05.000Z",
    phase: "collecting",
    kind: "source",
    message: "已收集来源：example.com",
    sourceUrl: "https://example.com/market",
    runSourceCount: 1,
    taskUniqueSourceCount: 1,
    taskActivityCount: 1,
  };
  const telemetry: ResearchTelemetrySnapshot = {
    schemaVersion: 1,
    runs: [],
    summary: {
      runCount: 1,
      completedRunCount: 0,
      uniqueSourceCount: 1,
      activityCount: 1,
      reportedCostUsd: 0,
      reportedCostRuns: 0,
      totalElapsedMs: 5_000,
    },
  };
  const manager = new ResearchTaskManager(async (_topic, onEvent) => {
    onEvent({
      type: "research.activity",
      timestamp: activity.timestamp,
      activity,
      telemetry,
    });
    return {
      workflowPath: "workflow.yaml",
      output: "# report",
      researchTelemetry: telemetry,
      workflow: {
        name: "test",
        success: true,
        steps: [],
        totalDuration: 1,
        totalTokens: { input: 0, output: 0 },
      },
    };
  });

  const submitted = manager.submit("observable activity");
  await waitFor(() => manager.get(submitted.id)?.status === "completed");

  assert.equal(
    manager.get(submitted.id)?.researchTelemetry?.summary.uniqueSourceCount,
    1,
  );
  const activities: Array<Record<string, unknown>> = [];
  manager.subscribe(submitted.id, (event) => {
    if (event.type === "research.activity") activities.push(event.data);
  });
  assert.deepEqual(activities, [activity]);
});

test("retains completed evidence when a later workflow step fails", async () => {
  const manager = new ResearchTaskManager(async (_topic, onEvent) => {
    onEvent({
      type: "evidence.bundle.recorded",
      timestamp: new Date().toISOString(),
      bundle: evidenceBundle,
    });
    throw new Error("later AO step failed");
  });

  const submitted = manager.submit("partially completed research");
  await waitFor(() => manager.get(submitted.id)?.status === "failed");

  const failed = manager.get(submitted.id);
  assert.equal(failed?.error, "later AO step failed");
  assert.deepEqual(failed?.evidenceBundles, [evidenceBundle]);
});

test("freezes the submitted research policy in the task snapshot", async () => {
  const capabilities: ResearchCapabilities = {
    modes: ["standard"],
    sourceModes: ["web"],
    retrievers: ["duckduckgo"],
    maxRetrievers: 1,
    sourceCuration: false,
    domainFilters: false,
  };
  const profile = resolveResearchProfile(
    { limits: { maxIterations: 6 } },
    { defaultRetriever: "duckduckgo" },
    capabilities,
  );
  let receivedIterations = 0;
  const manager = new ResearchTaskManager(
    async (_topic, _onEvent, controls) => {
      receivedIterations =
        controls.researchProfile?.limits.maxIterations ?? 0;
      return {
        workflowPath: "workflow.yaml",
        output: "# report",
        workflow: {
          name: "test",
          success: true,
          steps: [],
          totalDuration: 1,
          totalTokens: { input: 0, output: 0 },
        },
      };
    },
  );

  const submitted = manager.submit("profiled topic", {
    researchProfile: profile,
    researchCapabilities: capabilities,
  });
  assert.deepEqual(submitted.researchProfile, profile);
  assert.deepEqual(submitted.researchCapabilities, capabilities);

  await waitFor(() => manager.get(submitted.id)?.status === "completed");
  assert.equal(receivedIterations, 6);
});

test("replays only events after the subscriber cursor", async () => {
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# report",
    workflow: {
      name: "test",
      success: true,
      steps: [],
      totalDuration: 1,
      totalTokens: { input: 0, output: 0 },
    },
  }));

  const submitted = manager.submit("recoverable topic");
  await waitFor(() => manager.get(submitted.id)?.status === "completed");

  const events: Array<{ id: number; type: string }> = [];
  manager.subscribe(
    submitted.id,
    (event) => events.push({ id: event.id, type: event.type }),
    2,
  );

  assert.deepEqual(events, [{
    id: 3,
    type: "task.completed",
  }]);
});

test("localizes persisted GPTR progress while replaying events", async () => {
  const manager = new ResearchTaskManager(async (_topic, onEvent) => {
    onEvent({
      type: "gptr.progress",
      timestamp: new Date().toISOString(),
      researchId: "research-1",
      stage: "scraping_images",
      message: "Selected 4 new images from 40 total images",
    });
    return {
      workflowPath: "workflow.yaml",
      output: "# report",
      workflow: {
        name: "test",
        success: true,
        steps: [],
        totalDuration: 1,
        totalTokens: { input: 0, output: 0 },
      },
    };
  });

  const submitted = manager.submit("localized history");
  await waitFor(() => manager.get(submitted.id)?.status === "completed");

  const messages: string[] = [];
  manager.subscribe(submitted.id, (event) => {
    if (
      event.type === "gptr.progress" &&
      typeof event.data.message === "string"
    ) {
      messages.push(event.data.message);
    }
  });

  assert.deepEqual(messages, ["已从 40 张候选图片中选出 4 张。"]);
});

test("pauses for AO input and resumes with the submitted answer", async () => {
  let receivedAnswer = "";
  const manager = new ResearchTaskManager(
    async (_topic, _onEvent, controls) => {
      receivedAnswer = await controls.requestInput({
        stepId: "clarify_scope",
        kind: "human_input",
        prompt: "请补充研究地域范围。",
      });
      return {
        workflowPath: "workflow.yaml",
        output: `# ${receivedAnswer}`,
        workflow: {
          name: "test",
          success: true,
          steps: [],
          totalDuration: 1,
          totalTokens: { input: 0, output: 0 },
        },
      };
    },
  );

  const submitted = manager.submit("research topic");
  await waitFor(() => manager.get(submitted.id)?.status === "needs_input");
  assert.deepEqual(manager.get(submitted.id)?.pendingInput, {
    stepId: "clarify_scope",
    kind: "human_input",
    prompt: "请补充研究地域范围。",
  });

  assert.equal(
    manager.answerInput(submitted.id, "仅研究中国市场"),
    true,
  );
  await waitFor(() => manager.get(submitted.id)?.status === "completed");
  assert.equal(receivedAnswer, "仅研究中国市场");
  assert.equal(manager.get(submitted.id)?.pendingInput, undefined);

  const events: string[] = [];
  manager.subscribe(submitted.id, (event) => events.push(event.type));
  assert.ok(events.includes("task.needs_input"));
  assert.ok(events.includes("task.input_received"));
});

test("serializes submitted research tasks", async () => {
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];
  const manager = new ResearchTaskManager(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return {
      workflowPath: "workflow.yaml",
      output: "done",
      workflow: {
        name: "test",
        success: true,
        steps: [],
        totalDuration: 1,
        totalTokens: { input: 0, output: 0 },
      },
    };
  });

  const first = manager.submit("first");
  const second = manager.submit("second");
  await waitFor(() => manager.get(first.id)?.status === "running");
  assert.equal(manager.get(second.id)?.status, "queued");
  releases.shift()?.();
  await waitFor(() => manager.get(second.id)?.status === "running");
  releases.shift()?.();
  await waitFor(() => manager.get(second.id)?.status === "completed");
  assert.equal(maxActive, 1);
});

test("delivers the report with warnings when AO acceptance does not pass", async () => {
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# useful report",
    workflow: {
      name: "test",
      success: true,
      steps: [{
        id: "final",
        role: "research/writer",
        status: "completed",
        output: "# useful report",
        acceptance: "Include evidence.",
        duration: 1,
        tokens: { input: 0, output: 0 },
        verification: {
          pass: false,
          failed: ["Include evidence. (One citation is missing.)"],
          reworked: true,
        },
      }],
      totalDuration: 1,
      totalTokens: { input: 0, output: 0 },
    },
  }));

  const submitted = manager.submit("topic");
  await waitFor(
    () => manager.get(submitted.id)?.status === "completed_with_warnings",
  );

  const task = manager.get(submitted.id);
  assert.equal(task?.output, "# useful report");
  assert.deepEqual(task?.contentAcceptance, {
    status: "warning",
    warnings: ["final: Include evidence. (One citation is missing.)"],
  });
  assert.deepEqual(task?.warnings, [
    "final: Include evidence. (One citation is missing.)",
  ]);
});

test("delivers evidence-quality warnings separately from content acceptance", async () => {
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# useful report",
    evidenceQuality: {
      schemaVersion: 1,
      status: "warning",
      metrics: {
        citationCoverage: {
          citedClaimParagraphs: 1,
          totalClaimParagraphs: 4,
          ratio: 0.25,
          target: 0.8,
        },
        validLinkRate: {
          verifiedLinks: 1,
          totalLinks: 1,
          ratio: 1,
          target: 1,
        },
        sourceDeduplication: {
          observedPublicSources: 1,
          uniquePublicSources: 1,
          duplicateSources: 0,
          duplicateRatio: 0,
        },
        domainDiversity: {
          uniqueDomains: 1,
          uniquePublicSources: 1,
          ratio: 1,
        },
        sourceTypes: {
          government: 0,
          academic: 0,
          organization: 0,
          commercial: 1,
          other: 0,
        },
      },
      warnings: [{
        code: "citation_coverage_low",
        message: "证据质量：含数据段落的已验证引用覆盖率为 25%，低于 80%。",
      }],
    },
    workflow: {
      name: "test",
      success: true,
      steps: [],
      totalDuration: 1,
      totalTokens: { input: 0, output: 0 },
    },
  }));

  const submitted = manager.submit("topic");
  await waitFor(
    () => manager.get(submitted.id)?.status === "completed_with_warnings",
  );

  const task = manager.get(submitted.id);
  assert.deepEqual(task?.contentAcceptance, {
    status: "passed",
    warnings: [],
  });
  assert.equal(task?.evidenceQuality?.status, "warning");
  assert.deepEqual(task?.warnings, [
    "证据质量：含数据段落的已验证引用覆盖率为 25%，低于 80%。",
  ]);
});

test("cancels a running task through the runner abort signal", async () => {
  const manager = new ResearchTaskManager(
    async (_topic, _onEvent, controls) => {
      await new Promise<void>((_resolve, reject) => {
        controls.signal.addEventListener(
          "abort",
          () => reject(controls.signal.reason),
          { once: true },
        );
      });
      throw new Error("unreachable");
    },
  );

  const submitted = manager.submit("cancel this research");
  await waitFor(() => manager.get(submitted.id)?.status === "running");
  assert.equal(manager.cancel(submitted.id), true);
  assert.equal(manager.get(submitted.id)?.status, "canceling");
  await waitFor(() => manager.get(submitted.id)?.status === "canceled");

  const events: string[] = [];
  manager.subscribe(submitted.id, (event) => events.push(event.type));
  assert.deepEqual(events.slice(-2), ["task.canceling", "task.canceled"]);
});

test("cancels a task while AO is waiting for user input", async () => {
  const manager = new ResearchTaskManager(
    async (_topic, _onEvent, controls) => {
      await controls.requestInput({
        stepId: "clarify",
        kind: "human_input",
        prompt: "请补充范围",
      });
      throw new Error("unreachable");
    },
  );

  const submitted = manager.submit("cancel pending input");
  await waitFor(() => manager.get(submitted.id)?.status === "needs_input");
  assert.equal(manager.cancel(submitted.id), true);
  await waitFor(() => manager.get(submitted.id)?.status === "canceled");
});

test("fails a task when its active execution budget is exhausted", async () => {
  const manager = new ResearchTaskManager(
    async (_topic, _onEvent, controls) => {
      await new Promise<void>((_resolve, reject) => {
        controls.signal.addEventListener(
          "abort",
          () => reject(controls.signal.reason),
          { once: true },
        );
      });
      throw new Error("unreachable");
    },
    undefined,
    { executionTimeoutMs: 20 },
  );

  const submitted = manager.submit("timeout research");
  await waitFor(() => manager.get(submitted.id)?.status === "failed");
  assert.match(manager.get(submitted.id)?.error ?? "", /执行超时/u);
});

test("does not consume the execution budget while waiting for user input", async () => {
  const manager = new ResearchTaskManager(
    async (_topic, _onEvent, controls) => {
      const answer = await controls.requestInput({
        stepId: "scope",
        kind: "human_input",
        prompt: "请补充范围",
      });
      return {
        workflowPath: "workflow.yaml",
        output: answer,
        workflow: {
          name: "test",
          success: true,
          steps: [],
          totalDuration: 1,
          totalTokens: { input: 0, output: 0 },
        },
      };
    },
    undefined,
    { executionTimeoutMs: 30 },
  );

  const submitted = manager.submit("wait for input");
  await waitFor(() => manager.get(submitted.id)?.status === "needs_input");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(manager.get(submitted.id)?.status, "needs_input");
  assert.equal(manager.answerInput(submitted.id, "中国市场"), true);
  await waitFor(() => manager.get(submitted.id)?.status === "completed");
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}
