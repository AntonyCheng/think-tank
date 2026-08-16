import type { PostgresDatabase } from "./postgres.js";
import { postgresJson } from "./postgres.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";
import {
  InMemoryReportEditorStore,
  type ReportConversation,
  type ReportEditOperation,
  type ReportEditorStore,
  type ReportMessage,
  type ReportSearchResult,
  type ReportSearchSession,
} from "./report-editor.js";

export class PostgresReportEditorStore implements ReportEditorStore {
  readonly #memory = new InMemoryReportEditorStore();
  readonly #writes: PostgresWriteQueue;

  constructor(database: PostgresDatabase) { this.#writes = new PostgresWriteQueue(database); }

  async initialize(): Promise<void> {
    const database = this.#writes.connection;
    const [conversations, messages, operations, sessions, results] = await Promise.all([
      database.query<ConversationRow>("SELECT id,task_id,block_id,created_at::text,updated_at::text FROM report_conversations"),
      database.query<MessageRow>("SELECT id,conversation_id,task_id,block_id,role,content,document_version,block_fingerprint,created_at::text FROM report_messages ORDER BY created_at,id"),
      database.query<OperationRow>("SELECT id,task_id,conversation_id,block_id,scope,block_ids,range_start,range_end,document_version,original_fingerprint,original_markdown,replacement_markdown,origin,state,created_at::text,updated_at::text,applied_version,undone_operation_id,source_ids FROM report_edit_operations"),
      database.query<SessionRow>("SELECT id,task_id,scope_key,query,retrievers,created_at::text FROM report_search_sessions"),
      database.query<ResultRow>("SELECT id,session_id,task_id,provider,title,url,snippet,content,fetch_status,fetch_error,selected,adopted_operation_id,created_at::text FROM report_search_results ORDER BY created_at,id"),
    ]);
    this.#memory.hydrate({
      conversations: conversations.map(conversation),
      messages: messages.map(message),
      operations: operations.map(operation),
      searchSessions: sessions.map(session),
      searchResults: results.map(result),
    });
  }

  listConversations(taskId: string, blockId?: string): ReportConversation[] { return this.#memory.listConversations(taskId, blockId); }
  getConversation(id: string): ReportConversation | undefined { return this.#memory.getConversation(id); }
  listMessages(conversationId: string): ReportMessage[] { return this.#memory.listMessages(conversationId); }
  getOperation(id: string): ReportEditOperation | undefined { return this.#memory.getOperation(id); }
  listOperations(taskId: string, blockId?: string): ReportEditOperation[] { return this.#memory.listOperations(taskId, blockId); }
  listSearchResults(taskId: string, sessionId?: string): ReportSearchResult[] { return this.#memory.listSearchResults(taskId, sessionId); }
  selectedSearchResults(taskId: string, resultIds: string[]): ReportSearchResult[] { return this.#memory.selectedSearchResults(taskId, resultIds); }
  adoptedSearchResults(taskId: string): ReportSearchResult[] { return this.#memory.adoptedSearchResults(taskId); }

  createConversation(taskId: string, blockId: string): ReportConversation {
    const value = this.#memory.createConversation(taskId, blockId);
    this.#writes.enqueue(() => this.#saveConversation(value));
    return value;
  }

  addMessage(input: Omit<ReportMessage, "id" | "createdAt">): ReportMessage {
    const value = this.#memory.addMessage(input);
    this.#writes.enqueue(async () => {
      await this.#writes.connection.query(`INSERT INTO report_messages(id,conversation_id,task_id,block_id,role,content,document_version,block_fingerprint,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [value.id,value.conversationId,value.taskId,value.blockId,value.role,value.content,value.documentVersion,value.blockFingerprint,value.createdAt]);
      const conversation = this.#memory.getConversation(value.conversationId);
      if (conversation) await this.#saveConversation(conversation);
    });
    return value;
  }

  createOperation(input: Omit<ReportEditOperation, "id" | "createdAt" | "updatedAt">): ReportEditOperation {
    const value = this.#memory.createOperation(input);
    this.#writes.enqueue(() => this.#saveOperation(value));
    return value;
  }

  updateOperation(id: string, update: Pick<ReportEditOperation, "state" | "appliedVersion"> & Partial<Pick<ReportEditOperation, "undoneOperationId">>): ReportEditOperation {
    const value = this.#memory.updateOperation(id, update);
    this.#writes.enqueue(() => this.#saveOperation(value));
    return value;
  }

  createSearchSession(input: Omit<ReportSearchSession, "id" | "createdAt">): ReportSearchSession {
    const value = this.#memory.createSearchSession(input);
    this.#writes.enqueue(async () => {
      await this.#writes.connection.query(`INSERT INTO report_search_sessions(id,task_id,scope_key,query,retrievers,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [value.id,value.taskId,value.scopeKey,value.query,postgresJson(value.retrievers),value.createdAt]);
    });
    return value;
  }

  replaceSearchResults(sessionId: string, taskId: string, inputs: Array<Omit<ReportSearchResult, "id" | "sessionId" | "taskId" | "selected" | "createdAt">>): ReportSearchResult[] {
    const values = this.#memory.replaceSearchResults(sessionId, taskId, inputs);
    this.#writes.enqueue(async () => {
      await this.#writes.connection.transaction(async (client) => {
        await client.query("DELETE FROM report_search_results WHERE task_id=$1 AND session_id=$2", [taskId,sessionId]);
        for (const value of values) await client.query(`INSERT INTO report_search_results(id,session_id,task_id,provider,title,url,snippet,content,fetch_status,fetch_error,selected,adopted_operation_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [value.id,value.sessionId,value.taskId,value.provider,value.title,value.url,value.snippet ?? null,value.content ?? null,value.fetchStatus ?? null,value.fetchError ?? null,value.selected,value.adoptedOperationId ?? null,value.createdAt]);
      });
    });
    return values;
  }

  selectSearchResults(taskId: string, sessionId: string, resultIds: string[]): ReportSearchResult[] {
    const values = this.#memory.selectSearchResults(taskId, sessionId, resultIds);
    this.#writes.enqueue(() => this.#saveResults(values));
    return values;
  }

  adoptSearchResults(taskId: string, operationId: string, resultIds: string[]): void {
    this.#memory.adoptSearchResults(taskId, operationId, resultIds);
    this.#writes.enqueue(() => this.#saveResults(this.#memory.listSearchResults(taskId)));
  }

  deleteTask(taskId: string): void {
    this.#memory.deleteTask(taskId);
    this.#writes.enqueue(async () => {
      await this.#writes.connection.transaction(async (client) => {
        for (const table of ["report_edit_operations", "report_messages", "report_conversations", "report_search_results", "report_search_sessions"]) await client.query(`DELETE FROM ${table} WHERE task_id=$1`, [taskId]);
      });
    });
  }

  async drain(): Promise<void> { await this.#writes.drain(); }

  async #saveConversation(value: ReportConversation): Promise<void> {
    await this.#writes.connection.query(`INSERT INTO report_conversations(id,task_id,block_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET updated_at=EXCLUDED.updated_at`, [value.id,value.taskId,value.blockId,value.createdAt,value.updatedAt]);
  }

  async #saveOperation(value: ReportEditOperation): Promise<void> {
    await this.#writes.connection.query(`INSERT INTO report_edit_operations(id,task_id,conversation_id,block_id,scope,block_ids,range_start,range_end,document_version,original_fingerprint,original_markdown,replacement_markdown,origin,state,created_at,updated_at,applied_version,undone_operation_id,source_ids) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,updated_at=EXCLUDED.updated_at,applied_version=EXCLUDED.applied_version,undone_operation_id=EXCLUDED.undone_operation_id`, [value.id,value.taskId,value.conversationId,value.blockId,value.scope,postgresJson(value.blockIds),value.rangeStart ?? null,value.rangeEnd ?? null,value.documentVersion,value.originalFingerprint,value.originalMarkdown,value.replacementMarkdown,value.origin,value.state,value.createdAt,value.updatedAt,value.appliedVersion ?? null,value.undoneOperationId ?? null,postgresJson(value.sourceIds ?? [])]);
  }

  async #saveResults(values: ReportSearchResult[]): Promise<void> {
    for (const value of values) await this.#writes.connection.query(`UPDATE report_search_results SET selected=$1, adopted_operation_id=$2 WHERE id=$3`, [value.selected,value.adoptedOperationId ?? null,value.id]);
  }
}

interface ConversationRow { id:string; task_id:string; block_id:string; created_at:string; updated_at:string; }
interface MessageRow { id:string; conversation_id:string; task_id:string; block_id:string; role:ReportMessage["role"]; content:string; document_version:number; block_fingerprint:string; created_at:string; }
interface OperationRow { id:string; task_id:string; conversation_id:string; block_id:string; scope:ReportEditOperation["scope"]; block_ids:string[]; range_start:number|null; range_end:number|null; document_version:number; original_fingerprint:string; original_markdown:string; replacement_markdown:string; origin:ReportEditOperation["origin"]; state:ReportEditOperation["state"]; created_at:string; updated_at:string; applied_version:number|null; undone_operation_id:string|null; source_ids:string[]; }
interface SessionRow { id:string; task_id:string; scope_key:string; query:string; retrievers:string[]; created_at:string; }
interface ResultRow { id:string; session_id:string; task_id:string; provider:string; title:string; url:string; snippet:string|null; content:string|null; fetch_status:"fetched"|"failed"|null; fetch_error:string|null; selected:boolean; adopted_operation_id:string|null; created_at:string; }
const asIso = (value:string) => new Date(value).toISOString();
const conversation = (r:ConversationRow):ReportConversation => ({id:r.id,taskId:r.task_id,blockId:r.block_id,createdAt:asIso(r.created_at),updatedAt:asIso(r.updated_at)});
const message = (r:MessageRow):ReportMessage => ({id:r.id,conversationId:r.conversation_id,taskId:r.task_id,blockId:r.block_id,role:r.role,content:r.content,documentVersion:Number(r.document_version),blockFingerprint:r.block_fingerprint,createdAt:asIso(r.created_at)});
const operation = (r:OperationRow):ReportEditOperation => ({id:r.id,taskId:r.task_id,conversationId:r.conversation_id,blockId:r.block_id,scope:r.scope,blockIds:r.block_ids ?? [],...(r.range_start === null ? {} : {rangeStart:Number(r.range_start)}),...(r.range_end === null ? {} : {rangeEnd:Number(r.range_end)}),documentVersion:Number(r.document_version),originalFingerprint:r.original_fingerprint,originalMarkdown:r.original_markdown,replacementMarkdown:r.replacement_markdown,origin:r.origin,state:r.state,createdAt:asIso(r.created_at),updatedAt:asIso(r.updated_at),...(r.applied_version === null ? {} : {appliedVersion:Number(r.applied_version)}),...(r.undone_operation_id ? {undoneOperationId:r.undone_operation_id} : {}),...(r.source_ids?.length ? {sourceIds:r.source_ids} : {})});
const session = (r:SessionRow):ReportSearchSession => ({id:r.id,taskId:r.task_id,scopeKey:r.scope_key,query:r.query,retrievers:r.retrievers ?? [],createdAt:asIso(r.created_at)});
const result = (r:ResultRow):ReportSearchResult => ({id:r.id,sessionId:r.session_id,taskId:r.task_id,provider:r.provider,title:r.title,url:r.url,...(r.snippet ? {snippet:r.snippet}:{}),...(r.content ? {content:r.content}:{}),...(r.fetch_status ? {fetchStatus:r.fetch_status}:{}),...(r.fetch_error ? {fetchError:r.fetch_error}:{}),selected:r.selected,...(r.adopted_operation_id ? {adoptedOperationId:r.adopted_operation_id}:{}),createdAt:asIso(r.created_at)});
