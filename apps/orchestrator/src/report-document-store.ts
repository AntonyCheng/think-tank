import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const LegacyDatabaseSync = process.env.NODE_ENV === "production"
  ? undefined
  : createRequire(import.meta.url)("node:sqlite").DatabaseSync as typeof DatabaseSync;

export type ReportBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "quote"
  | "code"
  | "table"
  | "rule";

export interface ReportBlock {
  id: string;
  kind: ReportBlockKind;
  sourceStart: number;
  sourceEnd: number;
  markdown: string;
  text: string;
  fingerprint: string;
}

export interface ReportDocument {
  taskId: string;
  baselineMarkdown: string;
  currentMarkdown: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  blocks: ReportBlock[];
  isDirty: boolean;
  draftRevision: number;
}

export interface ReportDocumentVersion {
  taskId: string;
  version: number;
  markdown: string;
  createdAt: string;
}

export interface ReportDocumentStore {
  get(taskId: string): ReportDocument | undefined;
  getOrCreate(taskId: string, baselineMarkdown: string): ReportDocument;
  replaceBlock(input: ReportBlockReplacement): ReportDocument;
  replaceScope(input: ReportScopeReplacement): ReportDocument;
  replaceRange(input: ReportRawRangeReplacement): ReportDocument;
  listVersions(taskId: string): ReportDocumentVersion[];
  restoreVersion(input: { taskId: string; version: number; expectedVersion: number }): ReportDocument;
  applyDraftScope(input: ReportScopeReplacement): ReportDocument;
  saveDraft(input: { taskId: string; expectedVersion: number; expectedFingerprint: string; replacementMarkdown: string }): ReportDocument;
  commitDraft(input: { taskId: string; expectedVersion: number }): ReportDocument;
  discardDraft(input: { taskId: string; expectedVersion: number }): ReportDocument;
  restoreVersionToDraft(input: { taskId: string; version: number; expectedVersion: number }): ReportDocument;
  getDraft(taskId: string): ReportDocumentDraft | undefined;
  delete(taskId: string): boolean;
}

export interface ReportDocumentDraft {
  taskId: string;
  markdown: string;
  baseVersion: number;
  revision: number;
  updatedAt: string;
}

export interface ReportTransactionRunner {
  run<T>(work: () => T): T;
}

export class SqliteReportTransactionRunner implements ReportTransactionRunner {
  #depth = 0;

  constructor(private readonly database: DatabaseSync) {}

  run<T>(work: () => T): T {
    if (this.#depth > 0) return work();
    this.#depth += 1;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }
}

export interface ReportBlockReplacement {
  taskId: string;
  blockId: string;
  expectedVersion: number;
  expectedFingerprint: string;
  replacementMarkdown: string;
}

export interface ReportScopeReplacement {
  taskId: string;
  scope: "blocks" | "document" | "text";
  blockIds: string[];
  rangeStart?: number;
  rangeEnd?: number;
  expectedVersion: number;
  expectedFingerprint: string;
  replacementMarkdown: string;
  placement?: "replace" | "insert_before" | "insert_after";
}

export interface ReportRawRangeReplacement {
  taskId: string;
  start: number;
  end: number;
  expectedVersion: number;
  expectedFingerprint: string;
  replacementMarkdown: string;
}

export class ReportDocumentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportDocumentConflictError";
  }
}

export class InMemoryReportDocumentStore implements ReportDocumentStore {
  readonly #documents = new Map<string, ReportDocument>();
  readonly #versions = new Map<string, ReportDocumentVersion[]>();
  readonly #drafts = new Map<string, ReportDocumentDraft>();

  get(taskId: string): ReportDocument | undefined {
    const document = this.#documents.get(taskId);
    if (!document) return undefined;
    return materializeDocument(document, this.#drafts.get(taskId));
  }

  getOrCreate(taskId: string, baselineMarkdown: string): ReportDocument {
    assertTaskId(taskId);
    const existing = this.get(taskId);
    if (existing) return existing;
    const timestamp = new Date().toISOString();
    const document = createDocument(taskId, baselineMarkdown, timestamp);
    this.#documents.set(taskId, structuredClone(document));
    this.#versions.set(taskId, [{ taskId, version: 1, markdown: baselineMarkdown, createdAt: timestamp }]);
    return document;
  }

  replaceBlock(input: ReportBlockReplacement): ReportDocument {
    const document = this.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    const updated = replaceDocumentBlock(document, input);
    this.#documents.set(input.taskId, structuredClone(updated));
    this.#recordVersion(updated);
    return updated;
  }

  replaceScope(input: ReportScopeReplacement): ReportDocument {
    const document = this.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    const updated = replaceDocumentScope(document, input);
    this.#documents.set(input.taskId, structuredClone(updated));
    this.#recordVersion(updated);
    return updated;
  }

  replaceRange(input: ReportRawRangeReplacement): ReportDocument {
    const document = this.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    const updated = replaceDocumentRange(document, input);
    this.#documents.set(input.taskId, structuredClone(updated));
    this.#recordVersion(updated);
    return updated;
  }

  listVersions(taskId: string): ReportDocumentVersion[] {
    return structuredClone(this.#versions.get(taskId) ?? []);
  }

  restoreVersion(input: { taskId: string; version: number; expectedVersion: number }): ReportDocument {
    const document = this.get(input.taskId);
    if (!document || document.version !== input.expectedVersion) {
      throw new ReportDocumentConflictError("the report changed before version restore");
    }
    const target = this.#versions.get(input.taskId)?.find((item) => item.version === input.version);
    if (!target) throw new Error("report version was not found");
    const updated = {
      ...document,
      currentMarkdown: target.markdown,
      version: document.version + 1,
      updatedAt: new Date().toISOString(),
      blocks: parseReportBlocks(target.markdown),
    };
    this.#documents.set(input.taskId, structuredClone(updated));
    this.#recordVersion(updated);
    return updated;
  }

  applyDraftScope(input: ReportScopeReplacement): ReportDocument {
    const document = this.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    const range = validateScopeReplacement(document, input);
    return this.#setDraft(input.taskId, document, applyScopeMarkdown(document.currentMarkdown, range, input.replacementMarkdown, input.placement));
  }

  saveDraft(input: { taskId: string; expectedVersion: number; expectedFingerprint: string; replacementMarkdown: string }): ReportDocument {
    const document = this.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    if (document.version !== input.expectedVersion) throw new ReportDocumentConflictError("the report changed before the draft was saved");
    if (fingerprint(document.currentMarkdown) !== input.expectedFingerprint) throw new ReportDocumentConflictError("the report changed before the draft was saved");
    return this.#setDraft(input.taskId, document, input.replacementMarkdown);
  }

  commitDraft(input: { taskId: string; expectedVersion: number }): ReportDocument {
    const document = this.#documents.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    if (document.version !== input.expectedVersion) throw new ReportDocumentConflictError("the report changed before the draft was saved");
    const draft = this.#drafts.get(input.taskId);
    if (!draft) return this.get(input.taskId)!;
    const updated = {
      ...document,
      currentMarkdown: draft.markdown,
      version: document.version + 1,
      updatedAt: new Date().toISOString(),
      blocks: parseReportBlocks(draft.markdown),
    };
    this.#documents.set(input.taskId, structuredClone(updated));
    this.#drafts.delete(input.taskId);
    this.#recordVersion(updated);
    return materializeDocument(updated);
  }

  discardDraft(input: { taskId: string; expectedVersion: number }): ReportDocument {
    const document = this.#documents.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    if (document.version !== input.expectedVersion) throw new ReportDocumentConflictError("the report changed before the draft was discarded");
    this.#drafts.delete(input.taskId);
    return materializeDocument(document);
  }

  restoreVersionToDraft(input: { taskId: string; version: number; expectedVersion: number }): ReportDocument {
    const document = this.get(input.taskId);
    if (!document || document.version !== input.expectedVersion) throw new ReportDocumentConflictError("the report changed before version restore");
    const target = this.#versions.get(input.taskId)?.find((item) => item.version === input.version);
    if (!target) throw new Error("report version was not found");
    return this.#setDraft(input.taskId, document, target.markdown);
  }

  delete(taskId: string): boolean {
    this.#drafts.delete(taskId);
    this.#versions.delete(taskId);
    return this.#documents.delete(taskId);
  }

  hydrate(documents: ReportDocument[], versions: ReportDocumentVersion[], drafts: ReportDocumentDraft[] = []): void {
    this.#documents.clear();
    this.#versions.clear();
    this.#drafts.clear();
    for (const document of documents) {
      this.#documents.set(document.taskId, {
        ...structuredClone(document),
        blocks: parseReportBlocks(document.currentMarkdown),
        isDirty: false,
        draftRevision: 0,
      });
    }
    for (const version of versions) {
      const records = this.#versions.get(version.taskId) ?? [];
      records.push(structuredClone(version));
      this.#versions.set(version.taskId, records);
    }
    for (const draft of drafts) this.#drafts.set(draft.taskId, structuredClone(draft));
  }

  #recordVersion(document: ReportDocument): void {
    const versions = this.#versions.get(document.taskId) ?? [];
    if (!versions.some((item) => item.version === document.version)) {
      versions.push({ taskId: document.taskId, version: document.version, markdown: document.currentMarkdown, createdAt: document.updatedAt });
      this.#versions.set(document.taskId, versions);
    }
  }

  #setDraft(taskId: string, document: ReportDocument, markdown: string): ReportDocument {
    const previous = this.#drafts.get(taskId);
    const draft: ReportDocumentDraft = {
      taskId,
      markdown,
      baseVersion: document.version,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.#drafts.set(taskId, draft);
    return materializeDocument(this.#documents.get(taskId)!, draft);
  }

  getDraft(taskId: string): ReportDocumentDraft | undefined {
    const draft = this.#drafts.get(taskId);
    return draft ? structuredClone(draft) : undefined;
  }
}

export class SqliteReportDocumentStore implements ReportDocumentStore {
  readonly #database: DatabaseSync;
  readonly #ownsDatabase: boolean;

  constructor(filePath: string, database?: DatabaseSync) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!database && !LegacyDatabaseSync) throw new Error("SQLite storage is not available in production.");
    this.#database = database ?? new LegacyDatabaseSync!(filePath);
    this.#ownsDatabase = !database;
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS report_documents (
        task_id TEXT PRIMARY KEY,
        baseline_markdown TEXT NOT NULL,
        current_markdown TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS report_document_versions (
        task_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        markdown TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(task_id, version)
      );
      CREATE TABLE IF NOT EXISTS report_document_drafts (
        task_id TEXT PRIMARY KEY,
        markdown TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(taskId: string): ReportDocument | undefined {
    assertTaskId(taskId);
    const row = this.#database.prepare(`
      SELECT task_id, baseline_markdown, current_markdown, version,
             created_at, updated_at
      FROM report_documents
      WHERE task_id = ?
    `).get(taskId) as ReportDocumentRow | undefined;
    if (!row) return undefined;
    const document = documentFromRow(row);
    const draft = this.getDraft(taskId);
    return materializeDocument(document, draft);
  }

  getOrCreate(taskId: string, baselineMarkdown: string): ReportDocument {
    assertTaskId(taskId);
    const timestamp = new Date().toISOString();
    this.#database.prepare(`
      INSERT OR IGNORE INTO report_documents(
        task_id, baseline_markdown, current_markdown, version,
        created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)
    `).run(taskId, baselineMarkdown, baselineMarkdown, timestamp, timestamp);
    this.#database.prepare(`
      INSERT OR IGNORE INTO report_document_versions(task_id, version, markdown, created_at)
      VALUES (?, 1, ?, ?)
    `).run(taskId, baselineMarkdown, timestamp);
    const document = this.get(taskId);
    if (!document) throw new Error(`report document was not created: ${taskId}`);
    this.#recordVersion(document);
    return document;
  }

  replaceBlock(input: ReportBlockReplacement): ReportDocument {
    assertTaskId(input.taskId);
    const document = this.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    const updated = replaceDocumentBlock(document, input);
    this.#database.prepare(`
      UPDATE report_documents
      SET current_markdown = ?, version = ?, updated_at = ?
      WHERE task_id = ?
    `).run(
      updated.currentMarkdown,
      updated.version,
      updated.updatedAt,
      input.taskId,
    );
    this.#recordVersion(updated);
    return updated;
  }

  replaceScope(input: ReportScopeReplacement): ReportDocument {
    assertTaskId(input.taskId);
    const document = this.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    const updated = replaceDocumentScope(document, input);
    this.#database.prepare(`
      UPDATE report_documents
      SET current_markdown = ?, version = ?, updated_at = ?
      WHERE task_id = ?
    `).run(updated.currentMarkdown, updated.version, updated.updatedAt, input.taskId);
    this.#recordVersion(updated);
    return updated;
  }

  replaceRange(input: ReportRawRangeReplacement): ReportDocument {
    assertTaskId(input.taskId);
    const document = this.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    const updated = replaceDocumentRange(document, input);
    this.#database.prepare(`
      UPDATE report_documents
      SET current_markdown = ?, version = ?, updated_at = ?
      WHERE task_id = ?
    `).run(updated.currentMarkdown, updated.version, updated.updatedAt, input.taskId);
    this.#recordVersion(updated);
    return updated;
  }

  listVersions(taskId: string): ReportDocumentVersion[] {
    const rows = this.#database.prepare(`
      SELECT task_id, version, markdown, created_at
      FROM report_document_versions WHERE task_id = ? ORDER BY version DESC
    `).all(taskId) as unknown as ReportDocumentVersionRow[];
    return rows.map((row) => ({ taskId: row.task_id, version: Number(row.version), markdown: row.markdown, createdAt: row.created_at }));
  }

  restoreVersion(input: { taskId: string; version: number; expectedVersion: number }): ReportDocument {
    const document = this.get(input.taskId);
    if (!document || document.version !== input.expectedVersion) {
      throw new ReportDocumentConflictError("the report changed before version restore");
    }
    const target = this.#database.prepare(`
      SELECT task_id, version, markdown, created_at
      FROM report_document_versions WHERE task_id = ? AND version = ?
    `).get(input.taskId, input.version) as ReportDocumentVersionRow | undefined;
    if (!target) throw new Error("report version was not found");
    const updated = {
      ...document,
      currentMarkdown: target.markdown,
      version: document.version + 1,
      updatedAt: new Date().toISOString(),
      blocks: parseReportBlocks(target.markdown),
    };
    this.#database.prepare(`
      UPDATE report_documents SET current_markdown = ?, version = ?, updated_at = ? WHERE task_id = ?
    `).run(updated.currentMarkdown, updated.version, updated.updatedAt, input.taskId);
    this.#recordVersion(updated);
    return updated;
  }

  applyDraftScope(input: ReportScopeReplacement): ReportDocument {
    const document = this.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    const range = validateScopeReplacement(document, input);
    return this.#saveDraft(input.taskId, document, applyScopeMarkdown(document.currentMarkdown, range, input.replacementMarkdown, input.placement));
  }

  saveDraft(input: { taskId: string; expectedVersion: number; expectedFingerprint: string; replacementMarkdown: string }): ReportDocument {
    const document = this.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    if (document.version !== input.expectedVersion || fingerprint(document.currentMarkdown) !== input.expectedFingerprint) throw new ReportDocumentConflictError("the report changed before the draft was saved");
    return this.#saveDraft(input.taskId, document, input.replacementMarkdown);
  }

  commitDraft(input: { taskId: string; expectedVersion: number }): ReportDocument {
    const document = this.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    if (document.version !== input.expectedVersion) throw new ReportDocumentConflictError("the report changed before the draft was saved");
    const draft = this.getDraft(input.taskId);
    if (!draft) return document;
    const updated = { ...document, currentMarkdown: draft.markdown, version: document.version + 1, updatedAt: new Date().toISOString(), isDirty: false, draftRevision: 0, blocks: parseReportBlocks(draft.markdown) };
    this.#database.prepare("UPDATE report_documents SET current_markdown = ?, version = ?, updated_at = ? WHERE task_id = ?").run(updated.currentMarkdown, updated.version, updated.updatedAt, input.taskId);
    this.#database.prepare("INSERT OR REPLACE INTO report_document_versions(task_id, version, markdown, created_at) VALUES (?, ?, ?, ?)").run(input.taskId, updated.version, updated.currentMarkdown, updated.updatedAt);
    this.#database.prepare("DELETE FROM report_document_drafts WHERE task_id = ?").run(input.taskId);
    return updated;
  }

  discardDraft(input: { taskId: string; expectedVersion: number }): ReportDocument {
    const document = this.get(input.taskId);
    if (!document) throw new Error(`report document was not found: ${input.taskId}`);
    if (document.version !== input.expectedVersion) throw new ReportDocumentConflictError("the report changed before the draft was discarded");
    this.#database.prepare("DELETE FROM report_document_drafts WHERE task_id = ?").run(input.taskId);
    return this.get(input.taskId)!;
  }

  restoreVersionToDraft(input: { taskId: string; version: number; expectedVersion: number }): ReportDocument {
    const document = this.get(input.taskId);
    if (!document || document.version !== input.expectedVersion) throw new ReportDocumentConflictError("the report changed before version restore");
    const target = this.#database.prepare("SELECT markdown FROM report_document_versions WHERE task_id = ? AND version = ?").get(input.taskId, input.version) as { markdown: string } | undefined;
    if (!target) throw new Error("report version was not found");
    return this.#saveDraft(input.taskId, document, target.markdown);
  }

  getDraft(taskId: string): ReportDocumentDraft | undefined {
    const row = this.#database.prepare("SELECT task_id, markdown, base_version, revision, updated_at FROM report_document_drafts WHERE task_id = ?").get(taskId) as ReportDraftRow | undefined;
    return row ? { taskId: row.task_id, markdown: row.markdown, baseVersion: Number(row.base_version), revision: Number(row.revision), updatedAt: row.updated_at } : undefined;
  }

  delete(taskId: string): boolean {
    assertTaskId(taskId);
    const result = this.#database.prepare(`
      DELETE FROM report_documents WHERE task_id = ?
    `).run(taskId);
    this.#database.prepare("DELETE FROM report_document_versions WHERE task_id = ?").run(taskId);
    this.#database.prepare("DELETE FROM report_document_drafts WHERE task_id = ?").run(taskId);
    return Number(result.changes) > 0;
  }

  #recordVersion(document: ReportDocument): void {
    this.#database.prepare(`
      INSERT OR IGNORE INTO report_document_versions(task_id, version, markdown, created_at)
      VALUES (?, ?, ?, ?)
    `).run(document.taskId, document.version, document.currentMarkdown, document.updatedAt);
  }

  #saveDraft(taskId: string, document: ReportDocument, markdown: string): ReportDocument {
    const previous = this.getDraft(taskId);
    const draft = { taskId, markdown, baseVersion: document.version, revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    this.#database.prepare("INSERT OR REPLACE INTO report_document_drafts(task_id, markdown, base_version, revision, updated_at) VALUES (?, ?, ?, ?, ?)").run(taskId, draft.markdown, draft.baseVersion, draft.revision, draft.updatedAt);
    return this.get(taskId)!;
  }

  close(): void {
    if (this.#ownsDatabase) this.#database.close();
  }
}

interface ReportDocumentRow {
  task_id: string;
  baseline_markdown: string;
  current_markdown: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface ReportDocumentVersionRow {
  task_id: string;
  version: number;
  markdown: string;
  created_at: string;
}

interface ReportDraftRow { task_id: string; markdown: string; base_version: number; revision: number; updated_at: string; }

function createDocument(
  taskId: string,
  baselineMarkdown: string,
  timestamp: string,
): ReportDocument {
  return {
    taskId,
    baselineMarkdown,
    currentMarkdown: baselineMarkdown,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    blocks: parseReportBlocks(baselineMarkdown),
    isDirty: false,
    draftRevision: 0,
  };
}

function materializeDocument(document: ReportDocument, draft?: ReportDocumentDraft): ReportDocument {
  const effectiveDraft = draft;
  const markdown = effectiveDraft?.markdown ?? document.currentMarkdown;
  return {
    ...structuredClone(document),
    currentMarkdown: markdown,
    isDirty: Boolean(effectiveDraft),
    draftRevision: effectiveDraft?.revision ?? 0,
    blocks: parseReportBlocks(markdown),
  };
}

function validateScopeReplacement(document: ReportDocument, input: ReportScopeReplacement): ReturnType<typeof reportScopeRange> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error("document version must be a positive integer");
  if (document.version !== input.expectedVersion) throw new ReportDocumentConflictError("the report changed before this draft was created");
  const range = reportScopeRange(document, input.scope, input.blockIds, input.rangeStart, input.rangeEnd);
  if (fingerprint(range.markdown) !== input.expectedFingerprint) throw new ReportDocumentConflictError("the selected report scope changed before this draft was created");
  return range;
}

function documentFromRow(row: ReportDocumentRow): ReportDocument {
  return {
    taskId: row.task_id,
    baselineMarkdown: row.baseline_markdown,
    currentMarkdown: row.current_markdown,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blocks: parseReportBlocks(row.current_markdown),
    isDirty: false,
    draftRevision: 0,
  };
}

function replaceDocumentBlock(
  document: ReportDocument,
  input: ReportBlockReplacement,
): ReportDocument {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error("document version must be a positive integer");
  }
  if (document.version !== input.expectedVersion) {
    throw new ReportDocumentConflictError(
      "the report changed after this proposal was created",
    );
  }
  const block = document.blocks.find((item) => item.id === input.blockId);
  if (!block) {
    throw new ReportDocumentConflictError("the selected report block no longer exists");
  }
  if (block.fingerprint !== input.expectedFingerprint) {
    throw new ReportDocumentConflictError(
      "the selected report block changed after this proposal was created",
    );
  }
  if (typeof input.replacementMarkdown !== "string") {
    throw new Error("replacement markdown must be a string");
  }
  const currentMarkdown =
    document.currentMarkdown.slice(0, block.sourceStart) +
    input.replacementMarkdown +
    document.currentMarkdown.slice(block.sourceEnd);
  return {
    ...document,
    currentMarkdown,
    version: document.version + 1,
    updatedAt: new Date().toISOString(),
    blocks: parseReportBlocks(currentMarkdown),
  };
}

function replaceDocumentScope(
  document: ReportDocument,
  input: ReportScopeReplacement,
): ReportDocument {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error("document version must be a positive integer");
  }
  if (document.version !== input.expectedVersion) {
    throw new ReportDocumentConflictError("the report changed after this proposal was created");
  }
  const range = reportScopeRange(
    document,
    input.scope,
    input.blockIds,
    input.rangeStart,
    input.rangeEnd,
  );
  if (fingerprint(range.markdown) !== input.expectedFingerprint) {
    throw new ReportDocumentConflictError("the selected report scope changed after this proposal was created");
  }
  const currentMarkdown =
    document.currentMarkdown.slice(0, range.start) +
    input.replacementMarkdown +
    document.currentMarkdown.slice(range.end);
  return {
    ...document,
    currentMarkdown,
    version: document.version + 1,
    updatedAt: new Date().toISOString(),
    blocks: parseReportBlocks(currentMarkdown),
  };
}

function applyScopeMarkdown(
  currentMarkdown: string,
  range: { start: number; end: number },
  replacementMarkdown: string,
  placement: ReportScopeReplacement["placement"] = "replace",
): string {
  if (placement === "insert_before") {
    const inserted = formatReportInsertion(replacementMarkdown, placement);
    if (!inserted) throw new Error("inserted report paragraph must not be empty");
    return currentMarkdown.slice(0, range.start) + inserted + currentMarkdown.slice(range.start);
  }
  if (placement === "insert_after") {
    const inserted = formatReportInsertion(replacementMarkdown, placement);
    if (!inserted) throw new Error("inserted report paragraph must not be empty");
    return currentMarkdown.slice(0, range.end) + inserted + currentMarkdown.slice(range.end);
  }
  return currentMarkdown.slice(0, range.start) + replacementMarkdown + currentMarkdown.slice(range.end);
}

export function formatReportInsertion(value: string, placement: "insert_before" | "insert_after"): string {
  const content = value.trim();
  if (!content) return "";
  return placement === "insert_before" ? `${content}\n\n` : `\n\n${content}`;
}

function replaceDocumentRange(
  document: ReportDocument,
  input: ReportRawRangeReplacement,
): ReportDocument {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error("document version must be a positive integer");
  }
  if (document.version !== input.expectedVersion) {
    throw new ReportDocumentConflictError("the report changed after this edit was applied");
  }
  if (!Number.isInteger(input.start) || !Number.isInteger(input.end) || input.start < 0 || input.end < input.start || input.end > document.currentMarkdown.length) {
    throw new ReportDocumentConflictError("the applied report range is no longer available");
  }
  const currentMarkdown = document.currentMarkdown.slice(input.start, input.end);
  if (fingerprint(currentMarkdown) !== input.expectedFingerprint) {
    throw new ReportDocumentConflictError("the applied report range changed and cannot be restored safely");
  }
  const nextMarkdown = document.currentMarkdown.slice(0, input.start) + input.replacementMarkdown + document.currentMarkdown.slice(input.end);
  return {
    ...document,
    currentMarkdown: nextMarkdown,
    version: document.version + 1,
    updatedAt: new Date().toISOString(),
    blocks: parseReportBlocks(nextMarkdown),
  };
}

export function reportScopeRange(
  document: ReportDocument,
  scope: "blocks" | "document" | "text",
  blockIds: readonly string[],
  rangeStart?: number,
  rangeEnd?: number,
): { start: number; end: number; markdown: string; blockIds: string[] } {
  if (scope === "document") {
    return {
      start: 0,
      end: document.currentMarkdown.length,
      markdown: document.currentMarkdown,
      blockIds: [],
    };
  }
  if (scope === "text") {
    if (blockIds.length !== 1) throw new Error("text scope must target exactly one report block");
    const block = document.blocks.find((item) => item.id === blockIds[0]);
    if (!block || rangeStart === undefined || rangeEnd === undefined || !Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd)) {
      throw new ReportDocumentConflictError("the selected text range is no longer available");
    }
    if (rangeStart < 0 || rangeEnd <= rangeStart || rangeEnd > block.markdown.length) {
      throw new Error("text range is invalid");
    }
    const textStart = rangeStart;
    const textEnd = rangeEnd;
    return {
      start: block.sourceStart + textStart,
      end: block.sourceStart + textEnd,
      markdown: block.markdown.slice(textStart, textEnd),
      blockIds: [block.id],
    };
  }
  if (!blockIds.length) throw new Error("at least one report block is required");
  const indices = blockIds.map((id) => document.blocks.findIndex((block) => block.id === id));
  if (indices.some((index) => index < 0)) {
    throw new ReportDocumentConflictError("one or more selected report blocks no longer exist");
  }
  const sorted = [...indices].sort((left, right) => left - right);
  if (sorted.some((index, position) => position > 0 && index !== sorted[position - 1]! + 1)) {
    throw new Error("selected report blocks must be contiguous");
  }
  const startBlock = document.blocks[sorted[0]!];
  const endBlock = document.blocks[sorted[sorted.length - 1]!];
  return {
    start: startBlock!.sourceStart,
    end: endBlock!.sourceEnd,
    markdown: document.currentMarkdown.slice(startBlock!.sourceStart, endBlock!.sourceEnd),
    blockIds: sorted.map((index) => document.blocks[index]!.id),
  };
}

export function reportMarkdownFingerprint(value: string): string {
  return fingerprint(value);
}

export function parseReportBlocks(markdown: string): ReportBlock[] {
  const lines = markdownLines(markdown);
  const blocks: Array<Omit<ReportBlock, "id">> = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index]!.content.trim() === "") {
      index += 1;
      continue;
    }
    const start = index;
    const kind = blockKind(lines, index);
    index = consumeBlock(lines, index, kind);
    const sourceStart = lines[start]!.start;
    const sourceEnd = lines[index - 1]!.end;
    const blockMarkdown = markdown.slice(sourceStart, sourceEnd);
    blocks.push({
      kind,
      sourceStart,
      sourceEnd,
      markdown: blockMarkdown,
      text: plainText(blockMarkdown),
      fingerprint: fingerprint(blockMarkdown),
    });
  }

  const counters = new Map<ReportBlockKind, number>();
  return blocks.map((block) => {
    const ordinal = (counters.get(block.kind) ?? 0) + 1;
    counters.set(block.kind, ordinal);
    return { ...block, id: `${block.kind}-${ordinal}` };
  });
}

interface MarkdownLine {
  content: string;
  start: number;
  end: number;
}

function markdownLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  for (let index = 0; index <= markdown.length; index += 1) {
    if (index !== markdown.length && markdown[index] !== "\n") continue;
    const end = index;
    lines.push({
      content: markdown.slice(start, end),
      start,
      end,
    });
    start = index + 1;
  }
  return lines;
}

function blockKind(lines: readonly MarkdownLine[], index: number): ReportBlockKind {
  const line = lines[index]!.content;
  if (/^\s*#{1,6}\s+/u.test(line)) return "heading";
  if (/^\s*```/u.test(line)) return "code";
  if (/^\s*>/u.test(line)) return "quote";
  if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(line)) return "list";
  if (/^\s*\|/u.test(line) || /^\s*[-:]+(?:\s*\|\s*[-:]+)+\s*$/u.test(line)) {
    return "table";
  }
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) return "rule";
  return "paragraph";
}

function consumeBlock(
  lines: readonly MarkdownLine[],
  index: number,
  kind: ReportBlockKind,
): number {
  if (kind === "heading" || kind === "rule") return index + 1;
  if (kind === "code") {
    let cursor = index + 1;
    while (cursor < lines.length) {
      if (/^\s*```/u.test(lines[cursor]!.content)) return cursor + 1;
      cursor += 1;
    }
    return cursor;
  }
  let cursor = index + 1;
  while (cursor < lines.length) {
    const line = lines[cursor]!.content;
    if (line.trim() === "") break;
    if (kind === "paragraph" && blockKind(lines, cursor) !== "paragraph") break;
    if (kind === "quote" && !/^\s*>/u.test(line)) break;
    if (kind === "list" && !/^\s*(?:[-*+]\s+|\d+[.)]\s+|\s{2,})/u.test(line)) break;
    if (kind === "table" && !/^\s*\|/u.test(line)) break;
    cursor += 1;
  }
  return cursor;
}

function plainText(markdown: string): string {
  return markdown
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/gu, "$1")
    .replace(/[`*_~>#|]/gu, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(taskId)) {
    throw new Error("invalid task id");
  }
}
