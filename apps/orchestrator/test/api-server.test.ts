import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    document: { currentMarkdown: string; version: number };
  };
  assert.equal(applied.document.currentMarkdown, "# Title\n\nRevised first paragraph.\n\nSecond paragraph.");
  assert.equal(applied.document.version, 2);

  const conversations = await fetch(
    `${baseUrl}/api/tasks/${snapshot.id}/report-editor/conversations?blockId=paragraph-1`,
  ).then((response) => response.json()) as {
    conversations: Array<{ messages: Array<{ role: string }> }>;
  };
  assert.deepEqual(conversations.conversations[0]?.messages.map((message) => message.role), [
    "user", "assistant", "event",
  ]);
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
    RETRIEVER: "duckduckgo,openalex",
  });
  const server = createApiServer(
    manager,
    settings,
    undefined,
    readyCapabilityProvider,
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
  assert.match(response.headers.get("content-disposition") ?? "", /\.pdf/u);
  assert.deepEqual(JSON.parse(receivedBody), {
    taskId: created.id,
    title: "export topic",
    markdown: "# verified report",
  });
});

test("serves the same-origin research interface and rejects unknown assets", async (t) => {
  const manager = new ResearchTaskManager(async () => {
    throw new Error("runner should not be called");
  });
  const server = createApiServer(manager);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/u);
  const pageText = await page.text();
  assert.match(pageText, /AI 智囊团/u);
  assert.match(pageText, /组队 → 研究 → 可观测 → 报告/u);
  assert.match(pageText, /id="research-elapsed"/u);
  assert.match(pageText, /id="research-cost"/u);
  assert.match(pageText, /检索来源（去重）/u);
  assert.match(
    pageText,
    /id="event-count"[^>]*>\s*0 个执行节点 · 0 条研究事件/u,
  );
  assert.doesNotMatch(
    pageText,
    /Agency Orchestrator|GPT Researcher|\bAO\b|GPTR/u,
  );
  assert.match(pageText, /\/vendor\/markdown-it\.min\.js/u);
  assert.match(pageText, /<article id="report"/u);
  assert.match(pageText, /id="content-acceptance-state"/u);
  assert.match(pageText, /id="evidence-quality-state"/u);
  assert.match(pageText, /id="content-warning-list"/u);
  assert.match(pageText, /id="evidence-quality-metrics"/u);
  assert.match(pageText, /id="evidence-warning-list"/u);
  assert.match(pageText, /id="source-mode"/u);
  assert.match(pageText, /仅指定 URL/u);
  assert.match(pageText, /指定 URL \+ Web 补充/u);
  assert.match(pageText, /href="\/favicon\.ico\?v=20260729"/u);
  assert.match(pageText, /sizes="32x32"/u);
  assert.match(pageText, /rel="apple-touch-icon"/u);

  const logo = await fetch(
    `${baseUrl}/assets/ai-think-tank-logo.png`,
  );
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.ok((await logo.arrayBuffer()).byteLength > 1_000);

  const favicon = await fetch(`${baseUrl}/favicon.ico`);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("content-type"), "image/x-icon");
  assert.ok((await favicon.arrayBuffer()).byteLength > 1_000);

  const tabIcon = await fetch(`${baseUrl}/assets/favicon-32x32.png`);
  assert.equal(tabIcon.status, 200);
  assert.equal(tabIcon.headers.get("content-type"), "image/png");
  assert.ok((await tabIcon.arrayBuffer()).byteLength > 500);

  const styles = await fetch(`${baseUrl}/styles.css`);
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get("content-type") ?? "", /text\/css/u);
  const stylesText = await styles.text();
  assert.match(stylesText, /\[hidden\]\s*\{[\s\S]*display:\s*none/u);
  assert.match(
    stylesText,
    /\.timeline-panel\s*\{[\s\S]*height:[\s\S]*overflow:\s*hidden/u,
  );
  assert.match(
    stylesText,
    /height:\s*clamp\(720px,\s*86vh,\s*980px\)/u,
  );
  assert.match(
    stylesText,
    /\.timeline\s*\{[\s\S]*overflow-y:\s*auto/u,
  );
  assert.match(
    stylesText,
    /\.research-activity-list\s*\{[\s\S]*max-height:[\s\S]*overflow-y:\s*auto/u,
  );

  const script = await fetch(`${baseUrl}/app.js`);
  assert.equal(script.status, 200);
  const scriptText = await script.text();
  assert.match(scriptText, /EventSource/u);
  assert.match(scriptText, /task\.completed_with_warnings/u);
  assert.match(scriptText, /contentAcceptance/u);
  assert.match(scriptText, /evidenceQuality/u);
  assert.match(scriptText, /markdownit/u);
  assert.match(scriptText, /markdownRenderer\.render/u);
  assert.match(scriptText, /html:\s*false/u);
  assert.match(scriptText, /validateLink/u);
  assert.match(scriptText, /citation-ref/u);
  assert.match(scriptText, /label\.slice\(1,\s*-1\)/u);
  assert.match(scriptText, /\^https\?:/u);
  assert.match(scriptText, /localStorage/u);
  assert.match(scriptText, /restoreActiveTask/u);
  assert.match(scriptText, /lastEventId/u);
  assert.match(scriptText, /gptr\.progress/u);
  assert.match(scriptText, /research\.progress/u);
  assert.match(scriptText, /research\.activity/u);
  assert.match(scriptText, /research\.completed/u);
  assert.match(scriptText, /research\.failed/u);
  assert.match(scriptText, /researchRuns\.get\(progress\.researchRunId\)/u);
  assert.match(scriptText, /buildResearchProfile/u);
  assert.match(scriptText, /includeDomains/u);
  assert.match(scriptText, /updateResearchTelemetry/u);
  assert.match(
    scriptText,
    /updateResearchTelemetry\(\s*task\.researchTelemetry,\s*isTerminalStatus\(task\.status\)/u,
  );
  assert.match(scriptText, /function updateTimelineCounter/u);
  assert.match(scriptText, /个执行节点/u);
  assert.match(scriptText, /条研究事件/u);
  assert.match(scriptText, /function upsertResearchActivity/u);
  assert.match(scriptText, /aria-expanded/u);
  assert.match(scriptText, /taskUniqueSourceCount/u);
  assert.match(scriptText, /reportedCostRuns/u);
  assert.match(scriptText, /scraping_images:\s*"筛选图片"/u);
  assert.match(scriptText, /research_step_finalized:\s*"完成研究步骤"/u);
  assert.doesNotMatch(
    scriptText,
    /`GPTR · \$\{humanizeStage\(stage\)\}`/u,
  );
  assert.doesNotMatch(scriptText, /GPTR 完成一轮证据研究/u);
  assert.doesNotMatch(scriptText, /AO 开始编排研究团队|AO 需要补充信息/u);
  assert.match(scriptText, /task\.needs_input/u);
  assert.match(scriptText, /task\.canceled/u);
  assert.match(scriptText, /\/ready/u);
  assert.match(scriptText, /cancel-button/u);
  assert.match(scriptText, /input-form/u);
  assert.match(scriptText, /settings-form/u);
  assert.doesNotMatch(scriptText, /item\.scrollIntoView/u);
  assert.match(scriptText, /timeline\.scrollTop\s*=\s*timeline\.scrollHeight/u);

  const markdownIt = await fetch(
    `${baseUrl}/vendor/markdown-it.min.js`,
  );
  assert.equal(markdownIt.status, 200);
  assert.match(
    markdownIt.headers.get("content-type") ?? "",
    /text\/javascript/u,
  );
  assert.match(await markdownIt.text(), /markdownit/u);

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
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createApiServer(
    manager,
    settings,
    undefined,
    readyCapabilityProvider,
    environmentFilePath,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const initial = await fetch(`${baseUrl}/api/settings`)
    .then((response) => response.json()) as Record<string, unknown>;
  assert.equal(initial.apiKeyConfigured, true);
  assert.equal("apiKey" in initial, false);
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
  ]);
  assert.equal(initial.maxRetrievers, 2);
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: "replacement-secret",
      retrievers: ["duckduckgo", "openalex"],
      concurrency: 4,
    }),
  });
  assert.equal(response.status, 200);
  const updated = await response.json() as {
    retriever: string;
    retrievers: string[];
    concurrency: number;
  };
  assert.equal(updated.retriever, "duckduckgo");
  assert.deepEqual(updated.retrievers, ["duckduckgo", "openalex"]);
  assert.equal(updated.concurrency, 4);
  assert.equal("apiKey" in updated, false);
  assert.equal(
    settings.getRuntimeSettings().planner.api_key,
    "replacement-secret",
  );
  assert.equal(
    await readFile(environmentFilePath, "utf8"),
    'OPENAI_API_KEY="replacement-secret"\n',
  );
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
