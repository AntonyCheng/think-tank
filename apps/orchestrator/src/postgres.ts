import { Pool, type PoolClient, type QueryResultRow } from "pg";

export class PostgresDatabase {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    if (!connectionString.trim()) {
      throw new Error("DATABASE_URL is required.");
    }
    this.#pool = new Pool({
      connectionString,
      max: 12,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      application_name: "thinktank-orchestrator",
    });
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Row[]> {
    const result = await this.#pool.query<Row>(text, [...values]);
    return result.rows;
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS research_tasks (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          snapshot_json JSONB NOT NULL,
          owner_user_id TEXT
        );
        CREATE INDEX IF NOT EXISTS research_tasks_status_updated
          ON research_tasks(status, updated_at DESC);
        CREATE TABLE IF NOT EXISTS app_users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          username_normalized TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
          active BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_login_at TIMESTAMPTZ
        );
        CREATE TABLE IF NOT EXISTS app_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS app_sessions_active_token
          ON app_sessions(token_hash) WHERE revoked_at IS NULL;
        ALTER TABLE research_tasks ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
        CREATE INDEX IF NOT EXISTS research_tasks_owner_updated
          ON research_tasks(owner_user_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS research_task_events (
          task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
          event_id INTEGER NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL,
          type TEXT NOT NULL,
          data_json JSONB NOT NULL,
          PRIMARY KEY (task_id, event_id)
        );
        CREATE TABLE IF NOT EXISTS research_task_diagnostics (
          task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
          diagnostic_id INTEGER NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL,
          ao_step_id TEXT NOT NULL,
          research_run_id TEXT NOT NULL,
          raw_type TEXT NOT NULL,
          raw_stage TEXT NOT NULL,
          data_json JSONB NOT NULL,
          truncated BOOLEAN NOT NULL,
          PRIMARY KEY (task_id, diagnostic_id)
        );
        CREATE TABLE IF NOT EXISTS research_task_checkpoints (
          task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          checkpoint_json JSONB NOT NULL,
          PRIMARY KEY (task_id, run_id, sequence)
        );
        CREATE TABLE IF NOT EXISTS research_task_evidence_bundles (
          task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
          bundle_index INTEGER NOT NULL,
          bundle_json JSONB NOT NULL,
          PRIMARY KEY (task_id, bundle_index)
        );
        CREATE TABLE IF NOT EXISTS runtime_settings (
          id SMALLINT PRIMARY KEY CHECK (id = 1),
          settings_json JSONB NOT NULL,
          secrets_ciphertext TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS report_documents (
          task_id TEXT PRIMARY KEY,
          baseline_markdown TEXT NOT NULL,
          current_markdown TEXT NOT NULL,
          version INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS report_document_versions (
          task_id TEXT NOT NULL REFERENCES report_documents(task_id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          markdown TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY(task_id, version)
        );
        CREATE TABLE IF NOT EXISTS report_document_drafts (
          task_id TEXT PRIMARY KEY REFERENCES report_documents(task_id) ON DELETE CASCADE,
          markdown TEXT NOT NULL,
          base_version INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS report_conversations (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          block_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
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
          created_at TIMESTAMPTZ NOT NULL,
          created_sequence BIGSERIAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS report_messages_conversation
          ON report_messages(conversation_id, created_at, id);
        ALTER TABLE report_messages ADD COLUMN IF NOT EXISTS operation_id TEXT;
        ALTER TABLE report_messages ADD COLUMN IF NOT EXISTS created_sequence BIGINT;
        CREATE SEQUENCE IF NOT EXISTS report_messages_created_sequence_seq;
        ALTER SEQUENCE report_messages_created_sequence_seq
          OWNED BY report_messages.created_sequence;
        ALTER TABLE report_messages ALTER COLUMN created_sequence
          SET DEFAULT nextval('report_messages_created_sequence_seq');
        WITH ordered_messages AS (
          SELECT ctid, row_number() OVER (ORDER BY created_at, ctid) AS sequence
          FROM report_messages
          WHERE created_sequence IS NULL
        )
        UPDATE report_messages
        SET created_sequence = ordered_messages.sequence
        FROM ordered_messages
        WHERE report_messages.ctid = ordered_messages.ctid;
        SELECT setval(
          'report_messages_created_sequence_seq',
          GREATEST(COALESCE((SELECT MAX(created_sequence) FROM report_messages), 1), 1),
          true
        );
        ALTER TABLE report_messages ALTER COLUMN created_sequence SET NOT NULL;
        CREATE INDEX IF NOT EXISTS report_messages_conversation_sequence
          ON report_messages(conversation_id, created_sequence);
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
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          applied_version INTEGER,
          undone_operation_id TEXT,
          scope TEXT NOT NULL DEFAULT 'blocks',
          block_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
          source_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
          applied_range_start INTEGER,
          applied_range_end INTEGER,
          applied_scope_markdown TEXT,
          applied_block_ids JSONB,
          structural_change TEXT,
          placement TEXT NOT NULL DEFAULT 'replace'
        );
        ALTER TABLE report_edit_operations ADD COLUMN IF NOT EXISTS applied_range_start INTEGER;
        ALTER TABLE report_edit_operations ADD COLUMN IF NOT EXISTS applied_range_end INTEGER;
        ALTER TABLE report_edit_operations ADD COLUMN IF NOT EXISTS applied_scope_markdown TEXT;
        ALTER TABLE report_edit_operations ADD COLUMN IF NOT EXISTS applied_block_ids JSONB;
        ALTER TABLE report_edit_operations ADD COLUMN IF NOT EXISTS structural_change TEXT;
        ALTER TABLE report_edit_operations ADD COLUMN IF NOT EXISTS placement TEXT NOT NULL DEFAULT 'replace';
        CREATE INDEX IF NOT EXISTS report_edit_operations_task
          ON report_edit_operations(task_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS report_search_sessions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          scope_key TEXT NOT NULL,
          query TEXT NOT NULL,
          retrievers JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
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
          selected BOOLEAN NOT NULL DEFAULT false,
          adopted_operation_id TEXT,
          created_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS report_search_results_task_session
          ON report_search_results(task_id, session_id, created_at, id);
        INSERT INTO schema_migrations(version) VALUES (1)
          ON CONFLICT (version) DO NOTHING;
      `);
    });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export function postgresJson(value: unknown): string {
  return JSON.stringify(value);
}
