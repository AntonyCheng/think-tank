import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createApiServer } from "../src/api-server.js";
import {
  ResearchTaskManager,
  type ResearchTaskSnapshot,
} from "../src/research-tasks.js";
import { InMemoryResearchTaskStore } from "../src/research-task-store.js";
import { InMemoryReportDocumentStore } from "../src/report-document-store.js";
import {
  InMemoryReportEditorStore,
  ReportEditorService,
} from "../src/report-editor.js";
import { RuntimeSettingsStore } from "../src/settings-store.js";
import type {
  ResearchCapabilityProvider,
  RetrieverCatalog,
} from "../src/gptr-capabilities.js";
import type { WorkflowCheckpoint } from "../src/workflow-checkpoint.js";
import type { SettingsPreflightCheck } from "../src/settings-preflight.js";
import type { ResearchTopicRecommendationProvider } from "../src/research-topic-recommendations.js";

const readyRetrieverCatalog: RetrieverCatalog = Object.freeze({
  schemaVersion: 1,
  retrievers: Object.freeze([
    Object.freeze({
      id: "duckduckgo",
      label: "DuckDuckGo",
      category: "web",
      selectable: true,
      credentialRequired: false,
      timeoutMs: 20_000,
    }),
    Object.freeze({
      id: "openalex",
      label: "OpenAlex",
      category: "academic",
      selectable: true,
      credentialRequired: false,
      timeoutMs: 20_000,
    }),
  ]),
  maxRetrievers: 2,
});
const readyCapabilityProvider: ResearchCapabilityProvider = {
  async getCatalog() {
    return readyRetrieverCatalog;
  },
};
const passingSettingsPreflight = async (): Promise<SettingsPreflightCheck[]> => [
  { id: "model", label: "模型", status: "passed" },
  { id: "embedding", label: "Embedding 模型", status: "passed" },
  { id: "retriever", label: "DuckDuckGo 网页搜索", status: "passed" },
];

test("returns only public research topic recommendation fields", async (t) => {
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# report",
    workflow: { name: "test", success: true, steps: [], totalDuration: 1, totalTokens: { input: 0, output: 0 } },
  }));
  const topicRecommendations: ResearchTopicRecommendationProvider = {
    async get() {
      return {
        items: [{
          id: "topic-public",
          category: "产业趋势",
          title: "人工智能产业发展与区域竞争格局研究",
          summary: "关注产业规模、区域布局、应用场景和政策环境。",
          sources: [{
            title: "人工智能产业发展观察",
            url: "https://example.com/ai-industry",
            domain: "example.com",
          }],
        }],
        updatedAt: "2026-08-13T00:00:00.000Z",
        nextRefreshAt: "2026-08-13T03:00:00.000Z",
        source: "generated",
        refreshing: false,
      };
    },
  };
  const server = createApiServer(
    manager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    topicRecommendations,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const response = await fetch(
    `http://127.0.0.1:${port}/api/recommendations/research-topics`,
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), [
    "items",
    "nextRefreshAt",
    "refreshing",
    "source",
    "updatedAt",
  ]);
  assert.deepEqual(Object.keys((payload.items as Array<Record<string, unknown>>)[0] ?? {}).sort(), [
    "category",
    "id",
    "sources",
    "summary",
    "title",
  ]);
  assert.deepEqual(
    Object.keys(
      ((payload.items as Array<Record<string, unknown>>)[0]?.sources as Array<Record<string, unknown>>)[0] ?? {},
    ).sort(),
    ["domain", "title", "url"],
  );
});

test("lists the Chinese AO agent directory with only presentation metadata", async (t) => {
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# report",
    workflow: { name: "test", success: true, steps: [], totalDuration: 1, totalTokens: { input: 0, output: 0 } },
  }));
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const response = await fetch(`http://127.0.0.1:${port}/api/agents`);
  assert.equal(response.status, 200);
  const payload = await response.json() as { agents: Array<Record<string, unknown>> };
  assert.equal(payload.agents.length, 267);
  assert.deepEqual(Object.keys(payload.agents[0] ?? {}).sort(), ["emoji", "id", "name"]);
  assert.ok(payload.agents.every((agent) => typeof agent.name === "string" && agent.name.length > 0));
  assert.ok(payload.agents.every((agent) => typeof agent.emoji === "string" && agent.emoji.length > 0));
});

test("returns redacted failure diagnostics without exposing raw diagnostic data", async (t) => {
  const manager = new ResearchTaskManager(async (_topic, onEvent) => {
    const timestamp = new Date().toISOString();
    onEvent({
      type: "research.diagnostic",
      timestamp,
      diagnostic: {
        timestamp,
        aoStepId: "workflow_composition",
        researchRunId: "workflow-composition",
        rawType: "workflow.response_extraction",
        rawStage: "response_extraction",
        data: { message: "authorization: hidden-token" },
        truncated: false,
      },
    });
    throw new Error("workflow composition failed");
  });
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: "diagnostic test" }),
  });
  const task = await created.json() as { id: string };
  await waitFor(async () => (await fetch(`${baseUrl}/api/tasks/${task.id}`)).json().then((value: { status: string }) => value.status === "failed"));

  const response = await fetch(`${baseUrl}/api/tasks/${task.id}/diagnostics`);
  assert.equal(response.status, 200);
  const payload = await response.json() as { diagnostics: Array<Record<string, unknown>> };
  assert.equal(payload.diagnostics.length, 1);
  assert.deepEqual(Object.keys(payload.diagnostics[0] ?? {}).sort(), ["id", "message", "stage", "timestamp"]);
  assert.equal(payload.diagnostics[0]?.message, "authorization: [redacted]");
});

test("returns a completed expert report with public sources only", async (t) => {
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# report",
    workflow: { name: "test", success: true, steps: [], totalDuration: 1, totalTokens: { input: 0, output: 0 } },
    evidenceBundles: [{
      schemaVersion: 1,
      aoStepId: "industry_expert",
      researchRunId: "run-1",
      attempt: 1,
      mode: "standard",
      startedAt: "2026-08-18T00:00:00.000Z",
      completedAt: "2026-08-18T00:01:00.000Z",
      derivedFromStepIds: [],
      queries: [],
      sources: [
        { id: "public-source", visibility: "public", title: "公开资料", url: "https://example.com/public", sourceType: "web", observedAt: "2026-08-18T00:00:30.000Z" },
        { id: "private-source", visibility: "private", title: "内部文档", locator: "document-1", sourceType: "document", observedAt: "2026-08-18T00:00:30.000Z" },
      ],
      researchContext: { content: "private context", originalCharacters: 15, truncated: false },
      method: { sourceMode: "web", retrievers: ["duckduckgo"] },
      report: { format: "markdown", content: "# 专家结论", revision: 1 },
      cost: null,
    }],
  }));
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const task = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: "expert result" }),
  }).then((response) => response.json()) as { id: string };
  await waitFor(async () => (await fetch(`${baseUrl}/api/tasks/${task.id}`))
    .json().then((value: { status: string }) => value.status === "completed"));

  const response = await fetch(`${baseUrl}/api/tasks/${task.id}/experts/industry_expert`);
  assert.equal(response.status, 200);
  const payload = await response.json() as Record<string, unknown>;
  assert.equal((payload.report as { content: string }).content, "# 专家结论");
  assert.deepEqual(payload.sources, [{
    title: "公开资料",
    visibility: "public",
    url: "https://example.com/public",
  }]);
  assert.equal("researchContext" in payload, false);

  const workspace = await fetch(`${baseUrl}/api/tasks/${task.id}/workspace`);
  assert.equal(workspace.status, 200);
  const bootstrap = await workspace.json() as {
    snapshot: { id: string; status: string };
    events: Array<{ type: string }>;
    expertResults: Array<Record<string, unknown>>;
  };
  assert.equal(bootstrap.snapshot.id, task.id);
  assert.equal(bootstrap.snapshot.status, "completed");
  assert.ok(bootstrap.events.some((event) => event.type === "task.completed"));
  assert.equal((bootstrap.expertResults[0]?.report as { content: string }).content, "# 专家结论");
  assert.equal("researchContext" in (bootstrap.expertResults[0] ?? {}), false);
});

test("restarts a failed task as a new research session", async (t) => {
  let runs = 0;
  const manager = new ResearchTaskManager(async () => {
    runs += 1;
    throw new Error("workflow composition failed");
  });
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: "retry the failed workflow" }),
  }).then((response) => response.json()) as { id: string };
  await waitFor(async () => (await fetch(`${baseUrl}/api/tasks/${created.id}`))
    .json().then((task: { status: string }) => task.status === "failed"));

  const response = await fetch(`${baseUrl}/api/tasks/${created.id}/retry`, {
    method: "POST",
  });
  assert.equal(response.status, 202);
  const retry = await response.json() as { id: string; topic: string };
  assert.notEqual(retry.id, created.id);
  assert.equal(retry.topic, "retry the failed workflow");
  await waitFor(async () => runs >= 2);
});

test("continues a failed expert in the same research session", async (t) => {
  const store = new InMemoryResearchTaskStore();
  const snapshot: ResearchTaskSnapshot = {
    id: "failed-expert-task",
    topic: "continue failed expert",
    status: "failed",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    workflowPlan: {
      schemaVersion: 1,
      workflowName: "test",
      steps: [
        { id: "completed", name: "Completed expert", role: "research/analyst", task: "Research.", type: "expert", dependsOn: [], terminal: false },
        { id: "failed", name: "Failed expert", role: "research/analyst", task: "Research.", type: "expert", dependsOn: [], terminal: false },
        { id: "final", name: "Synthesis", role: "research/writer", task: "Write.", type: "expert", dependsOn: ["completed", "failed"], terminal: true },
      ],
    },
  };
  store.create(snapshot, { type: "task.failed", data: {} });
  store.record(snapshot.id, {}, {
    type: "step.completed",
    data: { stepId: "failed", status: "failed" },
  });
  store.saveCheckpoint({
    schemaVersion: 1,
    taskId: snapshot.id,
    runId: "failed-expert-run",
    reason: "initial",
    sequence: 2,
    createdAt: "2026-08-18T00:01:00.000Z",
    workflow: { yaml: "name: test", sha256: "workflow-hash" },
    inputs: { topic: snapshot.topic },
    inputHash: "input-hash",
    runtimeFingerprint: "runtime-hash",
    policyFingerprint: "policy-hash",
    completedSteps: [
      { id: "completed", role: "research/analyst", status: "completed", output: "completed", output_var: "completed", duration: 1, tokens: { input: 0, output: 0 } },
      { id: "final", role: "research/writer", status: "skipped", duration: 0, tokens: { input: 0, output: 0 } },
    ],
    outputVariables: { completed: "completed" },
    evidenceBundles: [],
  });
  let fromStep: string | undefined;
  const manager = new ResearchTaskManager(async (_topic, _onEvent, controls) => {
    fromStep = controls.execution?.fromStep;
    return {
      workflowPath: "workflow.yaml",
      output: "# continued",
      workflow: {
        name: "test",
        success: true,
        steps: [{ id: "final", role: "research/writer", status: "completed", output: "# continued", duration: 1, tokens: { input: 0, output: 0 } }],
        totalDuration: 1,
        totalTokens: { input: 0, output: 0 },
      },
    };
  }, store);
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const response = await fetch(`${baseUrl}/api/tasks/${snapshot.id}/continue`, { method: "POST" });
  assert.equal(response.status, 202);
  const continued = await response.json() as { id: string; status: string };
  assert.equal(continued.id, snapshot.id);
  await waitFor(async () => manager.get(snapshot.id)?.status === "completed");
  assert.equal(fromStep, "failed");
});

test("keeps an active event stream open when replaying a historical failure", async (t) => {
  const store = new InMemoryResearchTaskStore();
  const snapshot: ResearchTaskSnapshot = {
    id: "resumed-event-stream-task",
    topic: "resume event stream",
    status: "queued",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
  const manager = new ResearchTaskManager(async () => new Promise(() => undefined), store);
  store.create(snapshot, { type: "task.queued", data: {} });
  store.record(snapshot.id, {}, { type: "task.failed", data: { error: "previous run" } });
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const response = await fetch(`${baseUrl}/api/tasks/${snapshot.id}/events`, {
    headers: { "Last-Event-ID": "1" },
  });
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  assert.ok(reader);
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(new TextDecoder().decode(first.value), /event: task\.failed/u);

  const nextRead = reader.read();
  const result = await Promise.race([
    nextRead,
    new Promise<"still-open">((resolve) => setTimeout(() => resolve("still-open"), 50)),
  ]);
  assert.equal(result, "still-open");
  await reader.cancel();
});

test("submits, observes, and retrieves a completed research task", async (t) => {
  const manager = new ResearchTaskManager(async (_topic, onEvent) => {
    onEvent({
      type: "gptr.completed",
      timestamp: new Date().toISOString(),
      researchId: "research-1",
      sourceCount: 3,
      cost: 0,
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
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const createdResponse = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: "test topic" }),
  });
  assert.equal(createdResponse.status, 202);
  const created = await createdResponse.json() as { id: string };

  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/tasks/${created.id}`);
    const task = await response.json() as { status: string };
    return task.status === "completed";
  });

  const eventsResponse = await fetch(
    `${baseUrl}/api/tasks/${created.id}/events`,
  );
  const events = await eventsResponse.text();
  assert.match(events, /event: task\.queued/u);
  assert.match(events, /event: gptr\.completed/u);
  assert.match(events, /event: task\.completed/u);

  const resumedEventsResponse = await fetch(
    `${baseUrl}/api/tasks/${created.id}/events`,
    { headers: { "Last-Event-ID": "2" } },
  );
  const resumedEvents = await resumedEventsResponse.text();
  assert.doesNotMatch(resumedEvents, /event: task\.queued/u);
  assert.doesNotMatch(resumedEvents, /event: task\.running/u);
  assert.match(resumedEvents, /event: task\.completed/u);

  const taskResponse = await fetch(`${baseUrl}/api/tasks/${created.id}`);
  const task = await taskResponse.json() as {
    status: string;
    output: string;
  };
  assert.equal(task.status, "completed");
  assert.equal(task.output, "# report");
});

test("lists paginated task history without returning report contents", async (t) => {
  const store = new InMemoryResearchTaskStore();
  const tasks: ResearchTaskSnapshot[] = [
    {
      id: "history-completed",
      topic: "China economy",
      status: "completed",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
      output: "# private report content",
      workflowPlan: { schemaVersion: 1, workflowName: "China", steps: [] },
    },
    {
      id: "history-warning",
      topic: "Russia economy",
      status: "completed_with_warnings",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      output: "# warning report content",
      warnings: ["citation warning"],
    },
  ];
  for (const task of tasks) {
    store.create(task, { type: "task.queued", data: { topic: task.topic } });
  }
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
  }), store);
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const firstResponse = await fetch(`${baseUrl}/api/tasks?limit=1`);
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json() as {
    items: Array<{ id: string; topic: string; output?: string }>;
    nextCursor?: string;
  };
  assert.deepEqual(first.items, [{
    id: "history-warning",
    topic: "Russia economy",
    status: "completed_with_warnings",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    expertCount: 0,
    sourceCount: 0,
    warningCount: 1,
    hasReport: true,
  }]);
  assert.equal("output" in first.items[0]!, false);
  assert.ok(first.nextCursor);

  const secondResponse = await fetch(
    `${baseUrl}/api/tasks?filter=completed&cursor=${encodeURIComponent(first.nextCursor!)}`,
  );
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json() as { items: Array<{ id: string }> };
  assert.deepEqual(second.items.map((item) => item.id), ["history-completed"]);

  const warningResponse = await fetch(`${baseUrl}/api/tasks?filter=warnings&q=Russia`);
  assert.equal(warningResponse.status, 200);
  const warnings = await warningResponse.json() as { items: Array<{ id: string }> };
  assert.deepEqual(warnings.items.map((item) => item.id), ["history-warning"]);
});

test("creates a stable report document for a completed task", async (t) => {
  const store = new InMemoryResearchTaskStore();
  const snapshot: ResearchTaskSnapshot = {
    id: "report-document-api-task",
    topic: "report document",
    status: "completed",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    output: "# Title\n\nFirst paragraph.\n\nSecond paragraph.",
  };
  store.create(snapshot, { type: "task.completed", data: {} });
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# report",
    workflow: { name: "test", success: true, steps: [], totalDuration: 1, totalTokens: { input: 0, output: 0 } },
  }), store);
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const first = await fetch(`${baseUrl}/api/tasks/${snapshot.id}/report-document`)
    .then((response) => response.json()) as {
      taskId: string;
      version: number;
      createdAt: string;
      baselineMarkdown: string;
      currentMarkdown: string;
      blocks: Array<{ id: string; text: string }>;
    };
  assert.equal(first.taskId, snapshot.id);
  assert.equal(first.version, 1);
  assert.equal(first.baselineMarkdown, snapshot.output);
  assert.equal(first.currentMarkdown, snapshot.output);
  assert.deepEqual(first.blocks.map((block) => block.id), [
    "heading-1",
    "paragraph-1",
    "paragraph-2",
  ]);

  const second = await fetch(`${baseUrl}/api/tasks/${snapshot.id}/report-document`)
    .then((response) => response.json()) as { createdAt: string };
  assert.equal(second.createdAt, first.createdAt);
});

test("creates and applies a version-protected local report edit through the API", async (t) => {
  const store = new InMemoryResearchTaskStore();
  const snapshot: ResearchTaskSnapshot = {
    id: "report-editor-api-task",
    topic: "report editor",
    status: "completed",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    output: "# Title\n\nFirst paragraph.\n\nSecond paragraph.",
  };
  store.create(snapshot, { type: "task.completed", data: {} });
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# report",
    workflow: { name: "test", success: true, steps: [], totalDuration: 1, totalTokens: { input: 0, output: 0 } },
  }), store);
  const reportDocuments = new InMemoryReportDocumentStore();
  const reportEditor = new ReportEditorService(
    reportDocuments,
    new InMemoryReportEditorStore(),
    { async rewrite() { return "Revised first paragraph."; } },
  );
  const server = createApiServer(
    manager,
    undefined,
    undefined,
    undefined,
    undefined,
    reportDocuments,
    reportEditor,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const document = await fetch(`${baseUrl}/api/tasks/${snapshot.id}/report-document`)
    .then((response) => response.json()) as {
      version: number;
      blocks: Array<{ id: string; fingerprint: string }>;
    };
  const block = document.blocks.find((item) => item.id === "paragraph-1")!;
  const proposalResponse = await fetch(
    `${baseUrl}/api/tasks/${snapshot.id}/report-editor/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blockId: block.id,
        documentVersion: document.version,
        originalFingerprint: block.fingerprint,
        instruction: "Revise this paragraph.",
      }),
    },
  );
  assert.equal(proposalResponse.status, 201);
  const proposal = await proposalResponse.json() as {
    operation: { id: string; state: string };
  };
  assert.equal(proposal.operation.state, "proposed");

  const appliedResponse = await fetch(
    `${baseUrl}/api/tasks/${snapshot.id}/report-editor/operations/${proposal.operation.id}/apply`,
    { method: "POST" },
  );
  assert.equal(appliedResponse.status, 200);
  const applied = await appliedResponse.json() as {
    document: { currentMarkdown: string; version: number; isDirty: boolean };
  };
  assert.equal(applied.document.currentMarkdown, "# Title\n\nRevised first paragraph.\n\nSecond paragraph.");
  assert.equal(applied.document.version, 1);
  assert.equal(applied.document.isDirty, true);

  const savedResponse = await fetch(
    `${baseUrl}/api/tasks/${snapshot.id}/report-editor/save-version`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentVersion: applied.document.version }),
    },
  );
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json() as { document: { version: number; isDirty: boolean } };
  assert.equal(saved.document.version, 2);
  assert.equal(saved.document.isDirty, false);

  const conversations = await fetch(
    `${baseUrl}/api/tasks/${snapshot.id}/report-editor/conversations?blockId=paragraph-1`,
  ).then((response) => response.json()) as {
    conversations: Array<{ messages: Array<{ role: string }> }>;
  };
  assert.deepEqual(conversations.conversations[0]?.messages.map((message) => message.role), [
    "user", "assistant", "event",
  ]);
});

test("uses a scoped conversation when an unselected report request is automatically targeted", async (t) => {
  const store = new InMemoryResearchTaskStore();
  const snapshot: ResearchTaskSnapshot = {
    id: "report-editor-auto-target-api-task",
    topic: "report editor",
    status: "completed",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    output: "# Title\n\nFirst paragraph.\n\nSecond paragraph.",
  };
  store.create(snapshot, { type: "task.completed", data: {} });
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# report",
    workflow: { name: "test", success: true, steps: [], totalDuration: 1, totalTokens: { input: 0, output: 0 } },
  }), store);
  const reportDocuments = new InMemoryReportDocumentStore();
  const reportEditorStore = new InMemoryReportEditorStore();
  const reportEditor = new ReportEditorService(
    reportDocuments,
    reportEditorStore,
    {
      async plan() { return { intent: "edit" as const, urls: [], targetBlockIds: ["paragraph-2"] }; },
      async rewrite() { return "Shortened second paragraph."; },
    },
  );
  const server = createApiServer(manager, undefined, undefined, undefined, undefined, reportDocuments, reportEditor);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const document = await fetch(`${baseUrl}/api/tasks/${snapshot.id}/report-document`)
    .then((response) => response.json()) as { version: number };
  const wholeDocumentConversation = reportEditorStore.createConversation(snapshot.id, "document");

  const response = await fetch(`${baseUrl}/api/tasks/${snapshot.id}/report-editor/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "document",
      documentVersion: document.version,
      instruction: "缩写第三点第一段。",
      conversationId: wholeDocumentConversation.id,
    }),
  });
  assert.equal(response.status, 201);
  const proposal = await response.json() as {
    targetBlockIds: string[];
    conversation: { blockId: string };
    operation: { blockIds: string[] };
  };
  assert.deepEqual(proposal.targetBlockIds, ["paragraph-2"]);
  assert.equal(proposal.conversation.blockId, "document");
  assert.deepEqual(proposal.operation.blockIds, ["paragraph-2"]);
});

test("saves an explicit manual report edit through the API", async (t) => {
  const store = new InMemoryResearchTaskStore();
  const snapshot: ResearchTaskSnapshot = {
    id: "report-editor-manual-api-task",
    topic: "manual report editor",
    status: "completed",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    output: "# Title\n\nFirst paragraph.\n\nSecond paragraph.",
  };
  store.create(snapshot, { type: "task.completed", data: {} });
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# report",
    workflow: { name: "test", success: true, steps: [], totalDuration: 1, totalTokens: { input: 0, output: 0 } },
  }), store);
  const reportDocuments = new InMemoryReportDocumentStore();
  const reportEditor = new ReportEditorService(
    reportDocuments,
    new InMemoryReportEditorStore(),
    { async rewrite() { return "unused"; } },
  );
  const server = createApiServer(manager, undefined, undefined, undefined, undefined, reportDocuments, reportEditor);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const document = await fetch(`${baseUrl}/api/tasks/${snapshot.id}/report-document`)
    .then((response) => response.json()) as {
      version: number;
      blocks: Array<{ id: string; fingerprint: string }>;
    };
  const block = document.blocks.find((item) => item.id === "paragraph-2")!;

  const replacementMarkdown = [
    "Manually revised second paragraph.",
    "",
    "Expanded report detail. ".repeat(4_000),
  ].join("\n");
  assert.ok(Buffer.byteLength(JSON.stringify({ replacementMarkdown })) > 64 * 1024);

  const response = await fetch(`${baseUrl}/api/tasks/${snapshot.id}/report-editor/manual-save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "blocks",
      blockIds: [block.id],
      documentVersion: document.version,
      originalFingerprint: block.fingerprint,
      replacementMarkdown,
    }),
  });
  assert.equal(response.status, 201);
  const saved = await response.json() as {
    operation: { origin: string; state: string };
    document: { currentMarkdown: string; version: number };
  };
  assert.equal(saved.operation.origin, "manual");
  assert.equal(saved.operation.state, "applied");
  assert.equal(saved.document.version, 2);
  assert.equal(saved.document.currentMarkdown, `# Title\n\nFirst paragraph.\n\n${replacementMarkdown}`);
});

test("deletes a completed history task and rejects active tasks", async (t) => {
  const store = new InMemoryResearchTaskStore();
  const completed: ResearchTaskSnapshot = {
    id: "history-delete-completed",
    topic: "completed history",
    status: "completed",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    output: "# report",
  };
  const running: ResearchTaskSnapshot = {
    id: "history-delete-running",
    topic: "running history",
    status: "running",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# report",
    workflow: { name: "test", success: true, steps: [], totalDuration: 1, totalTokens: { input: 0, output: 0 } },
  }), store);
  store.create(completed, { type: "task.completed", data: {} });
  store.create(running, { type: "task.running", data: {} });
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const deleted = await fetch(`${baseUrl}/api/tasks/${completed.id}`, {
    method: "DELETE",
  });
  assert.equal(deleted.status, 204);
  assert.equal(manager.get(completed.id), undefined);

  const rejected = await fetch(`${baseUrl}/api/tasks/${running.id}`, {
    method: "DELETE",
  });
  assert.equal(rejected.status, 409);
  assert.equal(manager.get(running.id)?.status, "running");
});

test("recovers and revises a checkpointed task through explicit API actions", async (t) => {
  const store = new InMemoryResearchTaskStore();
  const snapshot: ResearchTaskSnapshot = {
    id: "checkpoint-api-task",
    topic: "checkpoint topic",
    status: "running",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
  store.create(snapshot, { type: "task.queued", data: {} });
  store.record(snapshot.id, { status: "running" }, {
    type: "task.running",
    data: {},
  });
  const checkpoint = apiCheckpoint(snapshot.id);
  store.saveCheckpoint(checkpoint);
  const executions: Array<{ fromStep?: string }> = [];
  const manager = new ResearchTaskManager(
    async (_topic, _onEvent, controls) => {
      const execution: { fromStep?: string } = {};
      if (controls.execution?.fromStep) {
        execution.fromStep = controls.execution.fromStep;
      }
      executions.push(execution);
      return {
        workflowPath: "workflow.yaml",
        output: "# recovered",
        workflow: {
          name: "test",
          success: true,
          steps: [{
            id: "final",
            role: "research/writer",
            status: "completed",
            output: "# report",
            duration: 1,
            tokens: { input: 0, output: 0 },
          }],
          totalDuration: 1,
          totalTokens: { input: 0, output: 0 },
        },
      };
    },
    store,
  );
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const resume = await fetch(`${baseUrl}/api/tasks/${snapshot.id}/resume`, {
    method: "POST",
  });
  assert.equal(resume.status, 202);
  await waitFor(async () => manager.get(snapshot.id)?.status === "completed");
  assert.deepEqual(executions, [{}]);

  const retiredFeedback = await fetch(
    `${baseUrl}/api/tasks/${snapshot.id}/feedback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stepId: "final", feedback: "补充来源。" }),
    },
  );
  assert.equal(retiredFeedback.status, 404);
  assert.deepEqual(executions, [{}]);
});

test("validates and snapshots task research profiles at submission", async (t) => {
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
  const settings = new RuntimeSettingsStore({
    OPENAI_API_KEY: "secret",
    OPENAI_BASE_URL: "https://models.example/v1",
    AO_PLANNER_MODEL: "planner",
    GPTR_FAST_LLM: "fast",
    GPTR_SMART_LLM: "smart",
    GPTR_EMBEDDING: "m3e",
    GPTR_EMBEDDING_API_KEY: "embedding-secret",
    RETRIEVER: "duckduckgo,openalex",
  });
  const server = createApiServer(
    manager,
    settings,
    undefined,
    readyCapabilityProvider,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (_serviceUrl, concurrency) => ({
      concurrency,
      active: 0,
      queued: 0,
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${
    (server.address() as AddressInfo).port
  }`;

  const validResponse = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: "profiled topic",
      researchProfile: {
        limits: { maxIterations: 6 },
      },
    }),
  });
  assert.equal(validResponse.status, 202);
  const valid = await validResponse.json() as {
    researchProfile: { limits: { maxIterations: number } };
    researchCapabilities: { modes: string[] };
  };
  assert.equal(valid.researchProfile.limits.maxIterations, 6);
  assert.deepEqual(
    valid.researchCapabilities.modes,
    ["standard", "deep", "synthesis"],
  );
  assert.deepEqual(
    (valid.researchProfile as unknown as {
      source: { retrievers: string[] };
    }).source.retrievers,
    ["duckduckgo", "openalex"],
  );

  const urlResponse = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: "specified source task",
      researchProfile: {
        source: {
          mode: "urls",
          urls: ["https://example.com/report"],
          web: {
            includeDomains: ["example.com"],
            excludeDomains: ["ads.example.com"],
          },
        },
      },
    }),
  });
  assert.equal(urlResponse.status, 202);
  const urlTask = await urlResponse.json() as {
    researchProfile: {
      source: {
        mode: string;
        urls: string[];
        web: { retrievers: string[] };
      };
    };
  };
  assert.equal(urlTask.researchProfile.source.mode, "urls");
  assert.deepEqual(
    urlTask.researchProfile.source.web.retrievers,
    ["duckduckgo", "openalex"],
  );

  const deepResponse = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: "supported deep task",
      researchProfile: {
        mode: "deep",
        deep: { breadth: 2, depth: 2, concurrency: 2 },
      },
    }),
  });
  assert.equal(deepResponse.status, 202);

  const synthesisResponse = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: "invalid top-level synthesis",
      researchProfile: { mode: "synthesis" },
    }),
  });
  assert.equal(synthesisResponse.status, 422);
  assert.deepEqual(await synthesisResponse.json(), {
    error: "Synthesis mode is only valid as an AO step override.",
    code: "profile_invariant_violation",
    path: "$.researchProfile.mode",
  });

  const oversizedResponse = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: "oversized deep task",
      researchProfile: {
        mode: "deep",
        deep: { breadth: 5, depth: 3, concurrency: 2 },
      },
    }),
  });
  assert.equal(oversizedResponse.status, 422);
  assert.deepEqual(await oversizedResponse.json(), {
    error: "Deep research breadth 5 exceeds the deployment limit 4.",
    code: "profile_capability_disabled",
    path: "$.researchProfile.deep.breadth",
  });
});

test("proxies completed reports to the export service", async (t) => {
  let receivedBody = "";
  const exporter = createServer(async (request, response) => {
    for await (const chunk of request) receivedBody += chunk;
    response.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="think-tank-report.pdf"',
    });
    response.end(Buffer.from("%PDF-test"));
  });
  exporter.listen(0, "127.0.0.1");
  await once(exporter, "listening");
  t.after(() => exporter.close());
  const exporterPort = (exporter.address() as AddressInfo).port;

  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# verified report",
    workflow: {
      name: "test",
      success: true,
      steps: [],
      totalDuration: 1,
      totalTokens: { input: 0, output: 0 },
    },
  }));
  const server = createApiServer(
    manager,
    undefined,
    () => `http://127.0.0.1:${exporterPort}`,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${
    (server.address() as AddressInfo).port
  }`;

  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: "export topic" }),
  }).then((response) => response.json()) as { id: string };
  await waitFor(async () => {
    const task = await fetch(`${baseUrl}/api/tasks/${created.id}`)
      .then((response) => response.json()) as { status: string };
    return task.status === "completed";
  });

  const response = await fetch(
    `${baseUrl}/api/tasks/${created.id}/export/pdf`,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "%PDF-test");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /filename="research-report-v1\.pdf"; filename\*=UTF-8''%E7%A0%94%E7%A9%B6%E6%8A%A5%E5%91%8A_v1_\d{8}-\d{4}\.pdf/u,
  );
  assert.deepEqual(JSON.parse(receivedBody), {
    taskId: created.id,
    title: "export topic",
    markdown: "# verified report",
  });
});

test("serves the React build entry and rejects unknown assets", async (t) => {
  const manager = new ResearchTaskManager(async () => {
    throw new Error("runner should not be called");
  });
  const webRoot = await mkdtemp(join(tmpdir(), "think-tank-web-"));
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(
    join(webRoot, "index.html"),
    "<!doctype html><title>智研AI助手</title><script type=\"module\" src=\"/assets/index-test.js\"></script>",
  );
  await writeFile(join(webRoot, "assets", "index-test.js"), "console.log('智研AI助手');");
  await writeFile(join(webRoot, "assets", "index-test.css"), ".app-shell { color: #20252b; }");
  const server = createApiServer(
    manager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    webRoot,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await rm(webRoot, { recursive: true, force: true });
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/u);
  const pageText = await page.text();
  assert.match(pageText, /智研AI助手/u);
  assert.match(pageText, /\/assets\/index-test\.js/u);
  assert.doesNotMatch(pageText, /AI 智囊团|markdown-it\.min|app\.js/u);

  const script = await fetch(`${baseUrl}/assets/index-test.js`);
  assert.equal(script.status, 200);
  const scriptText = await script.text();
  assert.match(scriptText, /智研AI助手/u);

  const styles = await fetch(`${baseUrl}/assets/index-test.css`);
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get("content-type") ?? "", /text\/css/u);

  const historyRoute = await fetch(`${baseUrl}/tasks/example`);
  assert.equal(historyRoute.status, 200);
  assert.equal(await historyRoute.text(), pageText);

  const missing = await fetch(`${baseUrl}/not-a-real-asset.js`);
  assert.equal(missing.status, 404);
});

test("returns a report and closes SSE when acceptance has warnings", async (t) => {
  const manager = new ResearchTaskManager(async () => ({
    workflowPath: "workflow.yaml",
    output: "# report that remains useful",
    workflow: {
      name: "test",
      success: true,
      steps: [{
        id: "final",
        role: "research/writer",
        status: "completed",
        output: "# report that remains useful",
        acceptance: "Include every requested citation.",
        duration: 1,
        tokens: { input: 0, output: 0 },
        verification: {
          pass: false,
          failed: ["One requested citation is missing."],
          reworked: true,
        },
      }],
      totalDuration: 1,
      totalTokens: { input: 0, output: 0 },
    },
  }));
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: "test topic" }),
  }).then((response) => response.json()) as { id: string };

  await waitFor(async () => {
    const task = await fetch(`${baseUrl}/api/tasks/${created.id}`)
      .then((response) => response.json()) as { status: string };
    return task.status === "completed_with_warnings";
  });

  const task = await fetch(`${baseUrl}/api/tasks/${created.id}`)
    .then((response) => response.json()) as {
      status: string;
      output: string;
      warnings: string[];
    };
  assert.equal(task.status, "completed_with_warnings");
  assert.equal(task.output, "# report that remains useful");
  assert.equal(task.warnings.length, 1);

  const events = await fetch(`${baseUrl}/api/tasks/${created.id}/events`)
    .then((response) => response.text());
  assert.match(events, /event: task\.completed_with_warnings/u);
});

test("accepts user input for a paused AO task", async (t) => {
  const manager = new ResearchTaskManager(
    async (_topic, _onEvent, controls) => {
      const answer = await controls.requestInput({
        stepId: "clarify",
        kind: "human_input",
        prompt: "需要哪一个市场？",
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
  );
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: "test topic" }),
  }).then((response) => response.json()) as { id: string };
  await waitFor(async () => {
    const task = await fetch(`${baseUrl}/api/tasks/${created.id}`)
      .then((response) => response.json()) as { status: string };
    return task.status === "needs_input";
  });
  const pending = await fetch(`${baseUrl}/api/tasks/${created.id}`)
    .then((response) => response.json()) as {
      pendingInput?: { requestId?: string };
    };

  const inputResponse = await fetch(
    `${baseUrl}/api/tasks/${created.id}/input`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        answer: "中国市场",
        requestId: pending.pendingInput?.requestId,
      }),
    },
  );
  assert.equal(inputResponse.status, 202);
  await waitFor(async () => {
    const task = await fetch(`${baseUrl}/api/tasks/${created.id}`)
      .then((response) => response.json()) as {
        status: string;
        output?: string;
      };
    return task.status === "completed" && task.output === "中国市场";
  });
});

test("cancels an active task and closes its event stream", async (t) => {
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
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${
    (server.address() as AddressInfo).port
  }`;

  const created = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: "cancel via API" }),
  }).then((response) => response.json()) as { id: string };
  await waitFor(async () => {
    const task = await fetch(`${baseUrl}/api/tasks/${created.id}`)
      .then((response) => response.json()) as { status: string };
    return task.status === "running";
  });

  const cancelResponse = await fetch(
    `${baseUrl}/api/tasks/${created.id}/cancel`,
    { method: "POST" },
  );
  assert.equal(cancelResponse.status, 202);
  await waitFor(async () => {
    const task = await fetch(`${baseUrl}/api/tasks/${created.id}`)
      .then((response) => response.json()) as { status: string };
    return task.status === "canceled";
  });
  const events = await fetch(`${baseUrl}/api/tasks/${created.id}/events`)
    .then((response) => response.text());
  assert.match(events, /event: task\.canceling/u);
  assert.match(events, /event: task\.canceled/u);
});

test("reports readiness only when the researcher adapter is ready", async (t) => {
  const researcher = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"status":"ready"}');
  });
  researcher.listen(0, "127.0.0.1");
  await once(researcher, "listening");
  t.after(() => researcher.close());
  const researcherUrl = `http://127.0.0.1:${
    (researcher.address() as AddressInfo).port
  }`;

  const manager = new ResearchTaskManager(async () => {
    throw new Error("runner should not be called");
  });
  const server = createApiServer(
    manager,
    undefined,
    () => researcherUrl,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const response = await fetch(
    `http://127.0.0.1:${
      (server.address() as AddressInfo).port
    }/ready`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ready",
    checks: {
      configuration: "ok",
      taskStore: "ok",
      researcher: "ok",
    },
  });
});

test("updates an API Key without exposing it through settings reads", async (t) => {
  const manager = new ResearchTaskManager(async () => {
    throw new Error("runner should not be called");
  });
  const settings = new RuntimeSettingsStore({
    OPENAI_API_KEY: "secret",
    OPENAI_BASE_URL: "https://models.example/v1",
    AO_PLANNER_MODEL: "planner",
    GPTR_FAST_LLM: "fast",
    GPTR_SMART_LLM: "smart",
    GPTR_EMBEDDING: "m3e",
    RETRIEVER: "duckduckgo",
    AO_CONCURRENCY: "2",
  });
  const directory = await mkdtemp(join(tmpdir(), "think-tank-settings-"));
  const environmentFilePath = join(directory, ".env");
  const tavilyCapabilityProvider: ResearchCapabilityProvider = {
    async getCatalog() {
      return {
        schemaVersion: 1,
        retrievers: [
          ...readyRetrieverCatalog.retrievers,
          {
            id: "tavily",
            label: "Tavily",
            category: "web",
            selectable: true,
            credentialRequired: true,
            timeoutMs: 20_000,
          },
        ],
        maxRetrievers: 3,
      };
    },
  };
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createApiServer(
    manager,
    settings,
    undefined,
    tavilyCapabilityProvider,
    environmentFilePath,
    undefined,
    undefined,
    undefined,
    passingSettingsPreflight,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const initial = await fetch(`${baseUrl}/api/settings`)
    .then((response) => response.json()) as Record<string, unknown>;
  assert.equal(initial.apiKeyConfigured, true);
  assert.equal(initial.embeddingApiKeyConfigured, false);
  assert.equal("apiKey" in initial, false);
  assert.equal("embeddingApiKey" in initial, false);
  assert.deepEqual(initial.configuredRetrieverCredentials, []);
  assert.deepEqual(initial.retrieverCapabilities, [
    {
      id: "duckduckgo",
      label: "DuckDuckGo",
      category: "web",
      selectable: true,
      credentialRequired: false,
      timeoutMs: 20_000,
    },
    {
      id: "openalex",
      label: "OpenAlex",
      category: "academic",
      selectable: true,
      credentialRequired: false,
      timeoutMs: 20_000,
    },
    {
      id: "tavily",
      label: "Tavily",
      category: "web",
      selectable: true,
      credentialRequired: true,
      timeoutMs: 20_000,
    },
  ]);
  assert.equal(initial.maxRetrievers, 3);
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: "replacement-secret",
      embeddingApiKey: "replacement-embedding-secret",
      retrieverApiKeys: { tavily: "replacement-tavily-secret" },
      retrievers: ["duckduckgo", "openalex", "tavily"],
      concurrency: 4,
    }),
  });
  assert.equal(response.status, 200);
  const updated = await response.json() as {
    retriever: string;
    retrievers: string[];
    concurrency: number;
    embeddingApiKeyConfigured: boolean;
    configuredRetrieverCredentials: string[];
  };
  assert.equal(updated.retriever, "duckduckgo");
  assert.deepEqual(updated.retrievers, ["duckduckgo", "openalex", "tavily"]);
  assert.equal(updated.concurrency, 4);
  assert.equal(updated.embeddingApiKeyConfigured, true);
  assert.deepEqual(updated.configuredRetrieverCredentials, ["tavily"]);
  assert.equal("apiKey" in updated, false);
  assert.equal("embeddingApiKey" in updated, false);
  assert.equal("retrieverApiKeys" in updated, false);
  assert.equal(
    settings.getRuntimeSettings().planner.api_key,
    "replacement-secret",
  );
  assert.equal(
    settings.getRuntimeSettings().gptrEmbeddingApiKey,
    "replacement-embedding-secret",
  );
  assert.equal(
    settings.getRuntimeSettings().retrieverApiKeys.tavily,
    "replacement-tavily-secret",
  );
  assert.equal(
    await readFile(environmentFilePath, "utf8"),
    'OPENAI_API_KEY="replacement-secret"\nGPTR_EMBEDDING_API_KEY="replacement-embedding-secret"\nTAVILY_API_KEY="replacement-tavily-secret"\n',
  );
});

test("applies scheduling settings to Researcher before persisting them", async (t) => {
  const settings = new RuntimeSettingsStore({
    OPENAI_API_KEY: "secret",
    OPENAI_BASE_URL: "https://models.example/v1",
    AO_PLANNER_MODEL: "planner",
    GPTR_FAST_LLM: "fast",
    GPTR_SMART_LLM: "smart",
    GPTR_EMBEDDING: "m3e",
    RETRIEVER: "duckduckgo",
    AO_CONCURRENCY: "2",
  });
  const applied: number[] = [];
  const server = createApiServer(
    new ResearchTaskManager(async () => { throw new Error("runner should not be called"); }),
    settings,
    undefined,
    readyCapabilityProvider,
    undefined,
    undefined,
    undefined,
    undefined,
    passingSettingsPreflight,
    undefined,
    undefined,
    undefined,
    async (_serviceUrl, concurrency) => {
      applied.push(concurrency);
      if (concurrency === 5) {
        throw new Error("Researcher is unavailable");
      }
      return { concurrency, active: 0, queued: 0 };
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const appliedResponse = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "scheduling", concurrency: 4 }),
  });
  assert.equal(appliedResponse.status, 200);
  assert.deepEqual(applied, [4]);
  assert.equal(settings.getRuntimeSettings().concurrency, 4);

  const rejectedResponse = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "scheduling", concurrency: 5 }),
  });
  assert.equal(rejectedResponse.status, 503);
  assert.deepEqual(applied, [4, 5]);
  assert.equal(settings.getRuntimeSettings().concurrency, 4);
});

test("does not persist settings when connection preflight fails", async (t) => {
  const settings = new RuntimeSettingsStore({
    OPENAI_API_KEY: "original-secret",
    OPENAI_BASE_URL: "https://models.example/v1",
    AO_PLANNER_MODEL: "planner",
    GPTR_FAST_LLM: "fast",
    GPTR_SMART_LLM: "smart",
    GPTR_EMBEDDING: "m3e",
    RETRIEVER: "duckduckgo",
    AO_CONCURRENCY: "2",
  });
  const directory = await mkdtemp(join(tmpdir(), "think-tank-settings-"));
  const environmentFilePath = join(directory, ".env");
  await writeFile(environmentFilePath, 'OPENAI_API_KEY="original-secret"\n', "utf8");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createApiServer(
    new ResearchTaskManager(async () => { throw new Error("runner should not be called"); }),
    settings,
    undefined,
    readyCapabilityProvider,
    environmentFilePath,
    undefined,
    undefined,
    undefined,
    async () => [{
      id: "embedding",
      label: "Embedding 模型",
      status: "failed",
      detail: "Embedding 接口返回 401",
    }],
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const response = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: "replacement-secret",
      embeddingApiKey: "replacement-embedding-secret",
    }),
  });

  assert.equal(response.status, 422);
  const body = await response.json() as { error: string; checks: SettingsPreflightCheck[] };
  assert.match(body.error, /Embedding 模型/u);
  assert.deepEqual(body.checks, [{
    id: "embedding",
    label: "Embedding 模型",
    status: "failed",
    detail: "Embedding 接口返回 401",
  }]);
  assert.equal(settings.getRuntimeSettings().planner.api_key, "original-secret");
  assert.equal(settings.getRuntimeSettings().gptrEmbeddingApiKey, undefined);
  assert.equal(await readFile(environmentFilePath, "utf8"), 'OPENAI_API_KEY="original-secret"\n');
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}

function apiCheckpoint(taskId: string): WorkflowCheckpoint {
  return {
    schemaVersion: 1,
    taskId,
    runId: "run-initial",
    reason: "initial",
    sequence: 1,
    createdAt: "2026-08-03T00:01:00.000Z",
    workflow: { yaml: "name: test", sha256: "hash" },
    inputs: { topic: "checkpoint topic" },
    inputHash: "input-hash",
    runtimeFingerprint: "runtime-hash",
    policyFingerprint: "policy-hash",
    completedSteps: [{
      id: "final",
      role: "research/writer",
      status: "completed",
      output: "# prior report",
      output_var: "report",
      duration: 1,
      tokens: { input: 0, output: 0 },
    }],
    outputVariables: { report: "# prior report" },
    evidenceBundles: [],
  };
}
