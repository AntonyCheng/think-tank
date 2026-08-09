import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ResearchTaskEvent,
  ResearchTaskSnapshot,
} from "./research-tasks.js";
import type { ResearchDiagnosticRecord } from "./research-telemetry.js";
import type { WorkflowCheckpoint } from "./workflow-checkpoint.js";

export interface StoredResearchTask {
  snapshot: ResearchTaskSnapshot;
  events: ResearchTaskEvent[];
}

export interface StoredResearchDiagnostic extends ResearchDiagnosticRecord {
  id: number;
  taskId: string;
}

export interface ResearchTaskEventDraft {
  type: ResearchTaskEvent["type"];
  data: Record<string, unknown>;
}

export interface ResearchTaskTransition {
  snapshot: ResearchTaskSnapshot;
  event: ResearchTaskEvent;
}

export interface ResearchTaskStore {
  create(
    snapshot: ResearchTaskSnapshot,
    event: ResearchTaskEventDraft,
  ): ResearchTaskTransition;
  load(id: string): StoredResearchTask | undefined;
  list(): ResearchTaskSnapshot[];
  delete(id: string): boolean;
  record(
    id: string,
    changes: Partial<ResearchTaskSnapshot>,
    event: ResearchTaskEventDraft,
  ): ResearchTaskTransition | undefined;
  recordDiagnostic(
    id: string,
    diagnostic: ResearchDiagnosticRecord,
  ): StoredResearchDiagnostic | undefined;
  loadDiagnostics(id: string): StoredResearchDiagnostic[];
  saveCheckpoint(checkpoint: WorkflowCheckpoint): void;
  latestCheckpoint(id: string): WorkflowCheckpoint | undefined;
  listCheckpoints(id: string): WorkflowCheckpoint[];
  recoverInterrupted(): number;
}

export class InMemoryResearchTaskStore implements ResearchTaskStore {
  readonly #tasks = new Map<string, StoredResearchTask>();
  readonly #diagnostics = new Map<string, StoredResearchDiagnostic[]>();
  readonly #checkpoints = new Map<string, WorkflowCheckpoint[]>();
  readonly #diagnosticLimit: number;

  constructor(diagnosticLimit = 2_000) {
    this.#diagnosticLimit = normalizeDiagnosticLimit(diagnosticLimit);
  }

  create(
    snapshot: ResearchTaskSnapshot,
    draft: ResearchTaskEventDraft,
  ): ResearchTaskTransition {
    if (this.#tasks.has(snapshot.id)) {
      throw new Error(`task already exists: ${snapshot.id}`);
    }
    const event = taskEvent(snapshot.id, 1, snapshot.createdAt, draft);
    const stored = {
      snapshot: structuredClone(snapshot),
      events: [event],
    };
    this.#tasks.set(snapshot.id, stored);
    return cloneTransition(stored.snapshot, event);
  }

  load(id: string): StoredResearchTask | undefined {
    const stored = this.#tasks.get(id);
    return stored ? structuredClone(stored) : undefined;
  }

  list(): ResearchTaskSnapshot[] {
    return [...this.#tasks.values()].map((stored) =>
      structuredClone(stored.snapshot)
    );
  }

  delete(id: string): boolean {
    const deleted = this.#tasks.delete(id);
    this.#diagnostics.delete(id);
    this.#checkpoints.delete(id);
    return deleted;
  }

  record(
    id: string,
    changes: Partial<ResearchTaskSnapshot>,
    draft: ResearchTaskEventDraft,
  ): ResearchTaskTransition | undefined {
    const stored = this.#tasks.get(id);
    if (!stored) return undefined;

    const timestamp = new Date().toISOString();
    Object.assign(stored.snapshot, changes, { updatedAt: timestamp });
    const event = taskEvent(
      id,
      stored.events.length + 1,
      timestamp,
      draft,
    );
    stored.events.push(event);
    return cloneTransition(stored.snapshot, event);
  }

  recordDiagnostic(
    id: string,
    diagnostic: ResearchDiagnosticRecord,
  ): StoredResearchDiagnostic | undefined {
    if (!this.#tasks.has(id)) return undefined;
    const diagnostics = this.#diagnostics.get(id) ?? [];
    const detailLimit = this.#diagnosticLimit - 1;
    let stored: StoredResearchDiagnostic;
    if (diagnostics.length < detailLimit) {
      stored = {
        id: diagnostics.length + 1,
        taskId: id,
        ...structuredClone(diagnostic),
      };
      diagnostics.push(stored);
    } else if (diagnostics.length === detailLimit) {
      stored = diagnosticOverflow(
        id,
        this.#diagnosticLimit,
        diagnostic,
        1,
      );
      diagnostics.push(stored);
    } else {
      const previous = diagnostics[this.#diagnosticLimit - 1];
      stored = diagnosticOverflow(
        id,
        this.#diagnosticLimit,
        diagnostic,
        overflowCount(previous) + 1,
      );
      diagnostics[this.#diagnosticLimit - 1] = stored;
    }
    this.#diagnostics.set(id, diagnostics);
    return structuredClone(stored);
  }

  loadDiagnostics(id: string): StoredResearchDiagnostic[] {
    return structuredClone(this.#diagnostics.get(id) ?? []);
  }

  saveCheckpoint(checkpoint: WorkflowCheckpoint): void {
    const records = this.#checkpoints.get(checkpoint.taskId) ?? [];
    const existing = records.findIndex(
      (record) => record.runId === checkpoint.runId &&
        record.sequence === checkpoint.sequence,
    );
    if (existing >= 0) {
      records[existing] = structuredClone(checkpoint);
    } else {
      records.push(structuredClone(checkpoint));
    }
    records.sort(compareCheckpoints);
    this.#checkpoints.set(checkpoint.taskId, records);
  }

  latestCheckpoint(id: string): WorkflowCheckpoint | undefined {
    const records = this.#checkpoints.get(id);
    return records?.length
      ? structuredClone(records.at(-1))
      : undefined;
  }

  listCheckpoints(id: string): WorkflowCheckpoint[] {
    return structuredClone(this.#checkpoints.get(id) ?? []);
  }

  recoverInterrupted(): number {
    let recovered = 0;
    for (const stored of this.#tasks.values()) {
      if (isTerminal(stored.snapshot.status)) continue;
      const checkpoint = this.latestCheckpoint(stored.snapshot.id);
      this.record(
        stored.snapshot.id,
        checkpoint
          ? {
              status: "recoverable",
              pendingInput: undefined,
              recovery: {
                latestRunId: checkpoint.runId,
                checkpointAt: checkpoint.createdAt,
                reason: "restart",
              },
            }
          : {
              status: "failed",
              pendingInput: undefined,
              error: restartInterruptionMessage(),
            },
        checkpoint
          ? {
              type: "task.recoverable",
              data: { reason: "restart", runId: checkpoint.runId },
            }
          : {
              type: "task.failed",
              data: { error: restartInterruptionMessage(), reason: "restart" },
            },
      );
      recovered += 1;
    }
    return recovered;
  }
}

export class SqliteResearchTaskStore implements ResearchTaskStore {
  readonly #database: DatabaseSync;
  readonly #diagnosticLimit: number;

  constructor(filePath: string, diagnosticLimit = 2_000) {
    this.#diagnosticLimit = normalizeDiagnosticLimit(diagnosticLimit);
    mkdirSync(dirname(filePath), { recursive: true });
    this.#database = new DatabaseSync(filePath);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_task_events (
        task_id TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (task_id, event_id),
        FOREIGN KEY (task_id) REFERENCES research_tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS research_task_diagnostics (
        task_id TEXT NOT NULL,
        diagnostic_id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        ao_step_id TEXT NOT NULL,
        research_run_id TEXT NOT NULL,
        raw_type TEXT NOT NULL,
        raw_stage TEXT NOT NULL,
        data_json TEXT NOT NULL,
        truncated INTEGER NOT NULL,
        PRIMARY KEY (task_id, diagnostic_id),
        FOREIGN KEY (task_id) REFERENCES research_tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS research_task_checkpoints (
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL,
        PRIMARY KEY (task_id, run_id, sequence),
        FOREIGN KEY (task_id) REFERENCES research_tasks(id) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (1, datetime('now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (2, datetime('now'));
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (3, datetime('now'));
    `);
  }

  create(
    snapshot: ResearchTaskSnapshot,
    draft: ResearchTaskEventDraft,
  ): ResearchTaskTransition {
    return this.#transaction(() => {
      const event = taskEvent(snapshot.id, 1, snapshot.createdAt, draft);
      this.#database.prepare(`
        INSERT INTO research_tasks(
          id, status, created_at, updated_at, snapshot_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        snapshot.id,
        snapshot.status,
        snapshot.createdAt,
        snapshot.updatedAt,
        JSON.stringify(snapshot),
      );
      this.#insertEvent(event);
      return cloneTransition(snapshot, event);
    });
  }

  load(id: string): StoredResearchTask | undefined {
    const taskRow = this.#database.prepare(`
      SELECT snapshot_json FROM research_tasks WHERE id = ?
    `).get(id) as { snapshot_json: string } | undefined;
    if (!taskRow) return undefined;

    const eventRows = this.#database.prepare(`
      SELECT event_id, timestamp, type, data_json
      FROM research_task_events
      WHERE task_id = ?
      ORDER BY event_id
    `).all(id) as Array<{
      event_id: number;
      timestamp: string;
      type: ResearchTaskEvent["type"];
      data_json: string;
    }>;
    return {
      snapshot: JSON.parse(taskRow.snapshot_json) as ResearchTaskSnapshot,
      events: eventRows.map((row) => ({
        id: Number(row.event_id),
        taskId: id,
        timestamp: row.timestamp,
        type: row.type,
        data: JSON.parse(row.data_json) as Record<string, unknown>,
      })),
    };
  }

  list(): ResearchTaskSnapshot[] {
    const rows = this.#database.prepare(`
      SELECT snapshot_json
      FROM research_tasks
      ORDER BY updated_at DESC, id DESC
    `).all() as Array<{ snapshot_json: string }>;
    return rows.map((row) =>
      JSON.parse(row.snapshot_json) as ResearchTaskSnapshot
    );
  }

  delete(id: string): boolean {
    const result = this.#database.prepare(`
      DELETE FROM research_tasks WHERE id = ?
    `).run(id);
    return Number(result.changes) > 0;
  }

  record(
    id: string,
    changes: Partial<ResearchTaskSnapshot>,
    draft: ResearchTaskEventDraft,
  ): ResearchTaskTransition | undefined {
    return this.#transaction(() => {
      const taskRow = this.#database.prepare(`
        SELECT snapshot_json FROM research_tasks WHERE id = ?
      `).get(id) as { snapshot_json: string } | undefined;
      if (!taskRow) return undefined;

      const timestamp = new Date().toISOString();
      const snapshot = {
        ...JSON.parse(taskRow.snapshot_json) as ResearchTaskSnapshot,
        ...changes,
        updatedAt: timestamp,
      };
      const sequenceRow = this.#database.prepare(`
        SELECT COALESCE(MAX(event_id), 0) AS last_event_id
        FROM research_task_events
        WHERE task_id = ?
      `).get(id) as { last_event_id: number };
      const event = taskEvent(
        id,
        Number(sequenceRow.last_event_id) + 1,
        timestamp,
        draft,
      );
      this.#database.prepare(`
        UPDATE research_tasks
        SET status = ?, updated_at = ?, snapshot_json = ?
        WHERE id = ?
      `).run(
        snapshot.status,
        snapshot.updatedAt,
        JSON.stringify(snapshot),
        id,
      );
      this.#insertEvent(event);
      return cloneTransition(snapshot, event);
    });
  }

  recordDiagnostic(
    id: string,
    diagnostic: ResearchDiagnosticRecord,
  ): StoredResearchDiagnostic | undefined {
    return this.#transaction(() => {
      const task = this.#database.prepare(`
        SELECT id FROM research_tasks WHERE id = ?
      `).get(id) as { id: string } | undefined;
      if (!task) return undefined;
      const sequence = this.#database.prepare(`
        SELECT COALESCE(MAX(diagnostic_id), 0) AS last_diagnostic_id
        FROM research_task_diagnostics
        WHERE task_id = ?
      `).get(id) as { last_diagnostic_id: number };
      const lastId = Number(sequence.last_diagnostic_id);
      const detailLimit = this.#diagnosticLimit - 1;
      let stored: StoredResearchDiagnostic;
      if (lastId < detailLimit) {
        stored = {
          id: lastId + 1,
          taskId: id,
          ...structuredClone(diagnostic),
        };
        this.#insertDiagnostic(stored);
      } else if (lastId === detailLimit) {
        stored = diagnosticOverflow(
          id,
          this.#diagnosticLimit,
          diagnostic,
          1,
        );
        this.#insertDiagnostic(stored);
      } else {
        const row = this.#database.prepare(`
          SELECT data_json
          FROM research_task_diagnostics
          WHERE task_id = ? AND diagnostic_id = ?
        `).get(id, this.#diagnosticLimit) as {
          data_json: string;
        } | undefined;
        const previousCount = row
          ? Number(
            (JSON.parse(row.data_json) as { droppedCount?: unknown })
              .droppedCount,
          )
          : 0;
        stored = diagnosticOverflow(
          id,
          this.#diagnosticLimit,
          diagnostic,
          (Number.isFinite(previousCount) ? previousCount : 0) + 1,
        );
        this.#database.prepare(`
          UPDATE research_task_diagnostics
          SET timestamp = ?, ao_step_id = ?, research_run_id = ?,
              raw_type = ?, raw_stage = ?, data_json = ?, truncated = ?
          WHERE task_id = ? AND diagnostic_id = ?
        `).run(
          stored.timestamp,
          stored.aoStepId,
          stored.researchRunId,
          stored.rawType,
          stored.rawStage,
          JSON.stringify(stored.data),
          1,
          stored.taskId,
          stored.id,
        );
      }
      return structuredClone(stored);
    });
  }

  loadDiagnostics(id: string): StoredResearchDiagnostic[] {
    const rows = this.#database.prepare(`
      SELECT diagnostic_id, timestamp, ao_step_id, research_run_id,
             raw_type, raw_stage, data_json, truncated
      FROM research_task_diagnostics
      WHERE task_id = ?
      ORDER BY diagnostic_id
    `).all(id) as Array<{
      diagnostic_id: number;
      timestamp: string;
      ao_step_id: string;
      research_run_id: string;
      raw_type: string;
      raw_stage: string;
      data_json: string;
      truncated: number;
    }>;
    return rows.map((row) => ({
      id: Number(row.diagnostic_id),
      taskId: id,
      timestamp: row.timestamp,
      aoStepId: row.ao_step_id,
      researchRunId: row.research_run_id,
      rawType: row.raw_type,
      rawStage: row.raw_stage,
      data: JSON.parse(row.data_json) as Record<string, unknown>,
      truncated: Boolean(row.truncated),
    }));
  }

  saveCheckpoint(checkpoint: WorkflowCheckpoint): void {
    this.#database.prepare(`
      INSERT INTO research_task_checkpoints(
        task_id, run_id, sequence, created_at, checkpoint_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id, run_id, sequence) DO UPDATE SET
        created_at = excluded.created_at,
        checkpoint_json = excluded.checkpoint_json
    `).run(
      checkpoint.taskId,
      checkpoint.runId,
      checkpoint.sequence,
      checkpoint.createdAt,
      JSON.stringify(checkpoint),
    );
  }

  latestCheckpoint(id: string): WorkflowCheckpoint | undefined {
    const row = this.#database.prepare(`
      SELECT checkpoint_json
      FROM research_task_checkpoints
      WHERE task_id = ?
      ORDER BY created_at DESC, sequence DESC
      LIMIT 1
    `).get(id) as { checkpoint_json: string } | undefined;
    return row
      ? JSON.parse(row.checkpoint_json) as WorkflowCheckpoint
      : undefined;
  }

  listCheckpoints(id: string): WorkflowCheckpoint[] {
    const rows = this.#database.prepare(`
      SELECT checkpoint_json
      FROM research_task_checkpoints
      WHERE task_id = ?
      ORDER BY created_at, sequence
    `).all(id) as Array<{ checkpoint_json: string }>;
    return rows.map((row) =>
      JSON.parse(row.checkpoint_json) as WorkflowCheckpoint
    );
  }

  recoverInterrupted(): number {
    const rows = this.#database.prepare(`
      SELECT id
      FROM research_tasks
      WHERE status NOT IN ('completed', 'completed_with_warnings', 'failed', 'canceled')
    `).all() as Array<{ id: string }>;
    for (const row of rows) {
      const checkpoint = this.latestCheckpoint(row.id);
      this.record(
        row.id,
        checkpoint
          ? {
              status: "recoverable",
              pendingInput: undefined,
              recovery: {
                latestRunId: checkpoint.runId,
                checkpointAt: checkpoint.createdAt,
                reason: "restart",
              },
            }
          : {
              status: "failed",
              pendingInput: undefined,
              error: restartInterruptionMessage(),
            },
        checkpoint
          ? {
              type: "task.recoverable",
              data: { reason: "restart", runId: checkpoint.runId },
            }
          : {
              type: "task.failed",
              data: { error: restartInterruptionMessage(), reason: "restart" },
            },
      );
    }
    return rows.length;
  }

  close(): void {
    this.#database.close();
  }

  #insertEvent(event: ResearchTaskEvent): void {
    this.#database.prepare(`
      INSERT INTO research_task_events(
        task_id, event_id, timestamp, type, data_json
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      event.taskId,
      event.id,
      event.timestamp,
      event.type,
      JSON.stringify(event.data),
    );
  }

  #insertDiagnostic(diagnostic: StoredResearchDiagnostic): void {
    this.#database.prepare(`
      INSERT INTO research_task_diagnostics(
        task_id, diagnostic_id, timestamp, ao_step_id,
        research_run_id, raw_type, raw_stage, data_json, truncated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      diagnostic.taskId,
      diagnostic.id,
      diagnostic.timestamp,
      diagnostic.aoStepId,
      diagnostic.researchRunId,
      diagnostic.rawType,
      diagnostic.rawStage,
      JSON.stringify(diagnostic.data),
      diagnostic.truncated ? 1 : 0,
    );
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function compareCheckpoints(
  left: WorkflowCheckpoint,
  right: WorkflowCheckpoint,
): number {
  return left.createdAt.localeCompare(right.createdAt) ||
    left.sequence - right.sequence;
}

function taskEvent(
  taskId: string,
  id: number,
  timestamp: string,
  draft: ResearchTaskEventDraft,
): ResearchTaskEvent {
  return {
    id,
    taskId,
    timestamp,
    type: draft.type,
    data: structuredClone(draft.data),
  };
}

function cloneTransition(
  snapshot: ResearchTaskSnapshot,
  event: ResearchTaskEvent,
): ResearchTaskTransition {
  return {
    snapshot: structuredClone(snapshot),
    event: structuredClone(event),
  };
}

function isTerminal(status: ResearchTaskSnapshot["status"]): boolean {
  return [
    "completed",
    "completed_with_warnings",
    "failed",
    "canceled",
  ].includes(status);
}

function restartInterruptionMessage(): string {
  return "任务因服务重启而中断，请重新提交研究任务。";
}

function normalizeDiagnosticLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(2, Math.trunc(value)) : 2_000;
}

function diagnosticOverflow(
  taskId: string,
  id: number,
  latest: ResearchDiagnosticRecord,
  droppedCount: number,
): StoredResearchDiagnostic {
  return {
    id,
    taskId,
    timestamp: latest.timestamp,
    aoStepId: "system",
    researchRunId: "diagnostics",
    rawType: "diagnostics.truncated",
    rawStage: "diagnostics.truncated",
    data: { droppedCount },
    truncated: true,
  };
}

function overflowCount(
  diagnostic: StoredResearchDiagnostic | undefined,
): number {
  const count = diagnostic?.data.droppedCount;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}
