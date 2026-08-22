import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { PostgresDatabase, postgresJson } from "./postgres.js";

const sourcePath = process.argv[2] ?? "/app/.think-tank/data/think-tank.sqlite";
const connectionString = process.env.DATABASE_URL ?? "";

if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL migration.");
if (!existsSync(sourcePath)) throw new Error(`SQLite source was not found: ${sourcePath}`);

const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
const postgres = new PostgresDatabase(connectionString);

try {
  await postgres.migrate();
  const tables = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
  await postgres.transaction(async (client) => {
    const copy = async (table: string, work: () => Promise<void>) => {
      if (!tables.has(table)) return;
      await work();
    };
    await copy("research_tasks", async () => {
      for (const row of sqlite.prepare("SELECT id,status,created_at,updated_at,snapshot_json FROM research_tasks").all() as Array<{ id:string; status:string; created_at:string; updated_at:string; snapshot_json:string }>) {
        await client.query(`INSERT INTO research_tasks(id,status,created_at,updated_at,snapshot_json) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,snapshot_json=EXCLUDED.snapshot_json`, [row.id,row.status,row.created_at,row.updated_at,normalizeJson(row.snapshot_json)]);
      }
    });
    await copy("research_task_events", async () => {
      for (const row of sqlite.prepare("SELECT task_id,event_id,timestamp,type,data_json FROM research_task_events").all() as Array<{task_id:string;event_id:number;timestamp:string;type:string;data_json:string}>) await client.query(`INSERT INTO research_task_events(task_id,event_id,timestamp,type,data_json) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(task_id,event_id) DO UPDATE SET timestamp=EXCLUDED.timestamp,type=EXCLUDED.type,data_json=EXCLUDED.data_json`, [row.task_id,row.event_id,row.timestamp,row.type,normalizeJson(row.data_json)]);
    });
    await copy("research_task_diagnostics", async () => {
      for (const row of sqlite.prepare("SELECT task_id,diagnostic_id,timestamp,ao_step_id,research_run_id,raw_type,raw_stage,data_json,truncated FROM research_task_diagnostics").all() as Array<{task_id:string;diagnostic_id:number;timestamp:string;ao_step_id:string;research_run_id:string;raw_type:string;raw_stage:string;data_json:string;truncated:number}>) await client.query(`INSERT INTO research_task_diagnostics(task_id,diagnostic_id,timestamp,ao_step_id,research_run_id,raw_type,raw_stage,data_json,truncated) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(task_id,diagnostic_id) DO UPDATE SET timestamp=EXCLUDED.timestamp,ao_step_id=EXCLUDED.ao_step_id,research_run_id=EXCLUDED.research_run_id,raw_type=EXCLUDED.raw_type,raw_stage=EXCLUDED.raw_stage,data_json=EXCLUDED.data_json,truncated=EXCLUDED.truncated`, [row.task_id,row.diagnostic_id,row.timestamp,row.ao_step_id,row.research_run_id,row.raw_type,row.raw_stage,normalizeJson(row.data_json),Boolean(row.truncated)]);
    });
    await copy("research_task_checkpoints", async () => {
      for (const row of sqlite.prepare("SELECT task_id,run_id,sequence,created_at,checkpoint_json FROM research_task_checkpoints").all() as Array<{task_id:string;run_id:string;sequence:number;created_at:string;checkpoint_json:string}>) await client.query(`INSERT INTO research_task_checkpoints(task_id,run_id,sequence,created_at,checkpoint_json) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(task_id,run_id,sequence) DO UPDATE SET created_at=EXCLUDED.created_at,checkpoint_json=EXCLUDED.checkpoint_json`, [row.task_id,row.run_id,row.sequence,row.created_at,normalizeJson(row.checkpoint_json)]);
    });
    await copy("research_task_evidence_bundles", async () => {
      for (const row of sqlite.prepare("SELECT task_id,bundle_index,bundle_json FROM research_task_evidence_bundles").all() as Array<{task_id:string;bundle_index:number;bundle_json:string}>) await client.query(`INSERT INTO research_task_evidence_bundles(task_id,bundle_index,bundle_json) VALUES($1,$2,$3::jsonb) ON CONFLICT(task_id,bundle_index) DO UPDATE SET bundle_json=EXCLUDED.bundle_json`, [row.task_id,row.bundle_index,normalizeJson(row.bundle_json)]);
    });
    await copy("runtime_settings", async () => {
      for (const row of sqlite.prepare("SELECT id,settings_json,secrets_ciphertext,updated_at FROM runtime_settings").all() as Array<{id:number;settings_json:string;secrets_ciphertext:string;updated_at:string}>) await client.query(`INSERT INTO runtime_settings(id,settings_json,secrets_ciphertext,updated_at) VALUES($1,$2::jsonb,$3,$4) ON CONFLICT(id) DO UPDATE SET settings_json=EXCLUDED.settings_json,secrets_ciphertext=EXCLUDED.secrets_ciphertext,updated_at=EXCLUDED.updated_at`, [row.id,normalizeJson(row.settings_json),row.secrets_ciphertext,row.updated_at]);
    });
    await copy("report_documents", async () => {
      for (const row of sqlite.prepare("SELECT task_id,baseline_markdown,current_markdown,version,created_at,updated_at FROM report_documents").all() as Array<{task_id:string;baseline_markdown:string;current_markdown:string;version:number;created_at:string;updated_at:string}>) await client.query(`INSERT INTO report_documents(task_id,baseline_markdown,current_markdown,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(task_id) DO UPDATE SET baseline_markdown=EXCLUDED.baseline_markdown,current_markdown=EXCLUDED.current_markdown,version=EXCLUDED.version,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at`, [row.task_id,row.baseline_markdown,row.current_markdown,row.version,row.created_at,row.updated_at]);
    });
    await copy("report_document_versions", async () => {
      for (const row of sqlite.prepare("SELECT task_id,version,markdown,created_at FROM report_document_versions").all() as Array<{task_id:string;version:number;markdown:string;created_at:string}>) await client.query(`INSERT INTO report_document_versions(task_id,version,markdown,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(task_id,version) DO UPDATE SET markdown=EXCLUDED.markdown,created_at=EXCLUDED.created_at`, [row.task_id,row.version,row.markdown,row.created_at]);
    });
    await copy("report_document_drafts", async () => {
      for (const row of sqlite.prepare("SELECT task_id,markdown,base_version,revision,updated_at FROM report_document_drafts").all() as Array<{task_id:string;markdown:string;base_version:number;revision:number;updated_at:string}>) await client.query(`INSERT INTO report_document_drafts(task_id,markdown,base_version,revision,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id) DO UPDATE SET markdown=EXCLUDED.markdown,base_version=EXCLUDED.base_version,revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at`, [row.task_id,row.markdown,row.base_version,row.revision,row.updated_at]);
    });
    await copyEditorTables(sqlite, tables, client);
  });
  const summary = await postgres.query<{ table_name: string; row_count: string }>(`SELECT table_name, row_count::text FROM (VALUES ('research_tasks', (SELECT count(*) FROM research_tasks)), ('research_task_events', (SELECT count(*) FROM research_task_events)), ('report_documents', (SELECT count(*) FROM report_documents)), ('runtime_settings', (SELECT count(*) FROM runtime_settings))) AS counts(table_name,row_count)`);
  process.stdout.write(`SQLite data imported to PostgreSQL: ${summary.map((item) => `${item.table_name}=${item.row_count}`).join(", ")}\n`);
} finally {
  sqlite.close();
  await postgres.close();
}

async function copyEditorTables(sqliteDatabase: DatabaseSync, tables: Set<string>, client: import("pg").PoolClient): Promise<void> {
  if (tables.has("report_conversations")) for (const r of sqliteDatabase.prepare("SELECT id,task_id,block_id,created_at,updated_at FROM report_conversations").all() as Array<Record<string, unknown>>) await client.query(`INSERT INTO report_conversations(id,task_id,block_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET task_id=EXCLUDED.task_id,block_id=EXCLUDED.block_id,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at`, [r.id,r.task_id,r.block_id,r.created_at,r.updated_at]);
  if (tables.has("report_messages")) {
    const messageColumns = new Set((sqliteDatabase.prepare("PRAGMA table_info(report_messages)").all() as Array<{ name: string }>).map((column) => column.name));
    const operationIdColumn = messageColumns.has("operation_id") ? "operation_id" : "NULL AS operation_id";
    const messages = sqliteDatabase.prepare(`SELECT id,conversation_id,task_id,block_id,${operationIdColumn},role,content,document_version,block_fingerprint,created_at FROM report_messages`).all() as Array<Record<string, unknown>>;
    for (const r of messages) await client.query(`INSERT INTO report_messages(id,conversation_id,task_id,block_id,operation_id,role,content,document_version,block_fingerprint,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET conversation_id=EXCLUDED.conversation_id,task_id=EXCLUDED.task_id,block_id=EXCLUDED.block_id,operation_id=EXCLUDED.operation_id,role=EXCLUDED.role,content=EXCLUDED.content,document_version=EXCLUDED.document_version,block_fingerprint=EXCLUDED.block_fingerprint,created_at=EXCLUDED.created_at`, [r.id,r.conversation_id,r.task_id,r.block_id,r.operation_id,r.role,r.content,r.document_version,r.block_fingerprint,r.created_at]);
  }
  if (tables.has("report_edit_operations")) {
    const operationColumns = new Set((sqliteDatabase.prepare("PRAGMA table_info(report_edit_operations)").all() as Array<{ name: string }>).map((column) => column.name));
    const placementColumn = operationColumns.has("placement") ? "placement" : "'replace' AS placement";
    for (const r of sqliteDatabase.prepare(`SELECT id,task_id,conversation_id,block_id,scope,block_ids,range_start,range_end,document_version,original_fingerprint,original_markdown,replacement_markdown,origin,state,created_at,updated_at,applied_version,undone_operation_id,source_ids,${placementColumn} FROM report_edit_operations`).all() as Array<Record<string, unknown>>) await client.query(`INSERT INTO report_edit_operations(id,task_id,conversation_id,block_id,scope,block_ids,range_start,range_end,document_version,original_fingerprint,original_markdown,replacement_markdown,origin,state,created_at,updated_at,applied_version,undone_operation_id,source_ids,placement) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,updated_at=EXCLUDED.updated_at,applied_version=EXCLUDED.applied_version,undone_operation_id=EXCLUDED.undone_operation_id,placement=EXCLUDED.placement`, [r.id,r.task_id,r.conversation_id,r.block_id,r.scope,normalizeJson(String(r.block_ids ?? "[]")),r.range_start,r.range_end,r.document_version,r.original_fingerprint,r.original_markdown,r.replacement_markdown,r.origin,r.state,r.created_at,r.updated_at,r.applied_version,r.undone_operation_id,normalizeJson(String(r.source_ids ?? "[]")),r.placement ?? "replace"]);
  }
  if (tables.has("report_search_sessions")) for (const r of sqliteDatabase.prepare("SELECT id,task_id,scope_key,query,retrievers,created_at FROM report_search_sessions").all() as Array<Record<string, unknown>>) await client.query(`INSERT INTO report_search_sessions(id,task_id,scope_key,query,retrievers,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(id) DO UPDATE SET scope_key=EXCLUDED.scope_key,query=EXCLUDED.query,retrievers=EXCLUDED.retrievers,created_at=EXCLUDED.created_at`, [r.id,r.task_id,r.scope_key,r.query,normalizeJson(String(r.retrievers)),r.created_at]);
  if (tables.has("report_search_results")) for (const r of sqliteDatabase.prepare("SELECT id,session_id,task_id,provider,title,url,snippet,content,fetch_status,fetch_error,selected,adopted_operation_id,created_at FROM report_search_results").all() as Array<Record<string, unknown>>) await client.query(`INSERT INTO report_search_results(id,session_id,task_id,provider,title,url,snippet,content,fetch_status,fetch_error,selected,adopted_operation_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO UPDATE SET selected=EXCLUDED.selected,adopted_operation_id=EXCLUDED.adopted_operation_id`, [r.id,r.session_id,r.task_id,r.provider,r.title,r.url,r.snippet,r.content,r.fetch_status,r.fetch_error,Boolean(r.selected),r.adopted_operation_id,r.created_at]);
}

function normalizeJson(value: string): string { return postgresJson(JSON.parse(value)); }
