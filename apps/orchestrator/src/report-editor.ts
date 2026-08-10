import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  OpenAICompatibleConnector,
  type LLMConfig,
  type LLMConnector,
} from "agency-orchestrator";

import {
  ReportDocumentConflictError,
  reportMarkdownFingerprint,
  reportScopeRange,
  type ReportTransactionRunner,
  type ReportDocument,
  type ReportDocumentStore,
} from "./report-document-store.js";
import {
  auditReportCitations,
  type ReportCitationAudit,
  type ReportEditorSource,
} from "./report-editor-audit.js";

const WHOLE_DOCUMENT_CHUNK_CHARACTERS = 24_000;

export type ReportMessageRole = "user" | "assistant" | "event";
export type ReportEditOperationState = "proposed" | "applied" | "rejected" | "stale";
export type ReportEditOperationOrigin = "assistant" | "manual" | "restore";

export interface ReportConversation {
  id: string;
  taskId: string;
  blockId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReportMessage {
  id: string;
  conversationId: string;
  taskId: string;
  blockId: string;
  role: ReportMessageRole;
  content: string;
  documentVersion: number;
  blockFingerprint: string;
  createdAt: string;
}

export interface ReportEditOperation {
  id: string;
  taskId: string;
  conversationId: string;
  blockId: string;
  scope: "blocks" | "document" | "text";
  blockIds: string[];
  rangeStart?: number;
  rangeEnd?: number;
  documentVersion: number;
  originalFingerprint: string;
  originalMarkdown: string;
  replacementMarkdown: string;
  origin: ReportEditOperationOrigin;
  state: ReportEditOperationState;
  createdAt: string;
  updatedAt: string;
  appliedVersion?: number;
  undoneOperationId?: string;
  sourceIds?: string[];
}

export interface ReportSearchSession {
  id: string;
  taskId: string;
  scopeKey: string;
  query: string;
  retrievers: string[];
  createdAt: string;
}

export interface ReportSearchResult extends ReportEditorSource {
  id: string;
  sessionId: string;
  taskId: string;
  provider: string;
  snippet?: string;
  selected: boolean;
  adoptedOperationId?: string;
  createdAt: string;
}

export interface ReportEditorStore {
  listConversations(taskId: string, blockId?: string): ReportConversation[];
  getConversation(id: string): ReportConversation | undefined;
  createConversation(taskId: string, blockId: string): ReportConversation;
  listMessages(conversationId: string): ReportMessage[];
  addMessage(message: Omit<ReportMessage, "id" | "createdAt">): ReportMessage;
  getOperation(id: string): ReportEditOperation | undefined;
  listOperations(taskId: string, blockId?: string): ReportEditOperation[];
  createOperation(operation: Omit<ReportEditOperation, "id" | "createdAt" | "updatedAt">): ReportEditOperation;
  updateOperation(id: string, update: Pick<ReportEditOperation, "state" | "appliedVersion"> & Partial<Pick<ReportEditOperation, "undoneOperationId">>): ReportEditOperation;
  createSearchSession(input: Omit<ReportSearchSession, "id" | "createdAt">): ReportSearchSession;
  replaceSearchResults(sessionId: string, taskId: string, results: Array<Omit<ReportSearchResult, "id" | "sessionId" | "taskId" | "selected" | "createdAt">>): ReportSearchResult[];
  listSearchResults(taskId: string, sessionId?: string): ReportSearchResult[];
  selectSearchResults(taskId: string, sessionId: string, resultIds: string[]): ReportSearchResult[];
  selectedSearchResults(taskId: string, resultIds: string[]): ReportSearchResult[];
  adoptSearchResults(taskId: string, operationId: string, resultIds: string[]): void;
  adoptedSearchResults(taskId: string): ReportSearchResult[];
  deleteTask(taskId: string): void;
}

export interface ReportEditorModelInput {
  blockMarkdown: string;
  instruction: string;
  previousMarkdown?: string;
  nextMarkdown?: string;
  conversationHistory?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  sources?: ReportEditorSource[];
}

export interface ReportEditorRewrite {
  replacementMarkdown: string;
  reply?: string;
}

export interface ReportEditorModel {
  rewrite(input: ReportEditorModelInput): Promise<string | ReportEditorRewrite>;
}

export class OpenAIReportEditorModel implements ReportEditorModel {
  readonly #connector: LLMConnector;
  readonly #config: LLMConfig;

  constructor(config: LLMConfig, connector?: LLMConnector) {
    this.#config = config;
    this.#connector = connector ?? new OpenAICompatibleConnector({
      apiKey: config.api_key,
      baseUrl: config.base_url,
    });
  }

  async rewrite(input: ReportEditorModelInput): Promise<ReportEditorRewrite> {
    const result = await this.#connector.chat(
      [
        "You edit exactly one writable Markdown scope in a research report.",
        "Return a JSON object with exactly these fields: replacementMarkdown and reply.",
        "replacementMarkdown must contain only the complete replacement Markdown for the writable scope.",
        "When the user asks to delete the writable scope, replacementMarkdown must be an empty string.",
        "reply must be a concise, natural-language response in the user's language, under 240 characters.",
        "The reply should acknowledge the request, summarize the intended change, and say that a preview is ready.",
        "The surrounding context is read-only and must not be reproduced.",
        "Keep citations and Markdown syntax when they remain applicable.",
      ].join("\n"),
      [
        "Writable scope:",
        input.blockMarkdown,
        "\nUser instruction:",
        input.instruction,
        input.previousMarkdown ? `\nRead-only preceding block:\n${input.previousMarkdown}` : "",
        input.nextMarkdown ? `\nRead-only following block:\n${input.nextMarkdown}` : "",
        input.conversationHistory?.length
          ? `\nConversation history (for context only):\n${input.conversationHistory
              .map((message) => `${message.role}: ${message.content}`)
              .join("\n")}`
          : "",
        input.sources?.length
          ? `\nSelected verified sources (cite relevant claims with these Markdown links only):\n${input.sources.map((source) => `- [${source.title}](${source.url})`).join("\n")}`
          : "",
      ].filter(Boolean).join("\n"),
      this.#config,
    );
    const parsed = parseRewriteResult(result.content.trim());
    const replacement = removeMarkdownFence(parsed.replacementMarkdown);
    return { replacementMarkdown: replacement, reply: parsed.reply };
  }
}

export class UnavailableReportEditorModel implements ReportEditorModel {
  async rewrite(): Promise<string> {
    throw new Error("report editing requires configured model settings");
  }
}

export class InMemoryReportEditorStore implements ReportEditorStore {
  readonly #conversations = new Map<string, ReportConversation>();
  readonly #messages = new Map<string, ReportMessage[]>();
  readonly #operations = new Map<string, ReportEditOperation>();
  readonly #searchSessions = new Map<string, ReportSearchSession>();
  readonly #searchResults = new Map<string, ReportSearchResult>();

  listConversations(taskId: string, blockId?: string): ReportConversation[] {
    return [...this.#conversations.values()]
      .filter((item) => item.taskId === taskId && (!blockId || item.blockId === blockId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((item) => structuredClone(item));
  }

  getConversation(id: string): ReportConversation | undefined {
    const value = this.#conversations.get(id);
    return value ? structuredClone(value) : undefined;
  }

  createConversation(taskId: string, blockId: string): ReportConversation {
    const timestamp = new Date().toISOString();
    const conversation = { id: randomUUID(), taskId, blockId, createdAt: timestamp, updatedAt: timestamp };
    this.#conversations.set(conversation.id, conversation);
    return structuredClone(conversation);
  }

  listMessages(conversationId: string): ReportMessage[] {
    return structuredClone(this.#messages.get(conversationId) ?? []);
  }

  addMessage(message: Omit<ReportMessage, "id" | "createdAt">): ReportMessage {
    const created = { ...message, id: randomUUID(), createdAt: new Date().toISOString() };
    this.#messages.set(created.conversationId, [...(this.#messages.get(created.conversationId) ?? []), created]);
    this.#touchConversation(created.conversationId, created.createdAt);
    return structuredClone(created);
  }

  getOperation(id: string): ReportEditOperation | undefined {
    const value = this.#operations.get(id);
    return value ? structuredClone(value) : undefined;
  }

  listOperations(taskId: string, blockId?: string): ReportEditOperation[] {
    return [...this.#operations.values()]
      .filter((item) => item.taskId === taskId && (!blockId || item.blockId === blockId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((item) => structuredClone(item));
  }

  createOperation(operation: Omit<ReportEditOperation, "id" | "createdAt" | "updatedAt">): ReportEditOperation {
    const timestamp = new Date().toISOString();
    const created = { ...operation, id: randomUUID(), createdAt: timestamp, updatedAt: timestamp };
    this.#operations.set(created.id, created);
    return structuredClone(created);
  }

  updateOperation(id: string, update: Pick<ReportEditOperation, "state" | "appliedVersion"> & Partial<Pick<ReportEditOperation, "undoneOperationId">>): ReportEditOperation {
    const existing = this.#operations.get(id);
    if (!existing) throw new Error("report edit operation was not found");
    const updated = { ...existing, ...update, updatedAt: new Date().toISOString() };
    this.#operations.set(id, updated);
    return structuredClone(updated);
  }

  createSearchSession(input: Omit<ReportSearchSession, "id" | "createdAt">): ReportSearchSession {
    const session = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.#searchSessions.set(session.id, session);
    return structuredClone(session);
  }

  replaceSearchResults(sessionId: string, taskId: string, results: Array<Omit<ReportSearchResult, "id" | "sessionId" | "taskId" | "selected" | "createdAt">>): ReportSearchResult[] {
    for (const [id, result] of this.#searchResults) {
      if (result.sessionId === sessionId) this.#searchResults.delete(id);
    }
    const createdAt = new Date().toISOString();
    const created = results.map((result) => ({ ...result, id: randomUUID(), sessionId, taskId, selected: false, createdAt }));
    for (const result of created) this.#searchResults.set(result.id, result);
    return structuredClone(created);
  }

  listSearchResults(taskId: string, sessionId?: string): ReportSearchResult[] {
    return [...this.#searchResults.values()]
      .filter((item) => item.taskId === taskId && (!sessionId || item.sessionId === sessionId))
      .map((item) => structuredClone(item));
  }

  selectSearchResults(taskId: string, sessionId: string, resultIds: string[]): ReportSearchResult[] {
    const requested = new Set(resultIds);
    for (const [id, result] of this.#searchResults) {
      if (result.taskId === taskId && result.sessionId === sessionId) {
        this.#searchResults.set(id, { ...result, selected: requested.has(id) });
      }
    }
    return this.listSearchResults(taskId, sessionId);
  }

  selectedSearchResults(taskId: string, resultIds: string[]): ReportSearchResult[] {
    const requested = new Set(resultIds);
    return this.listSearchResults(taskId).filter((item) => item.selected && requested.has(item.id));
  }

  adoptSearchResults(taskId: string, operationId: string, resultIds: string[]): void {
    for (const result of this.selectedSearchResults(taskId, resultIds)) {
      this.#searchResults.set(result.id, { ...result, adoptedOperationId: operationId });
    }
  }

  adoptedSearchResults(taskId: string): ReportSearchResult[] {
    return this.listSearchResults(taskId).filter((item) => item.adoptedOperationId);
  }

  deleteTask(taskId: string): void {
    for (const conversation of this.listConversations(taskId)) {
      this.#conversations.delete(conversation.id);
      this.#messages.delete(conversation.id);
    }
    for (const [id, operation] of this.#operations) {
      if (operation.taskId === taskId) this.#operations.delete(id);
    }
    for (const [id, session] of this.#searchSessions) {
      if (session.taskId === taskId) this.#searchSessions.delete(id);
    }
    for (const [id, result] of this.#searchResults) {
      if (result.taskId === taskId) this.#searchResults.delete(id);
    }
  }

  #touchConversation(id: string, updatedAt: string): void {
    const conversation = this.#conversations.get(id);
    if (conversation) this.#conversations.set(id, { ...conversation, updatedAt });
  }
}

export class SqliteReportEditorStore implements ReportEditorStore {
  readonly #database: DatabaseSync;
  readonly #ownsDatabase: boolean;

  constructor(filePath: string, database?: DatabaseSync) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.#database = database ?? new DatabaseSync(filePath);
    this.#ownsDatabase = !database;
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS report_conversations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS report_conversations_task_block
        ON report_conversations(task_id, block_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS report_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        document_version INTEGER NOT NULL,
        block_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS report_messages_conversation
        ON report_messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS report_edit_operations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        document_version INTEGER NOT NULL,
        original_fingerprint TEXT NOT NULL,
        original_markdown TEXT NOT NULL,
        replacement_markdown TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'assistant',
        range_start INTEGER,
        range_end INTEGER,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        applied_version INTEGER,
        undone_operation_id TEXT,
        scope TEXT NOT NULL DEFAULT 'blocks',
        block_ids TEXT NOT NULL DEFAULT '[]',
        source_ids TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS report_edit_operations_task
        ON report_edit_operations(task_id, created_at);
      CREATE TABLE IF NOT EXISTS report_search_sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        query TEXT NOT NULL,
        retrievers TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS report_search_results (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        snippet TEXT,
        selected INTEGER NOT NULL DEFAULT 0,
        adopted_operation_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS report_search_results_task_session
        ON report_search_results(task_id, session_id, created_at);
    `);
    ensureColumn(this.#database, "report_edit_operations", "scope", "TEXT NOT NULL DEFAULT 'blocks'");
    ensureColumn(this.#database, "report_edit_operations", "block_ids", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(this.#database, "report_edit_operations", "origin", "TEXT NOT NULL DEFAULT 'assistant'");
    ensureColumn(this.#database, "report_edit_operations", "range_start", "INTEGER");
    ensureColumn(this.#database, "report_edit_operations", "range_end", "INTEGER");
    ensureColumn(this.#database, "report_edit_operations", "source_ids", "TEXT NOT NULL DEFAULT '[]'");
  }

  listConversations(taskId: string, blockId?: string): ReportConversation[] {
    const rows = blockId
      ? this.#database.prepare(`
          SELECT id, task_id, block_id, created_at, updated_at
          FROM report_conversations WHERE task_id = ? AND block_id = ?
          ORDER BY updated_at DESC
        `).all(taskId, blockId)
      : this.#database.prepare(`
          SELECT id, task_id, block_id, created_at, updated_at
          FROM report_conversations WHERE task_id = ? ORDER BY updated_at DESC
        `).all(taskId);
    return (rows as unknown as ReportConversationRow[]).map(conversationFromRow);
  }

  getConversation(id: string): ReportConversation | undefined {
    const row = this.#database.prepare(`
      SELECT id, task_id, block_id, created_at, updated_at
      FROM report_conversations WHERE id = ?
    `).get(id) as ReportConversationRow | undefined;
    return row ? conversationFromRow(row) : undefined;
  }

  createConversation(taskId: string, blockId: string): ReportConversation {
    const timestamp = new Date().toISOString();
    const conversation: ReportConversation = {
      id: randomUUID(), taskId, blockId, createdAt: timestamp, updatedAt: timestamp,
    };
    this.#database.prepare(`
      INSERT INTO report_conversations(id, task_id, block_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(conversation.id, taskId, blockId, timestamp, timestamp);
    return conversation;
  }

  listMessages(conversationId: string): ReportMessage[] {
    const rows = this.#database.prepare(`
      SELECT id, conversation_id, task_id, block_id, role, content,
             document_version, block_fingerprint, created_at
      FROM report_messages WHERE conversation_id = ? ORDER BY created_at, rowid
    `).all(conversationId) as unknown as ReportMessageRow[];
    return rows.map(messageFromRow);
  }

  addMessage(message: Omit<ReportMessage, "id" | "createdAt">): ReportMessage {
    const createdAt = new Date().toISOString();
    const created: ReportMessage = { ...message, id: randomUUID(), createdAt };
    this.#database.prepare(`
      INSERT INTO report_messages(
        id, conversation_id, task_id, block_id, role, content,
        document_version, block_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      created.id, created.conversationId, created.taskId, created.blockId,
      created.role, created.content, created.documentVersion,
      created.blockFingerprint, created.createdAt,
    );
    this.#database.prepare(`
      UPDATE report_conversations SET updated_at = ? WHERE id = ?
    `).run(createdAt, created.conversationId);
    return created;
  }

  getOperation(id: string): ReportEditOperation | undefined {
    const row = this.#database.prepare(`
      SELECT id, task_id, conversation_id, block_id, scope, block_ids, range_start, range_end, document_version,
             original_fingerprint, original_markdown, replacement_markdown,
             origin, state, created_at, updated_at, applied_version, undone_operation_id, source_ids
      FROM report_edit_operations WHERE id = ?
    `).get(id) as ReportEditOperationRow | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  listOperations(taskId: string, blockId?: string): ReportEditOperation[] {
    const rows = blockId
      ? this.#database.prepare(`
          SELECT id, task_id, conversation_id, block_id, scope, block_ids, range_start, range_end, document_version,
                 original_fingerprint, original_markdown, replacement_markdown,
                 origin, state, created_at, updated_at, applied_version, undone_operation_id, source_ids
          FROM report_edit_operations WHERE task_id = ? AND block_id = ?
          ORDER BY created_at DESC
        `).all(taskId, blockId)
      : this.#database.prepare(`
          SELECT id, task_id, conversation_id, block_id, scope, block_ids, range_start, range_end, document_version,
                 original_fingerprint, original_markdown, replacement_markdown,
                 origin, state, created_at, updated_at, applied_version, undone_operation_id, source_ids
          FROM report_edit_operations WHERE task_id = ? ORDER BY created_at DESC
        `).all(taskId);
    return (rows as unknown as ReportEditOperationRow[]).map(operationFromRow);
  }

  createOperation(operation: Omit<ReportEditOperation, "id" | "createdAt" | "updatedAt">): ReportEditOperation {
    const timestamp = new Date().toISOString();
    const created: ReportEditOperation = {
      ...operation, id: randomUUID(), createdAt: timestamp, updatedAt: timestamp,
    };
    this.#database.prepare(`
      INSERT INTO report_edit_operations(
        id, task_id, conversation_id, block_id, scope, block_ids, range_start, range_end, document_version,
        original_fingerprint, original_markdown, replacement_markdown, origin,
        state, created_at, updated_at, applied_version, undone_operation_id, source_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      created.id, created.taskId, created.conversationId, created.blockId, created.scope,
      JSON.stringify(created.blockIds), created.rangeStart ?? null, created.rangeEnd ?? null, created.documentVersion, created.originalFingerprint, created.originalMarkdown,
      created.replacementMarkdown, created.origin, created.state, created.createdAt, created.updatedAt,
      created.appliedVersion ?? null, created.undoneOperationId ?? null, JSON.stringify(created.sourceIds ?? []),
    );
    return created;
  }

  updateOperation(id: string, update: Pick<ReportEditOperation, "state" | "appliedVersion"> & Partial<Pick<ReportEditOperation, "undoneOperationId">>): ReportEditOperation {
    const previous = this.getOperation(id);
    if (!previous) throw new Error("report edit operation was not found");
    const updated: ReportEditOperation = {
      ...previous,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    this.#database.prepare(`
      UPDATE report_edit_operations
      SET state = ?, applied_version = ?, undone_operation_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updated.state,
      updated.appliedVersion ?? null,
      updated.undoneOperationId ?? null,
      updated.updatedAt,
      id,
    );
    return updated;
  }

  createSearchSession(input: Omit<ReportSearchSession, "id" | "createdAt">): ReportSearchSession {
    const session: ReportSearchSession = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.#database.prepare(`
      INSERT INTO report_search_sessions(id, task_id, scope_key, query, retrievers, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(session.id, session.taskId, session.scopeKey, session.query, JSON.stringify(session.retrievers), session.createdAt);
    return session;
  }

  replaceSearchResults(sessionId: string, taskId: string, results: Array<Omit<ReportSearchResult, "id" | "sessionId" | "taskId" | "selected" | "createdAt">>): ReportSearchResult[] {
    this.#database.prepare("DELETE FROM report_search_results WHERE session_id = ? AND task_id = ?").run(sessionId, taskId);
    const createdAt = new Date().toISOString();
    const insert = this.#database.prepare(`
      INSERT INTO report_search_results(id, session_id, task_id, provider, title, url, snippet, selected, adopted_operation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
    `);
    const created = results.map((result) => ({ ...result, id: randomUUID(), sessionId, taskId, selected: false, createdAt }));
    for (const result of created) {
      insert.run(result.id, result.sessionId, result.taskId, result.provider, result.title, result.url, result.snippet ?? null, result.createdAt);
    }
    return created;
  }

  listSearchResults(taskId: string, sessionId?: string): ReportSearchResult[] {
    const rows = sessionId
      ? this.#database.prepare(`SELECT id, session_id, task_id, provider, title, url, snippet, selected, adopted_operation_id, created_at FROM report_search_results WHERE task_id = ? AND session_id = ? ORDER BY rowid`).all(taskId, sessionId)
      : this.#database.prepare(`SELECT id, session_id, task_id, provider, title, url, snippet, selected, adopted_operation_id, created_at FROM report_search_results WHERE task_id = ? ORDER BY rowid DESC`).all(taskId);
    return (rows as unknown as ReportSearchResultRow[]).map(searchResultFromRow);
  }

  selectSearchResults(taskId: string, sessionId: string, resultIds: string[]): ReportSearchResult[] {
    const requested = new Set(resultIds);
    const rows = this.listSearchResults(taskId, sessionId);
    const update = this.#database.prepare("UPDATE report_search_results SET selected = ? WHERE id = ? AND task_id = ? AND session_id = ?");
    for (const result of rows) update.run(requested.has(result.id) ? 1 : 0, result.id, taskId, sessionId);
    return this.listSearchResults(taskId, sessionId);
  }

  selectedSearchResults(taskId: string, resultIds: string[]): ReportSearchResult[] {
    const requested = new Set(resultIds);
    return this.listSearchResults(taskId).filter((result) => result.selected && requested.has(result.id));
  }

  adoptSearchResults(taskId: string, operationId: string, resultIds: string[]): void {
    const update = this.#database.prepare("UPDATE report_search_results SET adopted_operation_id = ? WHERE id = ? AND task_id = ? AND selected = 1");
    for (const resultId of resultIds) update.run(operationId, resultId, taskId);
  }

  adoptedSearchResults(taskId: string): ReportSearchResult[] {
    return this.listSearchResults(taskId).filter((result) => Boolean(result.adoptedOperationId));
  }

  deleteTask(taskId: string): void {
    this.#database.exec("BEGIN");
    try {
      this.#database.prepare("DELETE FROM report_edit_operations WHERE task_id = ?").run(taskId);
      this.#database.prepare("DELETE FROM report_messages WHERE task_id = ?").run(taskId);
      this.#database.prepare("DELETE FROM report_conversations WHERE task_id = ?").run(taskId);
      this.#database.prepare("DELETE FROM report_search_results WHERE task_id = ?").run(taskId);
      this.#database.prepare("DELETE FROM report_search_sessions WHERE task_id = ?").run(taskId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.#ownsDatabase) this.#database.close();
  }
}

interface ReportConversationRow {
  id: string;
  task_id: string;
  block_id: string;
  created_at: string;
  updated_at: string;
}

interface ReportMessageRow {
  id: string;
  conversation_id: string;
  task_id: string;
  block_id: string;
  role: ReportMessageRole;
  content: string;
  document_version: number;
  block_fingerprint: string;
  created_at: string;
}

interface ReportEditOperationRow {
  id: string;
  task_id: string;
  conversation_id: string;
  block_id: string;
  scope: "blocks" | "document" | "text";
  block_ids: string;
  range_start: number | null;
  range_end: number | null;
  document_version: number;
  original_fingerprint: string;
  original_markdown: string;
  replacement_markdown: string;
  origin: ReportEditOperationOrigin | null;
  state: ReportEditOperationState;
  created_at: string;
  updated_at: string;
  applied_version: number | null;
  undone_operation_id: string | null;
  source_ids: string | null;
}

interface ReportSearchResultRow {
  id: string;
  session_id: string;
  task_id: string;
  provider: string;
  title: string;
  url: string;
  snippet: string | null;
  selected: number;
  adopted_operation_id: string | null;
  created_at: string;
}

function conversationFromRow(row: ReportConversationRow): ReportConversation {
  return { id: row.id, taskId: row.task_id, blockId: row.block_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

function messageFromRow(row: ReportMessageRow): ReportMessage {
  return {
    id: row.id, conversationId: row.conversation_id, taskId: row.task_id,
    blockId: row.block_id, role: row.role, content: row.content,
    documentVersion: Number(row.document_version), blockFingerprint: row.block_fingerprint,
    createdAt: row.created_at,
  };
}

function operationFromRow(row: ReportEditOperationRow): ReportEditOperation {
  return {
    id: row.id, taskId: row.task_id, conversationId: row.conversation_id,
    blockId: row.block_id, scope: row.scope ?? "blocks", blockIds: parseBlockIds(row.block_ids, row.block_id),
    ...(row.range_start === null ? {} : { rangeStart: Number(row.range_start) }),
    ...(row.range_end === null ? {} : { rangeEnd: Number(row.range_end) }),
    documentVersion: Number(row.document_version),
    originalFingerprint: row.original_fingerprint, originalMarkdown: row.original_markdown,
    replacementMarkdown: row.replacement_markdown, origin: row.origin ?? "assistant", state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.applied_version === null ? {} : { appliedVersion: Number(row.applied_version) }),
    ...(row.undone_operation_id === null ? {} : { undoneOperationId: row.undone_operation_id }),
    ...(parseStringArray(row.source_ids).length ? { sourceIds: parseStringArray(row.source_ids) } : {}),
  };
}

function searchResultFromRow(row: ReportSearchResultRow): ReportSearchResult {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    provider: row.provider,
    title: row.title,
    url: row.url,
    ...(row.snippet ? { snippet: row.snippet } : {}),
    selected: Boolean(row.selected),
    ...(row.adopted_operation_id ? { adoptedOperationId: row.adopted_operation_id } : {}),
    createdAt: row.created_at,
  };
}

function parseBlockIds(value: string | undefined, fallback: string): string[] {
  const parsed = parseStringArray(value);
  if (parsed.length || value === "[]") return parsed;
  return fallback === "document" ? [] : [fallback];
}

function parseStringArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {}
  return [];
}

function ensureColumn(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export class ReportEditorService {
  constructor(
    private readonly documents: ReportDocumentStore,
    private readonly store: ReportEditorStore,
    private readonly model: ReportEditorModel,
    private readonly transactions: ReportTransactionRunner = { run: (work) => work() },
  ) {}

  conversations(taskId: string, blockId?: string): Array<ReportConversation & { messages: ReportMessage[] }> {
    return this.store.listConversations(taskId, blockId).map((conversation) => ({
      ...conversation,
      messages: this.store.listMessages(conversation.id),
    }));
  }

  operations(taskId: string, blockId?: string): ReportEditOperation[] {
    return this.store.listOperations(taskId, blockId);
  }

  async propose(input: {
    taskId: string;
    scope?: "blocks" | "document" | "text";
    blockId?: string;
    blockIds?: string[];
    rangeStart?: number;
    rangeEnd?: number;
    documentVersion: number;
    originalFingerprint?: string;
    originalText?: string;
    instruction: string;
    conversationId?: string;
    sourceIds?: string[];
  }): Promise<{ conversation: ReportConversation; operation: ReportEditOperation; document: ReportDocument; summary: string }> {
    const scope = input.scope ?? "blocks";
    const blockIds = input.blockIds?.length ? input.blockIds : input.blockId ? [input.blockId] : [];
    const { document, range } = this.#requireCurrentScope({ ...input, scope, blockIds });
    const scopeKey = scope === "document" ? "document" : range.blockIds.join(",");
    const conversation = this.#resolveConversation(input.taskId, scopeKey, input.conversationId);
    const selectedSources = input.sourceIds?.length
      ? this.store.selectedSearchResults(input.taskId, input.sourceIds)
      : [];
    if (selectedSources.length !== (input.sourceIds?.length ?? 0)) {
      throw new Error("selected report sources are no longer available");
    }
    const conversationHistory = this.store.listMessages(conversation.id)
      .filter((message): message is ReportMessage & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant")
      .slice(-10)
      .map((message) => ({ role: message.role, content: message.content }));
    for (const pending of this.store.listOperations(input.taskId, scopeKey)) {
      if (pending.state !== "proposed") continue;
      const superseded = this.store.updateOperation(pending.id, {
        state: "rejected",
        appliedVersion: undefined,
      });
      this.#addEvent(superseded, document, "已用新的修改要求替代上一份预览。");
    }
    this.store.addMessage({
      conversationId: conversation.id,
      taskId: input.taskId,
      blockId: scopeKey,
      role: "user",
      content: input.instruction,
      documentVersion: input.documentVersion,
      blockFingerprint: reportMarkdownFingerprint(range.markdown),
    });
    this.store.addMessage({
      conversationId: conversation.id,
      taskId: input.taskId,
      blockId: scopeKey,
      role: "event",
      content: `已理解修改范围：${scope === "document" ? "整篇报告" : `连续 ${range.blockIds.length} 个内容块`}。正在生成修改建议。`,
      documentVersion: input.documentVersion,
      blockFingerprint: reportMarkdownFingerprint(range.markdown),
    });
    const rewrite = await this.#rewriteScope({
      document,
      range,
      scope,
      instruction: input.instruction,
      conversationHistory,
      sources: selectedSources,
    });
    const assistantReply = rewrite.reply?.trim() || buildProposalReply(scope, range.blockIds.length);
    const replacementMarkdown = rewrite.replacementMarkdown;
    this.store.addMessage({
      conversationId: conversation.id,
      taskId: input.taskId,
      blockId: scopeKey,
      role: "assistant",
      content: assistantReply,
      documentVersion: input.documentVersion,
      blockFingerprint: reportMarkdownFingerprint(range.markdown),
    });
    const operation = this.store.createOperation({
      taskId: input.taskId,
      conversationId: conversation.id,
      blockId: scopeKey,
      scope,
      blockIds: range.blockIds,
      ...(scope === "text" ? { rangeStart: input.rangeStart, rangeEnd: input.rangeEnd } : {}),
      documentVersion: input.documentVersion,
      originalFingerprint: reportMarkdownFingerprint(range.markdown),
      originalMarkdown: range.markdown,
      replacementMarkdown,
      origin: "assistant",
      ...(selectedSources.length ? { sourceIds: selectedSources.map((source) => source.id) } : {}),
      state: "proposed",
    });
    return { conversation, operation, document, summary: assistantReply };
  }

  audit(taskId: string, sources: readonly ReportEditorSource[]): ReportCitationAudit {
    const document = this.documents.get(taskId);
    if (!document) throw new Error("report document was not found");
    const adopted = this.store.adoptedSearchResults(taskId);
    return auditReportCitations(document.currentMarkdown, document.version, [
      ...sources,
      ...adopted,
    ]);
  }

  recordSearch(input: {
    taskId: string;
    scopeKey: string;
    query: string;
    retrievers: string[];
    results: Array<Omit<ReportSearchResult, "id" | "sessionId" | "taskId" | "selected" | "createdAt">>;
  }): { session: ReportSearchSession; results: ReportSearchResult[] } {
    const session = this.store.createSearchSession({
      taskId: input.taskId,
      scopeKey: input.scopeKey,
      query: input.query,
      retrievers: input.retrievers,
    });
    return { session, results: this.store.replaceSearchResults(session.id, input.taskId, input.results) };
  }

  selectSearchResults(taskId: string, sessionId: string, resultIds: string[]): ReportSearchResult[] {
    return this.store.selectSearchResults(taskId, sessionId, resultIds);
  }

  apply(taskId: string, operationId: string): { operation: ReportEditOperation; document: ReportDocument } {
    return this.transactions.run(() => {
    const operation = this.#requireProposedOperation(taskId, operationId);
    try {
      const document = this.documents.replaceScope({
        taskId,
        scope: operation.scope,
        blockIds: operation.blockIds,
        ...(operation.scope === "text" ? { rangeStart: operation.rangeStart, rangeEnd: operation.rangeEnd } : {}),
        expectedVersion: operation.documentVersion,
        expectedFingerprint: operation.originalFingerprint,
        replacementMarkdown: operation.replacementMarkdown,
      });
      const updated = this.store.updateOperation(operation.id, {
        state: "applied",
        appliedVersion: document.version,
      });
      if (updated.sourceIds?.length) {
        this.store.adoptSearchResults(taskId, updated.id, updated.sourceIds);
      }
      this.#addEvent(
        updated,
        document,
        `修改已完成：已更新${updated.scope === "document" ? "整篇报告" : `${updated.blockIds.length} 个内容块`}，当前版本为 ${document.version}。范围外内容保持不变。`,
      );
      return { operation: updated, document };
    } catch (error) {
      if (error instanceof ReportDocumentConflictError) {
        this.store.updateOperation(operation.id, { state: "stale", appliedVersion: undefined });
      }
      throw error;
    }
    });
  }

  reject(taskId: string, operationId: string): ReportEditOperation {
    const operation = this.#requireProposedOperation(taskId, operationId);
    const updated = this.store.updateOperation(operation.id, {
      state: "rejected",
      appliedVersion: undefined,
    });
    const document = this.documents.get(taskId);
    if (document) this.#addEvent(updated, document, "已放弃此局部修改。");
    return updated;
  }

  saveManual(input: {
    taskId: string;
    scope?: "blocks" | "document" | "text";
    blockIds?: string[];
    rangeStart?: number;
    rangeEnd?: number;
    documentVersion: number;
    originalFingerprint?: string;
    originalText?: string;
    replacementMarkdown: string;
  }): { operation: ReportEditOperation; document: ReportDocument; conversation: ReportConversation } {
    return this.transactions.run(() => {
    const scope = input.scope ?? "blocks";
    const { document: current, range } = this.#requireCurrentScope({
      ...input,
      scope,
      blockIds: input.blockIds ?? [],
    });
    const scopeKey = scope === "document" ? "document" : range.blockIds.join(",");
    const conversation = this.#resolveConversation(input.taskId, scopeKey);
    const document = this.documents.replaceScope({
      taskId: input.taskId,
      scope,
      blockIds: range.blockIds,
      ...(scope === "text" ? { rangeStart: input.rangeStart, rangeEnd: input.rangeEnd } : {}),
      expectedVersion: current.version,
      expectedFingerprint: reportMarkdownFingerprint(range.markdown),
      replacementMarkdown: input.replacementMarkdown,
    });
    const operation = this.store.createOperation({
      taskId: input.taskId,
      conversationId: conversation.id,
      blockId: scopeKey,
      scope,
      blockIds: range.blockIds,
      ...(scope === "text" ? { rangeStart: input.rangeStart, rangeEnd: input.rangeEnd } : {}),
      documentVersion: current.version,
      originalFingerprint: reportMarkdownFingerprint(range.markdown),
      originalMarkdown: range.markdown,
      replacementMarkdown: input.replacementMarkdown,
      origin: "manual",
      state: "applied",
      appliedVersion: document.version,
    });
    this.#addEvent(
      operation,
      document,
      `已手动保存${scope === "document" ? "整篇报告" : `${range.blockIds.length} 个内容块`}，当前版本为 ${document.version}。`,
    );
    return { operation, document, conversation };
    });
  }

  restoreVersion(input: {
    taskId: string;
    version: number;
    expectedVersion: number;
  }): { operation: ReportEditOperation; document: ReportDocument } {
    return this.transactions.run(() => {
    const current = this.documents.get(input.taskId);
    if (!current || current.version !== input.expectedVersion) {
      throw new ReportDocumentConflictError("the report changed before version restore");
    }
    const target = this.documents.listVersions(input.taskId).find((item) => item.version === input.version);
    if (!target) throw new Error("report version was not found");
    const conversation = this.#resolveConversation(input.taskId, "document");
    const document = this.documents.restoreVersion(input);
    const operation = this.store.createOperation({
      taskId: input.taskId,
      conversationId: conversation.id,
      blockId: "document",
      scope: "document",
      blockIds: [],
      documentVersion: current.version,
      originalFingerprint: reportMarkdownFingerprint(current.currentMarkdown),
      originalMarkdown: current.currentMarkdown,
      replacementMarkdown: target.markdown,
      origin: "restore",
      state: "applied",
      appliedVersion: document.version,
    });
    this.#addEvent(operation, document, `已恢复报告版本 ${input.version}，当前版本为 ${document.version}。`);
    return { operation, document };
    });
  }

  undo(taskId: string, operationId: string): { operation: ReportEditOperation; document: ReportDocument } {
    return this.transactions.run(() => {
    const original = this.store.getOperation(operationId);
    if (!original || original.taskId !== taskId || original.state !== "applied" || !original.appliedVersion) {
      throw new Error("only an applied report edit can be undone");
    }
    const document = this.documents.get(taskId);
    if (!document) throw new Error("report document was not found");
    const restoredRangeEnd = original.scope === "text" && original.rangeStart !== undefined
      ? original.rangeStart + original.replacementMarkdown.length
      : original.rangeEnd;
    const range = reportScopeRange(document, original.scope, original.blockIds, original.rangeStart, restoredRangeEnd);
    if (range.markdown !== original.replacementMarkdown) {
      throw new ReportDocumentConflictError("the applied report block changed and cannot be undone safely");
    }
    const operation = this.store.createOperation({
      taskId,
      conversationId: original.conversationId,
      blockId: original.blockId,
      scope: original.scope,
      blockIds: original.blockIds,
      ...(original.scope === "text" ? { rangeStart: original.rangeStart, rangeEnd: restoredRangeEnd } : {}),
      documentVersion: document.version,
      originalFingerprint: reportMarkdownFingerprint(range.markdown),
      originalMarkdown: range.markdown,
      replacementMarkdown: original.originalMarkdown,
      origin: original.origin,
      state: "proposed",
    });
    const applied = this.apply(taskId, operation.id);
    this.store.updateOperation(original.id, {
      state: "applied",
      appliedVersion: original.appliedVersion,
      undoneOperationId: applied.operation.id,
    });
    this.#addEvent(applied.operation, applied.document, "已恢复先前的局部内容。");
    return applied;
    });
  }

  deleteTask(taskId: string): void {
    this.store.deleteTask(taskId);
  }

  async #rewriteScope(input: {
    document: ReportDocument;
    range: ReturnType<typeof reportScopeRange>;
    scope: "blocks" | "document" | "text";
    instruction: string;
    conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
    sources: ReportEditorSource[];
  }): Promise<{ replacementMarkdown: string; reply?: string }> {
    if (
      input.scope !== "document" ||
      input.range.markdown.length <= WHOLE_DOCUMENT_CHUNK_CHARACTERS
    ) {
      const firstIndex = input.scope === "document"
        ? 0
        : input.document.blocks.findIndex((block) => block.id === input.range.blockIds[0]);
      const lastIndex = input.scope === "document"
        ? input.document.blocks.length - 1
        : input.document.blocks.findIndex((block) => block.id === input.range.blockIds[input.range.blockIds.length - 1]);
      return this.#rewriteChunk({
        blockMarkdown: input.range.markdown,
        instruction: input.instruction,
        previousMarkdown: input.document.blocks[firstIndex - 1]?.markdown,
        nextMarkdown: input.document.blocks[lastIndex + 1]?.markdown,
        conversationHistory: input.conversationHistory,
        sources: input.sources,
      });
    }

    const chunks = documentEditorChunks(input.document);
    const rewrites: Array<{ replacementMarkdown: string; reply?: string }> = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      rewrites.push(await this.#rewriteChunk({
        blockMarkdown: chunk.markdown,
        instruction: `${input.instruction}\n\nThis is part ${index + 1} of ${chunks.length} of one report. Return this part unchanged when the request does not require a change here.`,
        previousMarkdown: chunks[index - 1]?.markdown,
        nextMarkdown: chunks[index + 1]?.markdown,
        conversationHistory: input.conversationHistory,
        sources: input.sources,
      }));
    }
    return {
      replacementMarkdown: rewrites.map((item, index) =>
        item.replacementMarkdown + chunks[index]!.separatorAfter,
      ).join(""),
      reply: `已完成整篇报告的 ${chunks.length} 个内容分段修改预览，请在右侧审阅后确认应用。`,
    };
  }

  async #rewriteChunk(input: ReportEditorModelInput): Promise<ReportEditorRewrite> {
    const result = await this.model.rewrite({
      ...input,
      previousMarkdown: boundedEditorContext(input.previousMarkdown),
      nextMarkdown: boundedEditorContext(input.nextMarkdown),
    });
    const rewrite = typeof result === "string" ? { replacementMarkdown: result } : result;
    return {
      replacementMarkdown: removeMarkdownFence(rewrite.replacementMarkdown),
      reply: rewrite.reply,
    };
  }

  #requireCurrentScope(input: {
    taskId: string;
    scope: "blocks" | "document" | "text";
    blockIds?: string[];
    rangeStart?: number;
    rangeEnd?: number;
    documentVersion: number;
    originalFingerprint?: string;
    originalText?: string;
  }): { document: ReportDocument; range: ReturnType<typeof reportScopeRange> } {
    const document = this.documents.get(input.taskId);
    if (!document) throw new Error("report document was not found");
    if (document.version !== input.documentVersion) {
      throw new ReportDocumentConflictError("the report changed; select the block again");
    }
    const range = reportScopeRange(document, input.scope, input.blockIds ?? [], input.rangeStart, input.rangeEnd);
    const fingerprint = reportMarkdownFingerprint(range.markdown);
    if (input.originalFingerprint && fingerprint !== input.originalFingerprint) {
      throw new ReportDocumentConflictError("the selected report block changed; select it again");
    }
    if (input.originalText !== undefined && range.markdown !== input.originalText) {
      throw new ReportDocumentConflictError("the selected text changed; select it again");
    }
    return { document, range };
  }

  #resolveConversation(taskId: string, blockId: string, conversationId?: string): ReportConversation {
    if (!conversationId) return this.store.createConversation(taskId, blockId);
    const conversation = this.store.getConversation(conversationId);
    if (!conversation || conversation.taskId !== taskId || conversation.blockId !== blockId) {
      throw new Error("the report conversation does not match the selected block");
    }
    return conversation;
  }

  #requireProposedOperation(taskId: string, operationId: string): ReportEditOperation {
    const operation = this.store.getOperation(operationId);
    if (!operation || operation.taskId !== taskId) throw new Error("report edit operation was not found");
    if (operation.state !== "proposed") throw new Error("report edit operation is no longer proposed");
    return operation;
  }

  #addEvent(operation: ReportEditOperation, document: ReportDocument, content: string): void {
    this.store.addMessage({
      conversationId: operation.conversationId,
      taskId: operation.taskId,
      blockId: operation.blockId,
      role: "event",
      content,
      documentVersion: document.version,
      blockFingerprint: operation.scope === "document"
        ? reportMarkdownFingerprint(document.currentMarkdown)
        : operation.scope === "text"
          ? reportMarkdownFingerprint(operation.replacementMarkdown)
        : reportMarkdownFingerprint(reportScopeRange(
          document,
          operation.scope,
          operation.blockIds,
          operation.rangeStart,
          operation.rangeEnd,
        ).markdown),
    });
  }
}

function removeMarkdownFence(value: string): string {
  const fenced = value.match(/^```(?:markdown|md|json)?\s*\n([\s\S]*?)\n```$/iu);
  return fenced ? fenced[1]!.trim() : value;
}

function parseRewriteResult(value: string): ReportEditorRewrite {
  const cleaned = removeMarkdownFence(value);
  try {
    const parsed = JSON.parse(cleaned) as {
      replacementMarkdown?: unknown;
      reply?: unknown;
    };
    if (parsed && typeof parsed === "object" && typeof parsed.replacementMarkdown === "string") {
      return {
        replacementMarkdown: parsed.replacementMarkdown,
        reply: typeof parsed.reply === "string" ? parsed.reply : undefined,
      };
    }
  } catch {
    // Older or non-JSON-compatible models can still return the replacement directly.
  }
  return { replacementMarkdown: value };
}

function documentEditorChunks(document: ReportDocument): Array<{ markdown: string; separatorAfter: string }> {
  if (!document.blocks.length) return [{ markdown: document.currentMarkdown, separatorAfter: "" }];
  const chunks: Array<{ markdown: string; separatorAfter: string }> = [];
  let start = 0;
  let startBlockIndex = 0;
  for (let index = 0; index < document.blocks.length; index += 1) {
    const block = document.blocks[index]!;
    if (index > startBlockIndex && block.sourceEnd - start > WHOLE_DOCUMENT_CHUNK_CHARACTERS) {
      const previous = document.blocks[index - 1]!;
      chunks.push({
        markdown: document.currentMarkdown.slice(start, previous.sourceEnd),
        separatorAfter: document.currentMarkdown.slice(previous.sourceEnd, block.sourceStart),
      });
      start = block.sourceStart;
      startBlockIndex = index;
    }
  }
  const last = document.blocks.at(-1)!;
  chunks.push({
    markdown: document.currentMarkdown.slice(start, last.sourceEnd),
    separatorAfter: document.currentMarkdown.slice(last.sourceEnd),
  });
  return chunks.filter((chunk) => chunk.markdown.length > 0);
}

function boundedEditorContext(markdown: string | undefined): string | undefined {
  if (!markdown || markdown.length <= 4_000) return markdown;
  return `${markdown.slice(0, 2_000)}\n\n[read-only context shortened]\n\n${markdown.slice(-2_000)}`;
}

function buildProposalReply(scope: "blocks" | "document" | "text", blockCount: number): string {
  const target = scope === "document" ? "整篇报告" : scope === "text" ? "选中的文字" : `${blockCount} 个选中内容块`;
  return `我已按你的要求处理${target}，右侧已经生成修改预览。范围外内容保持不变，请确认后应用。`;
}
