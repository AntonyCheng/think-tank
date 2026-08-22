import type { PostgresDatabase } from "./postgres.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";
import {
  InMemoryReportDocumentStore,
  type ReportBlockReplacement,
  type ReportDocument,
  type ReportDocumentStore,
  type ReportDocumentVersion,
  type ReportDocumentDraft,
  type ReportRawRangeReplacement,
  type ReportScopeReplacement,
} from "./report-document-store.js";

export class PostgresReportDocumentStore implements ReportDocumentStore {
  readonly #memory = new InMemoryReportDocumentStore();
  readonly #writes: PostgresWriteQueue;

  constructor(database: PostgresDatabase) {
    this.#writes = new PostgresWriteQueue(database);
  }

  async initialize(): Promise<void> {
    const [documents, versions, drafts] = await Promise.all([
      this.#writes.connection.query<DocumentRow>("SELECT task_id, baseline_markdown, current_markdown, version, created_at::text, updated_at::text FROM report_documents"),
      this.#writes.connection.query<VersionRow>("SELECT task_id, version, markdown, created_at::text FROM report_document_versions ORDER BY task_id, version"),
      this.#writes.connection.query<DraftRow>("SELECT task_id, markdown, base_version, revision, updated_at::text FROM report_document_drafts"),
    ]);
    this.#memory.hydrate(
      documents.map((row) => ({
        taskId: row.task_id, baselineMarkdown: row.baseline_markdown,
        currentMarkdown: row.current_markdown, version: Number(row.version),
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), blocks: [], isDirty: false, draftRevision: 0,
      })),
      versions.map((row) => ({ taskId: row.task_id, version: Number(row.version), markdown: row.markdown, createdAt: iso(row.created_at) })),
      drafts.map((row) => ({ taskId: row.task_id, markdown: row.markdown, baseVersion: Number(row.base_version), revision: Number(row.revision), updatedAt: iso(row.updated_at) })),
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

  replaceRange(input: ReportRawRangeReplacement): ReportDocument {
    const document = this.#memory.replaceRange(input);
    this.#persist(document);
    return document;
  }

  listVersions(taskId: string): ReportDocumentVersion[] { return this.#memory.listVersions(taskId); }

  restoreVersion(input: { taskId: string; version: number; expectedVersion: number }): ReportDocument {
    const document = this.#memory.restoreVersion(input);
    this.#persist(document);
    return document;
  }

  applyDraftScope(input: ReportScopeReplacement): ReportDocument {
    const document = this.#memory.applyDraftScope(input);
    this.#persistDraft(document);
    return document;
  }

  saveDraft(input: { taskId: string; expectedVersion: number; expectedFingerprint: string; replacementMarkdown: string }): ReportDocument {
    const document = this.#memory.saveDraft(input);
    this.#persistDraft(document);
    return document;
  }

  commitDraft(input: { taskId: string; expectedVersion: number }): ReportDocument {
    const document = this.#memory.commitDraft(input);
    this.#persist(document);
    return document;
  }

  discardDraft(input: { taskId: string; expectedVersion: number }): ReportDocument {
    const document = this.#memory.discardDraft(input);
    this.#persistDraftRemoval(document.taskId);
    return document;
  }

  restoreVersionToDraft(input: { taskId: string; version: number; expectedVersion: number }): ReportDocument {
    const document = this.#memory.restoreVersionToDraft(input);
    this.#persistDraft(document);
    return document;
  }

  getDraft(taskId: string): ReportDocumentDraft | undefined { return this.#memory.getDraft(taskId); }

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
        await client.query("DELETE FROM report_document_drafts WHERE task_id=$1", [document.taskId]);
      });
    });
  }

  #persistDraft(document: ReportDocument): void {
    const draft = this.#memory.getDraft(document.taskId);
    if (!draft) return;
    this.#writes.enqueue(async () => {
      await this.#writes.connection.query(`INSERT INTO report_document_drafts(task_id,markdown,base_version,revision,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id) DO UPDATE SET markdown=EXCLUDED.markdown,base_version=EXCLUDED.base_version,revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at`, [draft.taskId, draft.markdown, draft.baseVersion, draft.revision, draft.updatedAt]);
    });
  }

  #persistDraftRemoval(taskId: string): void {
    this.#writes.enqueue(async () => {
      await this.#writes.connection.query("DELETE FROM report_document_drafts WHERE task_id=$1", [taskId]);
    });
  }
}

interface DocumentRow { task_id: string; baseline_markdown: string; current_markdown: string; version: number; created_at: string; updated_at: string; }
interface VersionRow { task_id: string; version: number; markdown: string; created_at: string; }
interface DraftRow { task_id: string; markdown: string; base_version: number; revision: number; updated_at: string; }

function iso(value: string): string { return new Date(value).toISOString(); }
