import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  InMemoryResearchTaskStore,
  SqliteResearchTaskStore,
  type ResearchTaskStore,
} from "../src/research-task-store.js";
import type { ResearchTaskSnapshot } from "../src/research-tasks.js";
import type { ResearchDiagnosticRecord } from "../src/research-telemetry.js";
import type { WorkflowCheckpoint } from "../src/workflow-checkpoint.js";
import type { EvidenceBundle } from "../src/evidence-bundle.js";

for (const adapter of [
  {
    name: "memory",
    create: (diagnosticLimit?: number) => ({
      store: new InMemoryResearchTaskStore(diagnosticLimit),
      cleanup: () => undefined,
    }),
  },
  {
    name: "sqlite",
    create: (diagnosticLimit?: number) => {
      const directory = mkdtempSync(join(tmpdir(), "think-tank-store-"));
      const store = new SqliteResearchTaskStore(
        join(directory, "tasks.sqlite"),
        diagnosticLimit,
      );
      return {
        store,
        cleanup: () => {
          store.close();
          rmSync(directory, { recursive: true, force: true });
        },
      };
    },
  },
] as const) {
  test(`${adapter.name} atomically records task transitions and events`, () => {
    const { store, cleanup } = adapter.create();
    try {
      const snapshot = taskSnapshot("task-1");
      store.create(snapshot, {
        type: "task.queued",
        data: { topic: snapshot.topic },
      });
      const transition = store.record(
        snapshot.id,
        { status: "running" },
        { type: "task.running", data: {} },
      );

      assert.equal(transition?.snapshot.status, "running");
      assert.equal(transition?.event.id, 2);
      assert.deepEqual(
        store.load(snapshot.id)?.events.map((event) => event.type),
        ["task.queued", "task.running"],
      );
    } finally {
      cleanup();
    }
  });

  test(`${adapter.name} preserves ordered durable workflow checkpoints`, () => {
    const { store, cleanup } = adapter.create();
    try {
      const snapshot = taskSnapshot("task-checkpoints");
      store.create(snapshot, { type: "task.queued", data: {} });
      store.saveCheckpoint(checkpoint(snapshot.id, 1));
      store.saveCheckpoint(checkpoint(snapshot.id, 0));

      assert.deepEqual(
        store.listCheckpoints(snapshot.id).map((item) => item.sequence),
        [0, 1],
      );
      assert.equal(store.latestCheckpoint(snapshot.id)?.sequence, 1);
    } finally {
      cleanup();
    }
  });

  test(`${adapter.name} deletes a task and all task-scoped records`, () => {
    const { store, cleanup } = adapter.create();
    try {
      const snapshot = taskSnapshot("task-delete", "completed");
      store.create(snapshot, { type: "task.completed", data: {} });
      store.recordDiagnostic(snapshot.id, diagnostic(1));
      store.saveCheckpoint(checkpoint(snapshot.id, 1));

      assert.equal(store.delete(snapshot.id), true);
      assert.equal(store.load(snapshot.id), undefined);
      assert.deepEqual(store.loadDiagnostics(snapshot.id), []);
      assert.deepEqual(store.listCheckpoints(snapshot.id), []);
      assert.equal(store.delete(snapshot.id), false);
    } finally {
      cleanup();
    }
  });

  test(`${adapter.name} keeps diagnostics outside the public event history`, () => {
    const { store, cleanup } = adapter.create();
    try {
      const snapshot = taskSnapshot("task-diagnostics");
      store.create(snapshot, {
        type: "task.queued",
        data: { topic: snapshot.topic },
      });
      const diagnostic: ResearchDiagnosticRecord = {
        timestamp: "2026-07-29T00:00:01.000Z",
        aoStepId: "market",
        researchRunId: "research-1",
        rawType: "scraping_urls",
        rawStage: "scraping_urls",
        data: { count: 8 },
        truncated: false,
      };

      store.recordDiagnostic(snapshot.id, diagnostic);

      assert.deepEqual(store.load(snapshot.id)?.events.map((event) =>
        event.type
      ), ["task.queued"]);
      assert.deepEqual(store.loadDiagnostics(snapshot.id), [{
        id: 1,
        taskId: snapshot.id,
        ...diagnostic,
      }]);
    } finally {
      cleanup();
    }
  });

  test(`${adapter.name} keeps evidence bundles outside the task snapshot`, () => {
    const { store, cleanup } = adapter.create();
    try {
      const snapshot = taskSnapshot("task-evidence");
      store.create(snapshot, { type: "task.queued", data: {} });
      assert.equal(store.appendEvidenceBundle(snapshot.id, evidenceBundle()), true);

      assert.equal(store.load(snapshot.id)?.snapshot.evidenceBundles, undefined);
      assert.deepEqual(store.loadEvidenceBundles(snapshot.id), [evidenceBundle()]);
    } finally {
      cleanup();
    }
  });

  test(`${adapter.name} bounds diagnostics and summarizes dropped records`, () => {
    const { store, cleanup } = adapter.create(3);
    try {
      const snapshot = taskSnapshot("task-bounded-diagnostics");
      store.create(snapshot, {
        type: "task.queued",
        data: { topic: snapshot.topic },
      });

      for (let index = 1; index <= 5; index += 1) {
        store.recordDiagnostic(snapshot.id, diagnostic(index));
      }

      const diagnostics = store.loadDiagnostics(snapshot.id);
      assert.equal(diagnostics.length, 3);
      assert.deepEqual(
        diagnostics.slice(0, 2).map((entry) => entry.data),
        [{ index: 1 }, { index: 2 }],
      );
      assert.deepEqual(diagnostics[2], {
        id: 3,
        taskId: snapshot.id,
        timestamp: "2026-07-29T00:00:05.000Z",
        aoStepId: "system",
        researchRunId: "diagnostics",
        rawType: "diagnostics.truncated",
        rawStage: "diagnostics.truncated",
        data: { droppedCount: 3 },
        truncated: true,
      });
    } finally {
      cleanup();
    }
  });
}

test("sqlite keeps terminal tasks and fails interrupted tasks on recovery", () => {
  const directory = mkdtempSync(join(tmpdir(), "think-tank-recovery-"));
  const path = join(directory, "tasks.sqlite");
  try {
    const first = new SqliteResearchTaskStore(path);
    first.create(taskSnapshot("running-task", "running"), {
      type: "task.running",
      data: {},
    });
    first.create(taskSnapshot("completed-task", "completed"), {
      type: "task.completed",
      data: {},
    });
    first.close();

    const second = new SqliteResearchTaskStore(path);
    assert.equal(second.recoverInterrupted(), 1);
    assert.equal(second.load("running-task")?.snapshot.status, "failed");
    assert.match(
      second.load("running-task")?.snapshot.error ?? "",
      /服务重启/u,
    );
    assert.equal(
      second.load("running-task")?.events.at(-1)?.type,
      "task.failed",
    );
    assert.equal(second.load("completed-task")?.snapshot.status, "completed");
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite migrates legacy inline evidence bundles into the dedicated table", () => {
  const directory = mkdtempSync(join(tmpdir(), "think-tank-evidence-migration-"));
  const path = join(directory, "tasks.sqlite");
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE research_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
    `);
    const snapshot = {
      ...taskSnapshot("legacy-evidence"),
      evidenceBundles: [evidenceBundle()],
    };
    legacy.prepare(`
      INSERT INTO research_tasks(id, status, created_at, updated_at, snapshot_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      snapshot.id,
      snapshot.status,
      snapshot.createdAt,
      snapshot.updatedAt,
      JSON.stringify(snapshot),
    );
  } finally {
    legacy.close();
  }
  try {
    const store = new SqliteResearchTaskStore(path);
    assert.equal(store.load("legacy-evidence")?.snapshot.evidenceBundles, undefined);
    assert.deepEqual(store.loadEvidenceBundles("legacy-evidence"), [
      evidenceBundle(),
    ]);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function taskSnapshot(
  id: string,
  status: ResearchTaskSnapshot["status"] = "queued",
): ResearchTaskSnapshot {
  return {
    id,
    topic: "研究话题",
    status,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

// Compile-time assertion that both adapters expose the same small interface.
const _stores: ResearchTaskStore[] = [
  new InMemoryResearchTaskStore(),
];

function diagnostic(index: number): ResearchDiagnosticRecord {
  return {
    timestamp: `2026-07-29T00:00:0${index}.000Z`,
    aoStepId: "market",
    researchRunId: "research-1",
    rawType: "logs",
    rawStage: "logs",
    data: { index },
    truncated: false,
  };
}

function checkpoint(taskId: string, sequence: number): WorkflowCheckpoint {
  return {
    schemaVersion: 1,
    taskId,
    runId: "run-1",
    reason: "initial",
    sequence,
    createdAt: `2026-08-03T00:00:0${sequence}.000Z`,
    workflow: { yaml: "name: checkpoint", sha256: "workflow-hash" },
    inputs: { topic: "研究话题" },
    inputHash: "input-hash",
    runtimeFingerprint: "runtime-hash",
    policyFingerprint: "policy-hash",
    completedSteps: [],
    outputVariables: {},
    evidenceBundles: [],
  };
}

function evidenceBundle(): EvidenceBundle {
  return {
    schemaVersion: 1 as const,
    aoStepId: "research",
    researchRunId: "run-1",
    attempt: 1,
    mode: "standard" as const,
    startedAt: "2026-07-29T00:00:00.000Z",
    completedAt: "2026-07-29T00:01:00.000Z",
    derivedFromStepIds: [],
    queries: [],
    sources: [],
    researchContext: {
      content: "evidence",
      originalCharacters: 8,
      truncated: false,
    },
    method: { sourceMode: "web", retrievers: ["duckduckgo"] },
    report: { format: "markdown" as const, content: "# evidence", revision: 1 },
    cost: 0,
  };
}
