import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  OpenAICompatibleConnector,
  type LLMConfig,
  type LLMConnector,
} from "agency-orchestrator";

import {
  ReportDocumentConflictError,
  formatReportInsertion,
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

const LegacyDatabaseSync = process.env.NODE_ENV === "production"
  ? undefined
  : createRequire(import.meta.url)("node:sqlite").DatabaseSync as typeof DatabaseSync;

const WHOLE_DOCUMENT_CHUNK_CHARACTERS = 24_000;
const WHOLE_DOCUMENT_EDIT_CONCURRENCY = 4;

export type ReportMessageRole = "user" | "assistant" | "event";
export type ReportEditOperationState = "proposed" | "applied" | "rejected" | "stale" | "discarded";
export type ReportEditOperationOrigin = "assistant" | "manual" | "restore";
export type ReportEditPlacement = "replace" | "insert_before" | "insert_after";
export type ReportEditStructuralChange = "unchanged" | "merge" | "split" | "insert" | "delete" | "retype" | "document";

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
  operationId?: string;
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
  placement?: ReportEditPlacement;
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
  appliedRangeStart?: number;
  appliedRangeEnd?: number;
  appliedScopeMarkdown?: string;
  appliedBlockIds?: string[];
  structuralChange?: ReportEditStructuralChange;
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
  content?: string;
  fetchStatus?: "fetched" | "failed";
  fetchError?: string;
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
  updateOperation(id: string, update: Pick<ReportEditOperation, "state" | "appliedVersion"> & Partial<Pick<ReportEditOperation, "undoneOperationId" | "appliedRangeStart" | "appliedRangeEnd" | "appliedScopeMarkdown" | "appliedBlockIds" | "structuralChange">>): ReportEditOperation;
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
  sources?: Array<ReportEditorSource & { snippet?: string; content?: string }>;
  editMode?: ReportEditPlacement;
}

export type ReportAssistantIntent = "chat" | "research" | "edit" | "edit_with_research" | "clarify";

export interface ReportAssistantPlan {
  intent: ReportAssistantIntent;
  query?: string;
  urls: string[];
  reply?: string;
  editInstruction?: string;
  targetBlockIds: string[];
}

export interface ReportAssistantPlanInput {
  instruction: string;
  scope: "blocks" | "document" | "text";
  reportOutline: string;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ReportEditorRewrite {
  replacementMarkdown: string;
  reply?: string;
}

export interface ReportEditorModel {
  rewrite(input: ReportEditorModelInput): Promise<string | ReportEditorRewrite>;
  plan?(input: ReportAssistantPlanInput): Promise<ReportAssistantPlan>;
  answer?(input: ReportEditorModelInput): Promise<string>;
  streamAnswer?(input: ReportEditorModelInput, signal?: AbortSignal): AsyncIterable<string>;
}

type ReportEditorModelConfig = LLMConfig | (() => LLMConfig);

export class OpenAIReportEditorModel implements ReportEditorModel {
  readonly #connector?: LLMConnector;
  readonly #config: () => LLMConfig;

  constructor(config: ReportEditorModelConfig, connector?: LLMConnector) {
    this.#config = typeof config === "function" ? config : () => config;
    this.#connector = connector;
  }

  async plan(input: ReportAssistantPlanInput): Promise<ReportAssistantPlan> {
    const { config, connector } = this.#runtime();
    const result = await connector.chat(
      [
        "You route messages for an AI research-report workspace.",
        "Return one strict JSON object with: intent, query, urls, reply, editInstruction, targetBlockIds.",
        "intent must be chat, research, edit, edit_with_research, or clarify.",
        "Use chat for conversation or questions answerable from the report and conversation.",
        "Use research when answering requires current external facts or reading a URL, without changing the report.",
        "Use edit only for an explicit request to change report content using existing context.",
        "Use edit_with_research only when an explicit report change also needs external evidence.",
        "Use clarify when the user may be asking either for information or a report change.",
        "Never infer an edit merely because the workspace is an editor.",
        "query is a concise web query only when research is needed; otherwise null.",
        "urls contains every absolute HTTP(S) URL from the request.",
        "reply is a concise clarification only for clarify; otherwise null.",
        "editInstruction preserves the user's requested change only for edit intents; otherwise null.",
        "targetBlockIds contains a contiguous set of exact report block IDs only when the requested edit clearly targets those blocks; otherwise use an empty array.",
        "A request to rewrite, review, standardize, or change the whole report must use an empty targetBlockIds array.",
      ].join("\n"),
      [
        `Selected scope: ${input.scope}`,
        `Report outline:\n${input.reportOutline}`,
        input.conversationHistory.length
          ? `Conversation:\n${input.conversationHistory.map((item) => `${item.role}: ${item.content}`).join("\n")}`
          : "",
        `User message:\n${input.instruction}`,
      ].filter(Boolean).join("\n\n"),
      config,
    );
    return parseAssistantPlan(result.content, input.instruction);
  }

  async answer(input: ReportEditorModelInput): Promise<string> {
    const { config, connector } = this.#runtime();
    const result = await connector.chat(
      answerSystemPrompt(),
      answerUserPrompt(input),
      config,
    );
    const answer = result.content.trim();
    if (!answer) throw new Error("AI did not return an answer");
    return answer;
  }

  async *streamAnswer(input: ReportEditorModelInput, signal?: AbortSignal): AsyncIterable<string> {
    const config = this.#config();
    const baseUrl = config.base_url;
    if (!baseUrl) throw new Error("report conversation requires configured model settings");
    const response = await fetch(
      new URL("chat/completions", `${baseUrl.replace(/\/+$/u, "")}/`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.api_key}`,
        },
        body: JSON.stringify({
          model: config.model,
          stream: true,
          messages: [
            { role: "system", content: answerSystemPrompt() },
            { role: "user", content: answerUserPrompt(input) },
          ],
        }),
        signal,
      },
    );
    if (!response.ok) throw new Error(`report answer stream failed: ${await response.text()}`);
    if (!response.body) throw new Error("report answer stream did not include a response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/u);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const data = event.split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> };
        const delta = payload.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield delta;
      }
      if (done) break;
    }
  }

  async rewrite(input: ReportEditorModelInput): Promise<ReportEditorRewrite> {
    const { config, connector } = this.#runtime();
    const result = await connector.chat(
      [
        "You edit exactly one writable Markdown scope in a research report.",
        "Return a JSON object with exactly these fields: replacementMarkdown and reply.",
        input.editMode === "insert_before"
          ? "For an insert_before edit, replacementMarkdown must contain only the new Markdown paragraph(s) to insert before the anchor. Never repeat or rewrite the anchor scope."
          : input.editMode === "insert_after"
            ? "For an insert_after edit, replacementMarkdown must contain only the new Markdown paragraph(s) to insert after the anchor. Never repeat or rewrite the anchor scope."
            : "replacementMarkdown must contain only the complete replacement Markdown for the writable scope.",
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
        input.editMode === "insert_before" ? "The requested insertion must be a real non-empty paragraph, not a blank line." : "",
        sourcePrompt(input.sources),
      ].filter(Boolean).join("\n"),
      config,
    );
    const parsed = parseRewriteResult(result.content.trim());
    const replacement = removeMarkdownFence(parsed.replacementMarkdown);
    return { replacementMarkdown: replacement, reply: parsed.reply };
  }

  #runtime(): { config: LLMConfig; connector: LLMConnector } {
    const config = this.#config();
    return {
      config,
      connector: this.#connector ?? new OpenAICompatibleConnector({
        apiKey: config.api_key,
        baseUrl: config.base_url,
      }),
    };
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

  updateOperation(id: string, update: Pick<ReportEditOperation, "state" | "appliedVersion"> & Partial<Pick<ReportEditOperation, "undoneOperationId" | "appliedRangeStart" | "appliedRangeEnd" | "appliedScopeMarkdown" | "appliedBlockIds" | "structuralChange">>): ReportEditOperation {
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

  hydrate(input: {
    conversations: ReportConversation[];
    messages: ReportMessage[];
    operations: ReportEditOperation[];
    searchSessions: ReportSearchSession[];
    searchResults: ReportSearchResult[];
  }): void {
    this.#conversations.clear();
    this.#messages.clear();
    this.#operations.clear();
    this.#searchSessions.clear();
    this.#searchResults.clear();
    for (const item of input.conversations) this.#conversations.set(item.id, structuredClone(item));
    for (const item of input.messages) {
      const messages = this.#messages.get(item.conversationId) ?? [];
      messages.push(structuredClone(item));
      this.#messages.set(item.conversationId, messages);
    }
    for (const item of input.operations) this.#operations.set(item.id, structuredClone(item));
    for (const item of input.searchSessions) this.#searchSessions.set(item.id, structuredClone(item));
    for (const item of input.searchResults) this.#searchResults.set(item.id, structuredClone(item));
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
    if (!database && !LegacyDatabaseSync) throw new Error("SQLite storage is not available in production.");
    this.#database = database ?? new LegacyDatabaseSync!(filePath);
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
        operation_id TEXT,
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
        source_ids TEXT NOT NULL DEFAULT '[]',
        applied_range_start INTEGER,
        applied_range_end INTEGER,
        applied_scope_markdown TEXT,
        applied_block_ids TEXT,
        structural_change TEXT
        ,placement TEXT NOT NULL DEFAULT 'replace'
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
        content TEXT,
        fetch_status TEXT,
        fetch_error TEXT,
        selected INTEGER NOT NULL DEFAULT 0,
        adopted_operation_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS report_search_results_task_session
        ON report_search_results(task_id, session_id, created_at);
    `);
    ensureColumn(this.#database, "report_messages", "operation_id", "TEXT");
    ensureColumn(this.#database, "report_edit_operations", "scope", "TEXT NOT NULL DEFAULT 'blocks'");
    ensureColumn(this.#database, "report_edit_operations", "block_ids", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(this.#database, "report_edit_operations", "origin", "TEXT NOT NULL DEFAULT 'assistant'");
    ensureColumn(this.#database, "report_edit_operations", "range_start", "INTEGER");
    ensureColumn(this.#database, "report_edit_operations", "range_end", "INTEGER");
    ensureColumn(this.#database, "report_edit_operations", "source_ids", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn(this.#database, "report_edit_operations", "applied_range_start", "INTEGER");
    ensureColumn(this.#database, "report_edit_operations", "applied_range_end", "INTEGER");
    ensureColumn(this.#database, "report_edit_operations", "applied_scope_markdown", "TEXT");
    ensureColumn(this.#database, "report_edit_operations", "applied_block_ids", "TEXT");
    ensureColumn(this.#database, "report_edit_operations", "structural_change", "TEXT");
    ensureColumn(this.#database, "report_edit_operations", "placement", "TEXT NOT NULL DEFAULT 'replace'");
    ensureColumn(this.#database, "report_search_results", "content", "TEXT");
    ensureColumn(this.#database, "report_search_results", "fetch_status", "TEXT");
    ensureColumn(this.#database, "report_search_results", "fetch_error", "TEXT");
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
      SELECT id, conversation_id, task_id, block_id, operation_id, role, content,
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
        id, conversation_id, task_id, block_id, operation_id, role, content,
        document_version, block_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      created.id, created.conversationId, created.taskId, created.blockId,
      created.operationId ?? null, created.role, created.content, created.documentVersion,
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
             origin, state, created_at, updated_at, applied_version, undone_operation_id, source_ids,
             applied_range_start, applied_range_end, applied_scope_markdown, applied_block_ids, structural_change, placement
      FROM report_edit_operations WHERE id = ?
    `).get(id) as ReportEditOperationRow | undefined;
    return row ? operationFromRow(row) : undefined;
  }

  listOperations(taskId: string, blockId?: string): ReportEditOperation[] {
    const rows = blockId
      ? this.#database.prepare(`
          SELECT id, task_id, conversation_id, block_id, scope, block_ids, range_start, range_end, document_version,
                 original_fingerprint, original_markdown, replacement_markdown,
                 origin, state, created_at, updated_at, applied_version, undone_operation_id, source_ids,
                 applied_range_start, applied_range_end, applied_scope_markdown, applied_block_ids, structural_change, placement
          FROM report_edit_operations WHERE task_id = ? AND block_id = ?
          ORDER BY created_at DESC
        `).all(taskId, blockId)
      : this.#database.prepare(`
          SELECT id, task_id, conversation_id, block_id, scope, block_ids, range_start, range_end, document_version,
                 original_fingerprint, original_markdown, replacement_markdown,
                 origin, state, created_at, updated_at, applied_version, undone_operation_id, source_ids,
                 applied_range_start, applied_range_end, applied_scope_markdown, applied_block_ids, structural_change, placement
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
        state, created_at, updated_at, applied_version, undone_operation_id, source_ids,
        applied_range_start, applied_range_end, applied_scope_markdown, applied_block_ids, structural_change, placement
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      created.id, created.taskId, created.conversationId, created.blockId, created.scope,
      JSON.stringify(created.blockIds), created.rangeStart ?? null, created.rangeEnd ?? null, created.documentVersion, created.originalFingerprint, created.originalMarkdown,
      created.replacementMarkdown, created.origin, created.state, created.createdAt, created.updatedAt,
      created.appliedVersion ?? null, created.undoneOperationId ?? null, JSON.stringify(created.sourceIds ?? []),
      created.appliedRangeStart ?? null, created.appliedRangeEnd ?? null, created.appliedScopeMarkdown ?? null,
      JSON.stringify(created.appliedBlockIds ?? []), created.structuralChange ?? null, created.placement ?? "replace",
    );
    return created;
  }

  updateOperation(id: string, update: Pick<ReportEditOperation, "state" | "appliedVersion"> & Partial<Pick<ReportEditOperation, "undoneOperationId" | "appliedRangeStart" | "appliedRangeEnd" | "appliedScopeMarkdown" | "appliedBlockIds" | "structuralChange">>): ReportEditOperation {
    const previous = this.getOperation(id);
    if (!previous) throw new Error("report edit operation was not found");
    const updated: ReportEditOperation = {
      ...previous,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    this.#database.prepare(`
      UPDATE report_edit_operations
      SET state = ?, applied_version = ?, undone_operation_id = ?, updated_at = ?,
          applied_range_start = ?, applied_range_end = ?, applied_scope_markdown = ?,
          applied_block_ids = ?, structural_change = ?, placement = ?
      WHERE id = ?
    `).run(
      updated.state,
      updated.appliedVersion ?? null,
      updated.undoneOperationId ?? null,
      updated.updatedAt,
      updated.appliedRangeStart ?? null, updated.appliedRangeEnd ?? null,
      updated.appliedScopeMarkdown ?? null, JSON.stringify(updated.appliedBlockIds ?? []),
      updated.structuralChange ?? null, updated.placement ?? "replace",
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
      INSERT INTO report_search_results(id, session_id, task_id, provider, title, url, snippet, content, fetch_status, fetch_error, selected, adopted_operation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
    `);
    const created = results.map((result) => ({ ...result, id: randomUUID(), sessionId, taskId, selected: false, createdAt }));
    for (const result of created) {
      insert.run(
        result.id, result.sessionId, result.taskId, result.provider, result.title, result.url,
        result.snippet ?? null, result.content ?? null, result.fetchStatus ?? null,
        result.fetchError ?? null, result.createdAt,
      );
    }
    return created;
  }

  listSearchResults(taskId: string, sessionId?: string): ReportSearchResult[] {
    const rows = sessionId
      ? this.#database.prepare(`SELECT id, session_id, task_id, provider, title, url, snippet, content, fetch_status, fetch_error, selected, adopted_operation_id, created_at FROM report_search_results WHERE task_id = ? AND session_id = ? ORDER BY rowid`).all(taskId, sessionId)
      : this.#database.prepare(`SELECT id, session_id, task_id, provider, title, url, snippet, content, fetch_status, fetch_error, selected, adopted_operation_id, created_at FROM report_search_results WHERE task_id = ? ORDER BY rowid DESC`).all(taskId);
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
  operation_id: string | null;
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
  applied_range_start: number | null;
  applied_range_end: number | null;
  applied_scope_markdown: string | null;
  applied_block_ids: string | null;
  structural_change: ReportEditStructuralChange | null;
  placement: ReportEditPlacement | null;
}

interface ReportSearchResultRow {
  id: string;
  session_id: string;
  task_id: string;
  provider: string;
  title: string;
  url: string;
  snippet: string | null;
  content: string | null;
  fetch_status: "fetched" | "failed" | null;
  fetch_error: string | null;
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
    blockId: row.block_id, ...(row.operation_id ? { operationId: row.operation_id } : {}),
    role: row.role, content: row.content,
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
    ...(row.applied_range_start === null ? {} : { appliedRangeStart: Number(row.applied_range_start) }),
    ...(row.applied_range_end === null ? {} : { appliedRangeEnd: Number(row.applied_range_end) }),
    ...(row.applied_scope_markdown === null ? {} : { appliedScopeMarkdown: row.applied_scope_markdown }),
    ...(parseBlockIds(row.applied_block_ids, "").length ? { appliedBlockIds: parseBlockIds(row.applied_block_ids, "") } : {}),
    ...(row.structural_change === null ? {} : { structuralChange: row.structural_change }),
    ...(row.placement && row.placement !== "replace" ? { placement: row.placement } : {}),
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
    ...(row.content ? { content: row.content } : {}),
    ...(row.fetch_status ? { fetchStatus: row.fetch_status } : {}),
    ...(row.fetch_error ? { fetchError: row.fetch_error } : {}),
    selected: Boolean(row.selected),
    ...(row.adopted_operation_id ? { adoptedOperationId: row.adopted_operation_id } : {}),
    createdAt: row.created_at,
  };
}

function parseBlockIds(value: string | null | undefined, fallback: string): string[] {
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

  conversations(taskId: string, _blockId?: string): Array<ReportConversation & { messages: ReportMessage[] }> {
    const conversations = this.store.listConversations(taskId);
    if (!conversations.length) return [];
    const canonical = conversations.find((item) => item.blockId === "document") ?? conversations[0]!;
    const messages = conversations
      .flatMap((conversation) => this.store.listMessages(conversation.id))
      .map((message, index) => ({ message, index }))
      .sort((left, right) => left.message.createdAt.localeCompare(right.message.createdAt) || left.index - right.index)
      .map(({ message }) => message);
    return [{ ...canonical, blockId: "document", messages }];
  }

  operations(taskId: string, _blockId?: string): ReportEditOperation[] {
    return this.store.listOperations(taskId);
  }

  async planMessage(input: {
    taskId: string;
    scope: "blocks" | "document" | "text";
    blockIds: string[];
    rangeStart?: number;
    rangeEnd?: number;
    documentVersion: number;
    originalFingerprint?: string;
    originalText?: string;
    instruction: string;
    conversationId?: string;
  }): Promise<ReportAssistantPlan> {
    const { document } = this.#requireCurrentScope(input);
    if (isUnscopedScopedEditRequest(input.scope, input.instruction)) {
      return {
        intent: "clarify",
        urls: [],
        targetBlockIds: [],
        reply: "这次请求看起来是针对某几段内容的修改，但当前没有选中报告段落。请先点击“选择段落”，在右侧连续选中目标段落，确认上方显示“已选 N 段”后，再一次发送完整要求，例如“合并并缩写这三段”。",
      };
    }
    if (isExplicitScopedEditRequest(input.scope, input.instruction)) {
      return { intent: "edit", urls: [], targetBlockIds: [], editInstruction: input.instruction };
    }
    if (!this.model.plan) {
      return { intent: "edit", urls: [], targetBlockIds: [], editInstruction: input.instruction };
    }
    const conversationHistory = input.conversationId
      ? this.#conversationHistory(input.taskId, input.conversationId)
      : [];
    return this.model.plan({
      instruction: input.instruction,
      scope: input.scope,
      reportOutline: reportOutline(document),
      conversationHistory,
    });
  }

  async answerMessage(input: {
    taskId: string;
    scope: "blocks" | "document" | "text";
    blockIds: string[];
    rangeStart?: number;
    rangeEnd?: number;
    documentVersion: number;
    originalFingerprint?: string;
    originalText?: string;
    instruction: string;
    conversationId?: string;
    sources?: ReportSearchResult[];
    fixedReply?: string;
  }): Promise<{ conversation: ReportConversation; document: ReportDocument; summary: string }> {
    const prepared = this.#prepareAnswerMessage(input);
    let summary = input.fixedReply?.trim();
    if (!summary) {
      if (!this.model.answer) throw new Error("report conversation requires configured model settings");
      summary = (await this.model.answer({
        blockMarkdown: prepared.range.markdown,
        instruction: input.instruction,
        conversationHistory: prepared.conversationHistory,
        sources: input.sources,
      })).trim();
    }
    if (!summary) throw new Error("AI did not return an answer");
    this.#completeAnswerMessage(prepared, input, summary);
    return { conversation: prepared.conversation, document: prepared.document, summary };
  }

  async *streamAnswerMessage(input: {
    taskId: string;
    scope: "blocks" | "document" | "text";
    blockIds: string[];
    rangeStart?: number;
    rangeEnd?: number;
    documentVersion: number;
    originalFingerprint?: string;
    originalText?: string;
    instruction: string;
    conversationId?: string;
    sources?: ReportSearchResult[];
    fixedReply?: string;
    signal?: AbortSignal;
  }): AsyncIterable<{ type: "delta"; content: string } | { type: "done"; conversation: ReportConversation; document: ReportDocument; summary: string }> {
    const prepared = this.#prepareAnswerMessage(input);
    let summary = input.fixedReply?.trim() ?? "";
    if (summary) {
      yield { type: "delta", content: summary };
    } else if (this.model.streamAnswer) {
      for await (const content of this.model.streamAnswer({
        blockMarkdown: prepared.range.markdown,
        instruction: input.instruction,
        conversationHistory: prepared.conversationHistory,
        sources: input.sources,
      }, input.signal)) {
        if (!content) continue;
        summary += content;
        yield { type: "delta", content };
      }
    } else {
      if (!this.model.answer) throw new Error("report conversation requires configured model settings");
      summary = (await this.model.answer({
        blockMarkdown: prepared.range.markdown,
        instruction: input.instruction,
        conversationHistory: prepared.conversationHistory,
        sources: input.sources,
      })).trim();
      if (summary) yield { type: "delta", content: summary };
    }
    summary = summary.trim();
    if (!summary) throw new Error("AI did not return an answer");
    this.#completeAnswerMessage(prepared, input, summary);
    yield { type: "done", conversation: prepared.conversation, document: prepared.document, summary };
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
    userInstruction?: string;
    conversationId?: string;
    sourceIds?: string[];
  }): Promise<{ conversation: ReportConversation; operation: ReportEditOperation; document: ReportDocument; summary: string }> {
    const scope = input.scope ?? "blocks";
    const placement = inferReportEditPlacement(scope, input.instruction);
    if (placement !== "replace" && isBlankLineInsertionRequest(input.instruction)) {
      throw new Error("空行属于排版间距，不会生成内容段落；如需新增内容，请明确说明要添加的段落文字");
    }
    if (placement !== "replace" && scope === "document") {
      throw new Error("请先选择要插入内容的段落，再指定插入位置");
    }
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
    const conversationHistory = this.#conversationHistory(input.taskId, conversation.id);
    for (const pending of this.store.listOperations(input.taskId)) {
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
      content: input.userInstruction?.trim() || input.instruction,
      documentVersion: input.documentVersion,
      blockFingerprint: reportMarkdownFingerprint(range.markdown),
    });
    const rewrite = await this.#rewriteScope({
      document,
      range,
      scope,
      instruction: input.instruction,
      placement,
      conversationHistory,
      sources: selectedSources,
    });
    const assistantReply = rewrite.reply?.trim() || buildProposalReply(scope, range.blockIds.length);
    const replacementMarkdown = rewrite.replacementMarkdown;
    if (placement !== "replace" && !replacementMarkdown.trim()) {
      throw new Error("AI 未生成可插入的段落内容，报告未发生变化");
    }
    const operation = this.store.createOperation({
      taskId: input.taskId,
      conversationId: conversation.id,
      blockId: scopeKey,
      scope,
      ...(placement !== "replace" ? { placement } : {}),
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
    this.store.addMessage({
      conversationId: conversation.id,
      taskId: input.taskId,
      blockId: scopeKey,
      operationId: operation.id,
      role: "assistant",
      content: assistantReply,
      documentVersion: input.documentVersion,
      blockFingerprint: reportMarkdownFingerprint(range.markdown),
    });
    return { conversation, operation, document, summary: assistantReply };
  }

  audit(taskId: string, sources: readonly ReportEditorSource[]): ReportCitationAudit {
    const document = this.documents.get(taskId);
    if (!document) throw new Error("report document was not found");
    const adopted = this.store.adoptedSearchResults(taskId);
    return auditReportCitations({
      markdown: document.currentMarkdown,
      baselineMarkdown: document.baselineMarkdown,
      version: document.version,
      sources: [...sources, ...adopted],
    });
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
      const before = this.documents.get(taskId);
      if (!before) throw new Error("report document was not found");
      const beforeRange = reportScopeRange(
        before,
        operation.scope,
        operation.blockIds,
        operation.rangeStart,
        operation.rangeEnd,
      );
      const document = this.documents.applyDraftScope({
        taskId,
        scope: operation.scope,
        blockIds: operation.blockIds,
        ...(operation.scope === "text" ? { rangeStart: operation.rangeStart, rangeEnd: operation.rangeEnd } : {}),
        expectedVersion: operation.documentVersion,
        expectedFingerprint: operation.originalFingerprint,
        replacementMarkdown: operation.replacementMarkdown,
        ...(operation.placement && operation.placement !== "replace" ? { placement: operation.placement } : {}),
      });
      const updated = this.store.updateOperation(operation.id, {
        state: "applied",
        appliedVersion: document.version,
          ...appliedOperationMetadata(before, document, beforeRange, operation.replacementMarkdown, operation.placement),
      });
      if (updated.sourceIds?.length) {
        this.store.adoptSearchResults(taskId, updated.id, updated.sourceIds);
      }
      this.#addEvent(
        updated,
        document,
        updated.placement === "insert_before"
          ? "修改已暂存：已在选中内容前插入新段落，尚未创建新版本。原段落保持不变。"
          : updated.placement === "insert_after"
            ? "修改已暂存：已在选中内容后插入新段落，尚未创建新版本。原段落保持不变。"
            : `修改已暂存：已更新${updated.scope === "document" ? "整篇报告" : `${updated.blockIds.length} 个内容块`}，尚未创建新版本。范围外内容保持不变。`,
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
    const staged = this.documents.saveDraft({
      taskId: input.taskId,
      expectedVersion: current.version,
      expectedFingerprint: reportMarkdownFingerprint(current.currentMarkdown),
      replacementMarkdown: input.scope === "document"
        ? input.replacementMarkdown
        : current.currentMarkdown.slice(0, range.start) + input.replacementMarkdown + current.currentMarkdown.slice(range.end),
    });
    const document = this.documents.commitDraft({
      taskId: input.taskId,
      expectedVersion: current.version,
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
      ...appliedOperationMetadata(current, document, range, input.scope === "document" ? input.replacementMarkdown : staged.currentMarkdown.slice(range.start, range.start + input.replacementMarkdown.length)),
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
    const document = this.documents.restoreVersionToDraft(input);
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
      ...appliedOperationMetadata(current, document, {
        start: 0,
        end: current.currentMarkdown.length,
        markdown: current.currentMarkdown,
        blockIds: [],
      }, target.markdown),
    });
    this.#addEvent(operation, document, `已将报告恢复为版本 ${input.version} 的暂存内容，尚未创建新版本。`);
    return { operation, document };
    });
  }

  saveDraft(input: { taskId: string; expectedVersion: number; replacementMarkdown: string }): ReportDocument {
    const current = this.documents.get(input.taskId);
    if (!current) throw new Error("report document was not found");
    return this.documents.saveDraft({
      taskId: input.taskId,
      expectedVersion: input.expectedVersion,
      expectedFingerprint: reportMarkdownFingerprint(current.currentMarkdown),
      replacementMarkdown: input.replacementMarkdown,
    });
  }

  saveVersion(input: { taskId: string; expectedVersion: number }): ReportDocument {
    return this.documents.commitDraft(input);
  }

  discardDraft(input: { taskId: string; expectedVersion: number }): ReportDocument {
    return this.transactions.run(() => {
      const current = this.documents.get(input.taskId);
      if (!current || current.version !== input.expectedVersion) {
        throw new ReportDocumentConflictError("the report changed before the draft was discarded");
      }
      const document = this.documents.discardDraft(input);
      for (const operation of this.store.listOperations(input.taskId)) {
        if (operation.state === "applied" && operation.appliedVersion === current.version) {
          this.store.updateOperation(operation.id, {
            state: "discarded",
            appliedVersion: operation.appliedVersion,
          });
        }
      }
      return document;
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
    if (original.appliedRangeStart === undefined || original.appliedRangeEnd === undefined || original.appliedScopeMarkdown === undefined) {
      throw new ReportDocumentConflictError("this edit has no exact applied range and cannot be undone safely");
    }
    const appliedRange = {
      start: original.appliedRangeStart,
      end: original.appliedRangeEnd,
      markdown: original.appliedScopeMarkdown,
      blockIds: original.appliedBlockIds ?? [],
    };
    const operation = this.store.createOperation({
      taskId,
      conversationId: original.conversationId,
      blockId: original.blockId,
      scope: original.scope,
      blockIds: appliedRange.blockIds,
      ...(original.scope === "text" ? { rangeStart: original.appliedRangeStart, rangeEnd: original.appliedRangeEnd } : {}),
      documentVersion: document.version,
      originalFingerprint: reportMarkdownFingerprint(appliedRange.markdown),
      originalMarkdown: appliedRange.markdown,
      replacementMarkdown: original.placement === "insert_before" || original.placement === "insert_after"
        ? ""
        : original.originalMarkdown,
      origin: original.origin,
      state: "proposed",
    });
    const nextMarkdown = document.currentMarkdown.slice(0, appliedRange.start)
      + (original.placement === "insert_before" || original.placement === "insert_after" ? "" : original.originalMarkdown)
      + document.currentMarkdown.slice(appliedRange.end);
    const restored = this.documents.saveDraft({
      taskId,
      expectedVersion: document.version,
      expectedFingerprint: reportMarkdownFingerprint(document.currentMarkdown),
      replacementMarkdown: nextMarkdown,
    });
    const applied = {
      operation: this.store.updateOperation(operation.id, {
        state: "applied",
        appliedVersion: restored.version,
        ...appliedOperationMetadata(document, restored, appliedRange, original.placement === "insert_before" || original.placement === "insert_after" ? "" : original.originalMarkdown),
      }),
      document: restored,
    };
    this.store.updateOperation(original.id, {
      state: "applied",
      appliedVersion: original.appliedVersion,
      undoneOperationId: applied.operation.id,
    });
    this.#addEvent(applied.operation, applied.document, "已将先前的局部内容恢复到暂存稿。");
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
    placement: ReportEditPlacement;
    instruction: string;
    conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
    sources: ReportEditorSource[];
  }): Promise<{ replacementMarkdown: string; reply?: string }> {
    const deterministic = input.placement === "replace"
      ? deterministicMarkdownEdit(input.range.markdown, input.instruction, input.scope)
      : undefined;
    if (deterministic !== undefined) {
      return {
        replacementMarkdown: deterministic,
        reply: "已完成这项精确修改，右侧已生成预览，请确认后应用。",
      };
    }
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
        editMode: input.placement,
        previousMarkdown: input.document.blocks[firstIndex - 1]?.markdown,
        nextMarkdown: input.document.blocks[lastIndex + 1]?.markdown,
        conversationHistory: input.conversationHistory,
        sources: input.sources,
      });
    }

    const chunks = documentEditorChunks(input.document);
    const rewrites = await mapWithConcurrency(chunks, WHOLE_DOCUMENT_EDIT_CONCURRENCY, async (chunk, index) => {
      return this.#rewriteChunk({
        blockMarkdown: chunk.markdown,
        instruction: [
          input.instruction,
          `This is part ${index + 1} of ${chunks.length} of one report.`,
          "Return this part byte-for-byte unchanged when the request does not require a change here.",
          "Do not add commentary, JSON wrappers, or content belonging to another part.",
        ].join("\n\n"),
        editMode: input.placement,
        previousMarkdown: chunks[index - 1]?.markdown,
        nextMarkdown: chunks[index + 1]?.markdown,
        conversationHistory: input.conversationHistory,
        sources: input.sources,
      });
    });
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
    const replacementMarkdown = removeMarkdownFence(rewrite.replacementMarkdown);
    if (looksLikeStructuredEnvelope(replacementMarkdown)) {
      throw new Error("AI returned structured data instead of report Markdown; the report was not changed");
    }
    return {
      replacementMarkdown,
      reply: rewrite.reply,
    };
  }

  #prepareAnswerMessage(input: {
    taskId: string;
    scope: "blocks" | "document" | "text";
    blockIds: string[];
    rangeStart?: number;
    rangeEnd?: number;
    documentVersion: number;
    originalFingerprint?: string;
    originalText?: string;
    instruction: string;
    conversationId?: string;
  }): {
    document: ReportDocument;
    range: ReturnType<typeof reportScopeRange>;
    conversation: ReportConversation;
    scopeKey: string;
    conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  } {
    const { document, range } = this.#requireCurrentScope(input);
    const scopeKey = input.scope === "document" ? "document" : range.blockIds.join(",");
    const conversation = this.#resolveConversation(input.taskId, scopeKey, input.conversationId);
    return {
      document,
      range,
      conversation,
      scopeKey,
      conversationHistory: this.#conversationHistory(input.taskId, conversation.id),
    };
  }

  #completeAnswerMessage(
    prepared: {
      document: ReportDocument;
      range: ReturnType<typeof reportScopeRange>;
      conversation: ReportConversation;
      scopeKey: string;
    },
    input: {
      taskId: string;
      documentVersion: number;
      instruction: string;
    },
    summary: string,
  ): void {
    const fingerprint = reportMarkdownFingerprint(prepared.range.markdown);
    this.store.addMessage({
      conversationId: prepared.conversation.id,
      taskId: input.taskId,
      blockId: prepared.scopeKey,
      role: "user",
      content: input.instruction,
      documentVersion: input.documentVersion,
      blockFingerprint: fingerprint,
    });
    this.store.addMessage({
      conversationId: prepared.conversation.id,
      taskId: input.taskId,
      blockId: prepared.scopeKey,
      role: "assistant",
      content: summary,
      documentVersion: input.documentVersion,
      blockFingerprint: fingerprint,
    });
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

  #resolveConversation(taskId: string, _scopeKey: string, conversationId?: string): ReportConversation {
    if (!conversationId) {
      const existing = this.store.listConversations(taskId).find((item) => item.blockId === "document")
        ?? this.store.listConversations(taskId)[0];
      return existing ?? this.store.createConversation(taskId, "document");
    }
    const conversation = this.store.getConversation(conversationId);
    if (!conversation || conversation.taskId !== taskId) {
      throw new Error("the report conversation does not belong to this report");
    }
    return conversation;
  }

  #conversationHistory(taskId: string, conversationId: string): Array<{ role: "user" | "assistant"; content: string }> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation || conversation.taskId !== taskId) {
      throw new Error("the report conversation does not belong to this task");
    }
    return this.store.listConversations(taskId)
      .flatMap((item) => this.store.listMessages(item.id))
      .map((message, index) => ({ message, index }))
      .sort((left, right) => left.message.createdAt.localeCompare(right.message.createdAt) || left.index - right.index)
      .map(({ message }) => message)
      .filter((message): message is ReportMessage & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant")
      .slice(-10)
      .map((message) => ({ role: message.role, content: message.content }));
  }

  #requireProposedOperation(taskId: string, operationId: string): ReportEditOperation {
    const operation = this.store.getOperation(operationId);
    if (!operation || operation.taskId !== taskId) throw new Error("report edit operation was not found");
    if (operation.state !== "proposed") throw new Error("report edit operation is no longer proposed");
    return operation;
  }

  #addEvent(operation: ReportEditOperation, document: ReportDocument, content: string): void {
    const blockFingerprint = operation.appliedScopeMarkdown !== undefined
      ? reportMarkdownFingerprint(operation.appliedScopeMarkdown)
      : operation.scope === "document"
        ? reportMarkdownFingerprint(document.currentMarkdown)
        : operation.state === "applied"
          ? reportMarkdownFingerprint(operation.replacementMarkdown)
          : reportMarkdownFingerprint(reportScopeRange(
            document,
            operation.scope,
            operation.blockIds,
            operation.rangeStart,
            operation.rangeEnd,
          ).markdown);
    this.store.addMessage({
      conversationId: operation.conversationId,
      taskId: operation.taskId,
      blockId: operation.blockId,
      operationId: operation.id,
      role: "event",
      content,
      documentVersion: document.version,
      blockFingerprint,
    });
  }
}

function appliedOperationMetadata(
  before: ReportDocument,
  after: ReportDocument,
  beforeRange: ReturnType<typeof reportScopeRange>,
  replacementMarkdown: string,
  placement: ReportEditPlacement = "replace",
): Pick<ReportEditOperation, "appliedRangeStart" | "appliedRangeEnd" | "appliedScopeMarkdown" | "appliedBlockIds" | "structuralChange"> {
  const start = placement === "insert_after" ? beforeRange.end : beforeRange.start;
  const appliedScopeMarkdown = placement === "replace"
    ? replacementMarkdown
    : formatReportInsertion(replacementMarkdown, placement);
  const end = start + appliedScopeMarkdown.length;
  const appliedBlockIds = beforeRange.blockIds.length === 0 && start === 0 && beforeRange.end === before.currentMarkdown.length
    ? []
    : after.blocks
      .filter((block) => block.sourceStart < end && block.sourceEnd > start)
      .map((block) => block.id);
  return {
    appliedRangeStart: start,
    appliedRangeEnd: end,
    appliedScopeMarkdown,
    appliedBlockIds,
    structuralChange: placement === "replace"
      ? structuralChange(before, after, beforeRange.blockIds, appliedBlockIds)
      : "insert",
  };
}

function structuralChange(
  before: ReportDocument,
  after: ReportDocument,
  beforeBlockIds: readonly string[],
  afterBlockIds: readonly string[],
): ReportEditStructuralChange {
  if (beforeBlockIds.length === 0) return "document";
  if (afterBlockIds.length === 0) return "delete";
  if (afterBlockIds.length < beforeBlockIds.length) return "merge";
  if (afterBlockIds.length > beforeBlockIds.length) return "split";
  const beforeKinds = beforeBlockIds.map((id) => before.blocks.find((block) => block.id === id)?.kind).filter(Boolean);
  const afterKinds = afterBlockIds.map((id) => after.blocks.find((block) => block.id === id)?.kind).filter(Boolean);
  return beforeKinds.join(",") === afterKinds.join(",") ? "unchanged" : "retype";
}

function removeMarkdownFence(value: string): string {
  const fenced = value.match(/^```(?:markdown|md|json)?\s*\n([\s\S]*?)\n```$/iu);
  return fenced ? fenced[1]!.trim() : value;
}

function parseRewriteResult(value: string): ReportEditorRewrite {
  const cleaned = removeMarkdownFence(value);
  const parsed = parseJsonObject(cleaned) as {
    replacementMarkdown?: unknown;
    reply?: unknown;
  };
  if (typeof parsed.replacementMarkdown !== "string") {
    throw new Error("AI returned an invalid report edit; the report was not changed");
  }
  const replacementMarkdown = parsed.replacementMarkdown;
  if (looksLikeStructuredEnvelope(replacementMarkdown)) {
    throw new Error("AI returned a nested structured response; the report was not changed");
  }
  return {
    replacementMarkdown,
    reply: typeof parsed.reply === "string" ? parsed.reply : undefined,
  };
}

function parseAssistantPlan(value: string, instruction: string): ReportAssistantPlan {
  const parsed = parseJsonObject(removeMarkdownFence(value)) as Record<string, unknown>;
  const intents = new Set<ReportAssistantIntent>(["chat", "research", "edit", "edit_with_research", "clarify"]);
  if (typeof parsed.intent !== "string" || !intents.has(parsed.intent as ReportAssistantIntent)) {
    throw new Error("AI could not determine how to handle this message");
  }
  const explicitUrls = extractHttpUrls(instruction);
  let intent = parsed.intent as ReportAssistantIntent;
  if (explicitUrls.length && intent === "chat") intent = "research";
  const urls = [...new Set([
    ...explicitUrls,
    ...(Array.isArray(parsed.urls) ? parsed.urls.filter((item): item is string => typeof item === "string") : []),
  ].filter(isPublicHttpUrl))];
  return {
    intent,
    urls,
    targetBlockIds: Array.isArray(parsed.targetBlockIds)
      ? [...new Set(parsed.targetBlockIds.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()))]
      : [],
    ...(typeof parsed.query === "string" && parsed.query.trim() ? { query: parsed.query.trim() } : {}),
    ...(typeof parsed.reply === "string" && parsed.reply.trim() ? { reply: parsed.reply.trim() } : {}),
    ...(typeof parsed.editInstruction === "string" && parsed.editInstruction.trim()
      ? { editInstruction: parsed.editInstruction.trim() }
      : {}),
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  const candidates = [value.trim()];
  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(value.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next bounded candidate. Invalid output must never become report Markdown.
    }
  }
  throw new Error("AI returned invalid structured output; the report was not changed");
}

function looksLikeStructuredEnvelope(value: string): boolean {
  const cleaned = removeMarkdownFence(value).trim();
  return /^\{\s*["'](?:replacementMarkdown|reply|intent)["']\s*:/u.test(cleaned);
}

function extractHttpUrls(value: string): string[] {
  return [...value.matchAll(/https?:\/\/[^\s<>()\[\]{}"']+/giu)].map((match) => match[0]!.replace(/[.,;:!?，。；：！？]+$/u, ""));
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function sourcePrompt(sources: ReportEditorModelInput["sources"]): string {
  if (!sources?.length) return "";
  return [
    "Readable web sources:",
    ...sources.map((source, index) => [
      `${index + 1}. [${source.title}](${source.url})`,
      source.content ? boundedSourceContent(source.content) : source.snippet ?? "[Page body could not be read]",
    ].join("\n")),
  ].join("\n\n");
}

function answerSystemPrompt(): string {
  return [
    "You are the conversation assistant for a research-report editor.",
    "Answer the user's question from the provided report context, conversation, and readable sources.",
    "This is an answer-only flow: no report change, preview, or save action exists here.",
    "Never state or imply that content was changed, deleted, inserted, saved, applied, or previewed. Do not use completion wording such as 'deleted', 'updated', 'preview ready', or equivalents in the user's language.",
    "If the user asks for an edit, say only that the editor will prepare a separate change preview; do not describe the edit as completed.",
    "Use the user's language. Give a concise, useful answer with 3 to 5 numbered conclusions when appropriate.",
    "Each conclusion should be one or two sentences. Do not repeat the report verbatim or write a full report.",
    "Use Markdown only when it improves clarity. Preserve URLs and citations from readable sources when they support a factual claim.",
  ].join("\n");
}

function answerUserPrompt(input: ReportEditorModelInput): string {
  return [
    "Report context:",
    boundedAnswerContext(input.blockMarkdown),
    input.conversationHistory?.length
      ? `Conversation history:\n${input.conversationHistory.map((message) => `${message.role}: ${message.content}`).join("\n")}`
      : "",
    sourcePrompt(input.sources),
    `User message:\n${input.instruction}`,
  ].filter(Boolean).join("\n\n");
}

function isExplicitScopedEditRequest(scope: "blocks" | "document" | "text", instruction: string): boolean {
  if (scope === "document") return false;
  const command = instruction.trim();
  if (!command) return false;
  if (inferReportEditPlacement(scope, command) !== "replace") return true;
  const editVerb = "(?:删除|删掉|移除|去掉|清除|合并|拆分|替换|修改|改写|重写|改成|改为|调整|优化|精简|缩写|润色|扩写|补充|添加|插入|增加)";
  return new RegExp(
    `^(?:(?:请|麻烦)(?:你)?|请帮我|帮我|我想(?:要)?|我需要|想要|需要|直接)?\\s*(?:(?:把|将).{0,30}?)?(?:进行|做一下|稍微)?\\s*${editVerb}`,
    "u",
  ).test(command);
}

function inferReportEditPlacement(
  scope: "blocks" | "document" | "text",
  instruction: string,
): ReportEditPlacement {
  if (scope === "document") return "replace";
  const command = instruction.trim();
  if (!command) return "replace";
  if (/(?:在|于|请在|请于|帮我在).{0,40}(?:这|该|此|所选|选中|当前)?(?:段|段落|内容|这里).{0,18}(?:之前|前面|前方|前)\s*(?:加|添加|插入|增加|补充)/u.test(command)
    || /(?:在|于).{0,24}(?:之前|前面|前方|前)\s*(?:加|添加|插入|增加|补充).{0,30}(?:段|段落)/u.test(command)) {
    return "insert_before";
  }
  if (/(?:在|于).{0,40}(?:这|该|此|所选|选中|当前)?(?:段|段落|内容|这里).{0,18}(?:之后|后面|后方|后)\s*(?:加|添加|插入|增加|补充)/u.test(command)
    || /(?:在|于).{0,24}(?:之后|后面|后方|后)\s*(?:加|添加|插入|增加|补充).{0,30}(?:段|段落)/u.test(command)) {
    return "insert_after";
  }
  if (/(?:加|添加|增加|补充).{0,30}(?:过渡|承上启下|衔接).{0,10}(?:段|段落)/u.test(command)) {
    return "insert_before";
  }
  return "replace";
}

function isBlankLineInsertionRequest(instruction: string): boolean {
  const command = instruction.trim();
  return /(?:空行|空白行|空一行|blank\s+line)/iu.test(command)
    && !/(?:段落|过渡|文字|句子|内容)/u.test(command);
}

function isUnscopedScopedEditRequest(scope: "blocks" | "document" | "text", instruction: string): boolean {
  if (scope !== "document") return false;
  const command = instruction.trim();
  if (!command) return false;
  const editVerb = "(?:删除|删掉|移除|去掉|清除|合并|拆分|替换|修改|改写|重写|改成|改为|调整|优化|精简|缩写|润色|扩写|补充|添加|插入|增加|delete|remove|merge|split|rewrite|shorten|summarize|edit)";
  const localTarget = "(?:这|该|此|所选|选中|当前|刚才|其中|上面|下面|this|that|these|selected|the selected)\\s*(?:个|一|几|两|俩|三|些|多|two|three|some)?\\s*(?:段|段落|句|标题|分割线|内容|文字|小点|部分|处|paragraphs?|sentences?|section|sections?|blocks?)";
  return new RegExp(`(?:${editVerb}).{0,24}${localTarget}|${localTarget}.{0,24}(?:${editVerb})`, "iu").test(command);
}

function boundedSourceContent(value: string): string {
  return value.length <= 12_000 ? value : `${value.slice(0, 12_000)}\n[content truncated]`;
}

function boundedAnswerContext(value: string): string {
  return value.length <= 18_000 ? value : `${value.slice(0, 9_000)}\n[report context shortened]\n${value.slice(-9_000)}`;
}

function reportOutline(document: ReportDocument): string {
  return document.blocks.slice(0, 300).map((block) =>
    `${block.id} [${block.kind}]: ${block.text.slice(0, 120)}`,
  ).join("\n");
}

function deterministicMarkdownEdit(
  markdown: string,
  instruction: string,
  scope: "blocks" | "document" | "text",
): string | undefined {
  if (scope === "document") {
    const title = instruction.match(/(?:把|将)?(?:报告)?标题(?:修改|改)(?:为|成)\s*[“"]([^”"]+)[”"]/u)?.[1]?.trim();
    if (title) {
      const updated = markdown.replace(/^(#{1,6}\s+).+$/mu, `$1${title}`);
      if (updated !== markdown) return updated;
    }
  }
  const replacement = instruction.match(/[“"]([^”"]+)[”"]\s*(?:替换为|替换成|改为|改成)\s*[“"]([^”"]*)[”"]/u);
  if (replacement?.[1] && markdown.includes(replacement[1])) {
    return markdown.split(replacement[1]).join(replacement[2] ?? "");
  }
  const deletion = instruction.match(/(?:删除|去掉)(?:[^“"]{0,30})[“"]([^”"]+)[”"]/u)?.[1];
  if (deletion && markdown.includes(deletion)) {
    return markdown.split(deletion).join("");
  }
  return undefined;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await work(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
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
