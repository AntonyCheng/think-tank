import type {
  EvidenceBundle,
} from "./evidence-bundle.js";
import type { PostgresDatabase } from "./postgres.js";
import { postgresJson } from "./postgres.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";
import {
  InMemoryResearchTaskStore,
  type ResearchTaskEventDraft,
  type ResearchTaskStore,
  type ResearchTaskTransition,
  type StoredResearchDiagnostic,
  type StoredResearchTask,
} from "./research-task-store.js";
import type { ResearchTaskSnapshot } from "./research-tasks.js";
import type { ResearchDiagnosticRecord } from "./research-telemetry.js";
import type { WorkflowCheckpoint } from "./workflow-checkpoint.js";

/**
 * PostgreSQL is the durable store. The small in-process cache keeps the task
 * event callbacks synchronous, while writes are serialized through pg.
 */
export class PostgresResearchTaskStore implements ResearchTaskStore {
  readonly #memory: InMemoryResearchTaskStore;
  readonly #writes: PostgresWriteQueue;

  constructor(database: PostgresDatabase, diagnosticLimit = 2_000) {
    this.#memory = new InMemoryResearchTaskStore(diagnosticLimit);
    this.#writes = new PostgresWriteQueue(database);
  }

  async initialize(): Promise<void> {
    const database = this.#writes.connection;
    const [taskRows, eventRows, diagnostics, checkpoints, bundles] = await Promise.all([
      database.query<TaskRow>("SELECT id, snapshot_json FROM research_tasks"),
      database.query<EventRow>("SELECT task_id, event_id, timestamp, type, data_json FROM research_task_events ORDER BY task_id, event_id"),
      database.query<DiagnosticRow>("SELECT task_id, diagnostic_id, timestamp, ao_step_id, research_run_id, raw_type, raw_stage, data_json, truncated FROM research_task_diagnostics ORDER BY task_id, diagnostic_id"),
      database.query<CheckpointRow>("SELECT checkpoint_json FROM research_task_checkpoints ORDER BY task_id, created_at, sequence"),
      database.query<BundleRow>("SELECT task_id, bundle_json FROM research_task_evidence_bundles ORDER BY task_id, bundle_index"),
    ]);
    const eventsByTask = new Map<string, StoredResearchTask["events"]>();
    for (const row of eventRows) {
      const events = eventsByTask.get(row.task_id) ?? [];
      events.push({ id: Number(row.event_id), taskId: row.task_id, timestamp: row.timestamp, type: row.type, data: row.data_json });
      eventsByTask.set(row.task_id, events);
    }
    const bundlesByTask = new Map<string, EvidenceBundle[]>();
    for (const row of bundles) {
      const records = bundlesByTask.get(row.task_id) ?? [];
      records.push(row.bundle_json);
      bundlesByTask.set(row.task_id, records);
    }
    this.#memory.hydrate({
      tasks: taskRows.map((row) => ({ snapshot: row.snapshot_json, events: eventsByTask.get(row.id) ?? [] })),
      diagnostics: diagnostics.map((row) => ({
        id: Number(row.diagnostic_id), taskId: row.task_id, timestamp: row.timestamp,
        aoStepId: row.ao_step_id, researchRunId: row.research_run_id,
        rawType: row.raw_type, rawStage: row.raw_stage, data: row.data_json,
        truncated: row.truncated,
      })),
      checkpoints: checkpoints.map((row) => row.checkpoint_json),
      evidenceBundles: [...bundlesByTask].map(([taskId, records]) => ({ taskId, bundles: records })),
    });
  }

  create(snapshot: ResearchTaskSnapshot, event: ResearchTaskEventDraft): ResearchTaskTransition {
    const transition = this.#memory.create(snapshot, event);
    this.#writes.enqueue(async () => {
      await this.#upsertTask(transition.snapshot);
      await this.#insertEvent(transition.event);
      await this.#replaceBundles(snapshot.id, snapshot.evidenceBundles ?? []);
    });
    return transition;
  }

  load(id: string): StoredResearchTask | undefined { return this.#memory.load(id); }
  list(): ResearchTaskSnapshot[] { return this.#memory.list(); }

  delete(id: string): boolean {
    const deleted = this.#memory.delete(id);
    if (deleted) this.#writes.enqueue(async () => {
      await this.#writes.connection.query("DELETE FROM research_tasks WHERE id = $1", [id]);
    });
    return deleted;
  }

  record(id: string, changes: Partial<ResearchTaskSnapshot>, event: ResearchTaskEventDraft): ResearchTaskTransition | undefined {
    const transition = this.#memory.record(id, changes, event);
    if (transition) this.#writes.enqueue(async () => {
      await this.#upsertTask(transition.snapshot);
      await this.#insertEvent(transition.event);
      if (changes.evidenceBundles !== undefined) await this.#replaceBundles(id, changes.evidenceBundles);
    });
    return transition;
  }

  recordDiagnostic(id: string, diagnostic: ResearchDiagnosticRecord): StoredResearchDiagnostic | undefined {
    const stored = this.#memory.recordDiagnostic(id, diagnostic);
    if (stored) this.#writes.enqueue(async () => {
      await this.#writes.connection.query(`
        INSERT INTO research_task_diagnostics(task_id, diagnostic_id, timestamp, ao_step_id, research_run_id, raw_type, raw_stage, data_json, truncated)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
        ON CONFLICT (task_id, diagnostic_id) DO UPDATE SET timestamp=EXCLUDED.timestamp, ao_step_id=EXCLUDED.ao_step_id,
          research_run_id=EXCLUDED.research_run_id, raw_type=EXCLUDED.raw_type, raw_stage=EXCLUDED.raw_stage,
          data_json=EXCLUDED.data_json, truncated=EXCLUDED.truncated
      `, [stored.taskId, stored.id, stored.timestamp, stored.aoStepId, stored.researchRunId, stored.rawType, stored.rawStage, postgresJson(stored.data), stored.truncated]);
    });
    return stored;
  }

  loadDiagnostics(id: string): StoredResearchDiagnostic[] { return this.#memory.loadDiagnostics(id); }
  loadEvidenceBundles(id: string): EvidenceBundle[] { return this.#memory.loadEvidenceBundles(id); }

  appendEvidenceBundle(id: string, bundle: EvidenceBundle): boolean {
    const appended = this.#memory.appendEvidenceBundle(id, bundle);
    const index = appended ? this.#memory.loadEvidenceBundles(id).length - 1 : -1;
    if (appended) this.#writes.enqueue(async () => {
      await this.#writes.connection.query(`INSERT INTO research_task_evidence_bundles(task_id, bundle_index, bundle_json) VALUES ($1,$2,$3::jsonb) ON CONFLICT(task_id,bundle_index) DO UPDATE SET bundle_json=EXCLUDED.bundle_json`, [id, index, postgresJson(bundle)]);
    });
    return appended;
  }

  replaceEvidenceBundles(id: string, bundles: readonly EvidenceBundle[]): boolean {
    const replaced = this.#memory.replaceEvidenceBundles(id, bundles);
    if (replaced) this.#writes.enqueue(() => this.#replaceBundles(id, bundles));
    return replaced;
  }

  saveCheckpoint(checkpoint: WorkflowCheckpoint): void {
    this.#memory.saveCheckpoint(checkpoint);
    this.#writes.enqueue(async () => {
      await this.#writes.connection.query(`INSERT INTO research_task_checkpoints(task_id,run_id,sequence,created_at,checkpoint_json) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(task_id,run_id,sequence) DO UPDATE SET created_at=EXCLUDED.created_at,checkpoint_json=EXCLUDED.checkpoint_json`, [checkpoint.taskId, checkpoint.runId, checkpoint.sequence, checkpoint.createdAt, postgresJson(checkpoint)]);
    });
  }

  latestCheckpoint(id: string): WorkflowCheckpoint | undefined { return this.#memory.latestCheckpoint(id); }
  listCheckpoints(id: string): WorkflowCheckpoint[] { return this.#memory.listCheckpoints(id); }

  recoverInterrupted(): number {
    let recovered = 0;
    for (const task of this.#memory.list()) {
      if (["completed", "completed_with_warnings", "failed", "canceled"].includes(task.status)) continue;
      const checkpoint = this.#memory.latestCheckpoint(task.id);
      this.record(task.id, checkpoint ? {
        status: "recoverable", pendingInput: undefined,
        recovery: { latestRunId: checkpoint.runId, checkpointAt: checkpoint.createdAt, reason: "restart" },
      } : { status: "failed", pendingInput: undefined, error: "任务因服务重启而中断，请重新提交研究任务。" }, checkpoint ? {
        type: "task.recoverable", data: { reason: "restart", runId: checkpoint.runId },
      } : { type: "task.failed", data: { reason: "restart", error: "任务因服务重启而中断，请重新提交研究任务。" } });
      recovered += 1;
    }
    return recovered;
  }

  async drain(): Promise<void> { await this.#writes.drain(); }

  async #upsertTask(snapshot: ResearchTaskSnapshot): Promise<void> {
    const { evidenceBundles: _evidenceBundles, ...persisted } = snapshot;
    await this.#writes.connection.query(`
      INSERT INTO research_tasks(id,status,created_at,updated_at,snapshot_json) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status, updated_at=EXCLUDED.updated_at, snapshot_json=EXCLUDED.snapshot_json
    `, [snapshot.id, snapshot.status, snapshot.createdAt, snapshot.updatedAt, postgresJson(persisted)]);
  }

  async #insertEvent(event: ResearchTaskTransition["event"]): Promise<void> {
    await this.#writes.connection.query(`INSERT INTO research_task_events(task_id,event_id,timestamp,type,data_json) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(task_id,event_id) DO NOTHING`, [event.taskId, event.id, event.timestamp, event.type, postgresJson(event.data)]);
  }

  async #replaceBundles(id: string, bundles: readonly EvidenceBundle[]): Promise<void> {
    await this.#writes.connection.transaction(async (client) => {
      await client.query("DELETE FROM research_task_evidence_bundles WHERE task_id=$1", [id]);
      for (const [index, bundle] of bundles.entries()) {
        await client.query("INSERT INTO research_task_evidence_bundles(task_id,bundle_index,bundle_json) VALUES($1,$2,$3::jsonb)", [id, index, postgresJson(bundle)]);
      }
    });
  }
}

interface TaskRow { id: string; snapshot_json: ResearchTaskSnapshot; }
interface EventRow { task_id: string; event_id: number; timestamp: string; type: ResearchTaskTransition["event"]["type"]; data_json: Record<string, unknown>; }
interface DiagnosticRow { task_id: string; diagnostic_id: number; timestamp: string; ao_step_id: string; research_run_id: string; raw_type: string; raw_stage: string; data_json: Record<string, unknown>; truncated: boolean; }
interface CheckpointRow { checkpoint_json: WorkflowCheckpoint; }
interface BundleRow { task_id: string; bundle_json: EvidenceBundle; }
