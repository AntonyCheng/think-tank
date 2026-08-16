import type { PostgresDatabase } from "./postgres.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";
import {
  InMemoryReportDocumentStore,
  type ReportBlockReplacement,
  type ReportDocument,
  type ReportDocumentStore,
  type ReportDocumentVersion,
  type ReportScopeReplacement,
} from "./report-document-store.js";

export class PostgresReportDocumentStore implements ReportDocumentStore {
  readonly #memory = new InMemoryReportDocumentStore();
  readonly #writes: PostgresWriteQueue;

  constructor(database: PostgresDatabase) {
    this.#writes = new PostgresWriteQueue(database);
  }

  async initialize(): Promise<void> {
    const [documents, versions] = await Promise.all([
      this.#writes.connection.query<DocumentRow>("SELECT task_id, baseline_markdown, current_markdown, version, created_at::text, updated_at::text FROM report_documents"),
      this.#writes.connection.query<VersionRow>("SELECT task_id, version, markdown, created_at::text FROM report_document_versions ORDER BY task_id, version"),
    ]);
    this.#memory.hydrate(
      documents.map((row) => ({
        taskId: row.task_id, baselineMarkdown: row.baseline_markdown,
        currentMarkdown: row.current_markdown, version: Number(row.version),
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), blocks: [],
      })),
      versions.map((row) => ({ taskId: row.task_id, version: Number(row.version), markdown: row.markdown, createdAt: iso(row.created_at) })),
    );
    // hydrate computes blocks through get(), preserving report editor behavior.
    for (const document of documents) this.#memory.get(document.task_id);
  }

  get(taskId: string): ReportDocument | undefined { return this.#memory.get(taskId); }

  getOrCreate(taskId: string, baselineMarkdown: string): ReportDocument {
    const existing = this.#memory.get(taskId);
    const document = this.#memory.getOrCreate(taskId, baselineMarkdown);
    if (!existing) this.#persist(document);
    return document;
  }

  replaceBlock(input: ReportBlockReplacement): ReportDocument {
    const document = this.#memory.replaceBlock(input);
    this.#persist(document);
    return document;
  }

  replaceScope(input: ReportScopeReplacement): ReportDocument {
    const document = this.#memory.replaceScope(input);
    this.#persist(document);
    return document;
  }

  listVersions(taskId: string): ReportDocumentVersion[] { return this.#memory.listVersions(taskId); }

  restoreVersion(input: { taskId: string; version: number; expectedVersion: number }): ReportDocument {
    const document = this.#memory.restoreVersion(input);
    this.#persist(document);
    return document;
  }

  delete(taskId: string): boolean {
    const deleted = this.#memory.delete(taskId);
    if (deleted) this.#writes.enqueue(async () => {
      await this.#writes.connection.query("DELETE FROM report_documents WHERE task_id=$1", [taskId]);
    });
    return deleted;
  }

  async drain(): Promise<void> { await this.#writes.drain(); }

  #persist(document: ReportDocument): void {
    const versions = this.#memory.listVersions(document.taskId);
    this.#writes.enqueue(async () => {
      await this.#writes.connection.transaction(async (client) => {
        await client.query(`INSERT INTO report_documents(task_id,baseline_markdown,current_markdown,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(task_id) DO UPDATE SET baseline_markdown=EXCLUDED.baseline_markdown,current_markdown=EXCLUDED.current_markdown,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at`, [document.taskId, document.baselineMarkdown, document.currentMarkdown, document.version, document.createdAt, document.updatedAt]);
        for (const version of versions) {
          await client.query(`INSERT INTO report_document_versions(task_id,version,markdown,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(task_id,version) DO NOTHING`, [version.taskId, version.version, version.markdown, version.createdAt]);
        }
      });
    });
  }
}

interface DocumentRow { task_id: string; baseline_markdown: string; current_markdown: string; version: number; created_at: string; updated_at: string; }
interface VersionRow { task_id: string; version: number; markdown: string; created_at: string; }

function iso(value: string): string { return new Date(value).toISOString(); }
