import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  settingsFromEnv,
  type RuntimeSettings,
} from "./settings.js";
import {
  RESEARCH_RETRIEVERS,
  type ResearchRetriever,
} from "./research-profile.js";
import type { PostgresDatabase } from "./postgres.js";
import { postgresJson } from "./postgres.js";
import { PostgresWriteQueue } from "./postgres-write-queue.js";

export interface EditableRuntimeSettings {
  openaiBaseUrl: string;
  aoPlannerModel: string;
  aoVerifierModel: string;
  gptrFastLlm: string;
  gptrSmartLlm: string;
  gptrEmbedding: string;
  gptrEmbeddingBaseUrl: string;
  retrievers: ResearchRetriever[];
  concurrency: number;
  fallbackEnabled: boolean;
  fallbackOpenaiBaseUrl: string;
  fallbackAoPlannerModel: string;
  fallbackAoVerifierModel: string;
  fallbackGptrFastLlm: string;
  fallbackGptrSmartLlm: string;
}

export interface PublicRuntimeSettings extends EditableRuntimeSettings {
  retriever: ResearchRetriever;
  apiKeyConfigured: boolean;
  embeddingApiKeyConfigured: boolean;
  configuredRetrieverCredentials: ResearchRetriever[];
  fallbackEnabled: boolean;
  fallbackOpenaiBaseUrl: string;
  fallbackAoPlannerModel: string;
  fallbackAoVerifierModel: string;
  fallbackGptrFastLlm: string;
  fallbackGptrSmartLlm: string;
  fallbackApiKeyConfigured: boolean;
}

export interface RetrieverSelectionConstraints {
  retrievers: readonly ResearchRetriever[];
  maxRetrievers: number;
}

type LegacyPersistedRuntimeSettings = Partial<EditableRuntimeSettings> & {
  retriever?: ResearchRetriever;
};

interface RuntimeSettingSecrets {
  apiKey?: string;
  fallbackApiKey?: string;
  embeddingApiKey?: string;
  retrieverApiKeys?: Partial<Record<ResearchRetriever, string>>;
}

interface PersistedRuntimeSettings {
  settings: Partial<EditableRuntimeSettings>;
  secrets: RuntimeSettingSecrets;
}

export interface RuntimeSettingsPersistence {
  load(): PersistedRuntimeSettings | undefined;
  save(value: PersistedRuntimeSettings): void;
}

export class SqliteRuntimeSettingsPersistence
  implements RuntimeSettingsPersistence {
  readonly #key: Buffer;

  constructor(database: DatabaseSync, encryptionSecret: string) {
    if (!encryptionSecret.trim()) {
      throw new Error(
        "ORCHESTRATOR_SERVICE_API_KEY is required to encrypt runtime settings.",
      );
    }
    this.#key = createHash("sha256")
      .update("think-tank/runtime-settings/v1\\0")
      .update(encryptionSecret)
      .digest();
    database.exec(`
      CREATE TABLE IF NOT EXISTS runtime_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings_json TEXT NOT NULL,
        secrets_ciphertext TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.#database = database;
  }

  readonly #database: DatabaseSync;

  load(): PersistedRuntimeSettings | undefined {
    const row = this.#database.prepare(`
      SELECT settings_json, secrets_ciphertext
      FROM runtime_settings
      WHERE id = 1
    `).get() as {
      settings_json: string;
      secrets_ciphertext: string;
    } | undefined;
    if (!row) return undefined;
    return {
      settings: JSON.parse(row.settings_json) as Partial<EditableRuntimeSettings>,
      secrets: this.#decrypt(row.secrets_ciphertext),
    };
  }

  save(value: PersistedRuntimeSettings): void {
    this.#database.prepare(`
      INSERT INTO runtime_settings(
        id, settings_json, secrets_ciphertext, updated_at
      ) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        settings_json = excluded.settings_json,
        secrets_ciphertext = excluded.secrets_ciphertext,
        updated_at = excluded.updated_at
    `).run(
      JSON.stringify(value.settings),
      this.#encrypt(value.secrets),
      new Date().toISOString(),
    );
  }

  #encrypt(secrets: RuntimeSettingSecrets): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(secrets), "utf8"),
      cipher.final(),
    ]);
    return JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
  }

  #decrypt(value: string): RuntimeSettingSecrets {
    const envelope = JSON.parse(value) as {
      version?: unknown;
      iv?: unknown;
      tag?: unknown;
      ciphertext?: unknown;
    };
    if (
      envelope.version !== 1 ||
      typeof envelope.iv !== "string" ||
      typeof envelope.tag !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      throw new Error("Runtime settings secrets are malformed.");
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8")) as RuntimeSettingSecrets;
    } catch {
      throw new Error(
        "Runtime settings secrets cannot be decrypted with the current service key.",
      );
    }
  }
}

/** PostgreSQL-backed persistence with synchronous cache reads for runtime settings. */
export class PostgresRuntimeSettingsPersistence
  implements RuntimeSettingsPersistence {
  readonly #key: Buffer;
  readonly #writes: PostgresWriteQueue;
  #value: PersistedRuntimeSettings | undefined;

  constructor(database: PostgresDatabase, encryptionSecret: string) {
    if (!encryptionSecret.trim()) {
      throw new Error(
        "ORCHESTRATOR_SERVICE_API_KEY is required to encrypt runtime settings.",
      );
    }
    this.#key = createHash("sha256")
      .update("think-tank/runtime-settings/v1\\0")
      .update(encryptionSecret)
      .digest();
    this.#writes = new PostgresWriteQueue(database);
  }

  async initialize(): Promise<void> {
    const rows = await this.#writes.connection.query<{
      settings_json: Partial<EditableRuntimeSettings>;
      secrets_ciphertext: string;
    }>("SELECT settings_json, secrets_ciphertext FROM runtime_settings WHERE id = 1");
    const row = rows[0];
    this.#value = row
      ? { settings: row.settings_json, secrets: this.#decrypt(row.secrets_ciphertext) }
      : undefined;
  }

  load(): PersistedRuntimeSettings | undefined {
    return this.#value ? structuredClone(this.#value) : undefined;
  }

  save(value: PersistedRuntimeSettings): void {
    const copy = structuredClone(value);
    this.#value = copy;
    const ciphertext = this.#encrypt(copy.secrets);
    this.#writes.enqueue(async () => {
      await this.#writes.connection.query(`
        INSERT INTO runtime_settings(id, settings_json, secrets_ciphertext, updated_at)
        VALUES(1, $1::jsonb, $2, $3)
        ON CONFLICT(id) DO UPDATE SET settings_json=EXCLUDED.settings_json,
          secrets_ciphertext=EXCLUDED.secrets_ciphertext, updated_at=EXCLUDED.updated_at
      `, [postgresJson(copy.settings), ciphertext, new Date().toISOString()]);
    });
  }

  async drain(): Promise<void> { await this.#writes.drain(); }

  #encrypt(secrets: RuntimeSettingSecrets): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(secrets), "utf8"),
      cipher.final(),
    ]);
    return JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
  }

  #decrypt(value: string): RuntimeSettingSecrets {
    const envelope = JSON.parse(value) as {
      version?: unknown; iv?: unknown; tag?: unknown; ciphertext?: unknown;
    };
    if (envelope.version !== 1 || typeof envelope.iv !== "string" ||
      typeof envelope.tag !== "string" || typeof envelope.ciphertext !== "string") {
      throw new Error("Runtime settings secrets are malformed.");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final(),
      ]).toString("utf8")) as RuntimeSettingSecrets;
    } catch {
      throw new Error("Runtime settings secrets cannot be decrypted with the current service key.");
    }
  }
}

export class RuntimeSettingsStore {
  readonly #baseEnv: NodeJS.ProcessEnv;
  readonly #filePath?: string;
  readonly #persistence?: RuntimeSettingsPersistence;
  #overrides: Partial<EditableRuntimeSettings>;
  #secrets: RuntimeSettingSecrets;

  constructor(
    baseEnv: NodeJS.ProcessEnv = process.env,
    filePath?: string,
    persistence?: RuntimeSettingsPersistence,
  ) {
    this.#baseEnv = { ...baseEnv };
    this.#filePath = filePath;
    this.#persistence = persistence;
    const persisted = persistence?.load();
    this.#secrets = {
      apiKey: persisted?.secrets.apiKey ?? this.#baseEnv.OPENAI_API_KEY,
      fallbackApiKey: persisted?.secrets.fallbackApiKey ?? this.#baseEnv.FALLBACK_OPENAI_API_KEY,
      embeddingApiKey: persisted?.secrets.embeddingApiKey ??
        this.#baseEnv.GPTR_EMBEDDING_API_KEY,
      retrieverApiKeys: persisted?.secrets.retrieverApiKeys ??
        retrieverApiKeysFromEnvironment(this.#baseEnv),
    };
    this.#overrides = persisted?.settings ?? this.#loadLegacy();
    // A deployment's existing runtime.env/settings.json is imported once.
    // Subsequent UI saves use the database and never rewrite environment files.
    if (this.#persistence && !persisted) this.#persist();
  }

  get persistsToDatabase(): boolean {
    return Boolean(this.#persistence);
  }

  getRuntimeSettings(): RuntimeSettings {
    return settingsFromEnv(this.#mergedEnv(this.#overrides));
  }

  getPublicSettings(): PublicRuntimeSettings {
    const runtime = this.getRuntimeSettings();
    return {
      openaiBaseUrl: runtime.planner.base_url ?? "",
      aoPlannerModel: runtime.planner.model,
      aoVerifierModel: runtime.verifierModel ?? "",
      gptrFastLlm: publicModelName(runtime.gptrFastLlm, "openai:"),
      gptrSmartLlm: publicModelName(runtime.gptrSmartLlm, "openai:"),
      gptrEmbedding: publicModelName(runtime.gptrEmbedding, "custom:"),
      gptrEmbeddingBaseUrl: runtime.gptrEmbeddingBaseUrl ?? "",
      retrievers: [...runtime.retrievers],
      retriever: runtime.retriever,
      concurrency: runtime.concurrency,
      apiKeyConfigured: Boolean(runtime.planner.api_key),
      embeddingApiKeyConfigured: Boolean(runtime.gptrEmbeddingApiKey),
      configuredRetrieverCredentials: Object.keys(runtime.retrieverApiKeys)
        .filter((retriever): retriever is ResearchRetriever =>
          RESEARCH_RETRIEVERS.includes(retriever as ResearchRetriever)
        ),
      fallbackEnabled: Boolean(runtime.fallback),
      fallbackOpenaiBaseUrl: runtime.fallback?.baseUrl ?? "",
      fallbackAoPlannerModel: runtime.fallback?.plannerModel ?? "",
      fallbackAoVerifierModel: runtime.fallback?.verifierModel ?? "",
      fallbackGptrFastLlm: publicModelName(runtime.fallback?.fastLlm ?? "", "openai:"),
      fallbackGptrSmartLlm: publicModelName(runtime.fallback?.smartLlm ?? "", "openai:"),
      fallbackApiKeyConfigured: Boolean(runtime.fallback?.apiKey),
    };
  }

  setApiKey(apiKey: string): void {
    if (!apiKey.trim()) {
      throw new Error("API Key must not be empty.");
    }
    this.#secrets.apiKey = apiKey.trim();
  }

  setEmbeddingApiKey(apiKey: string): void {
    if (!apiKey.trim()) {
      throw new Error("Embedding API Key must not be empty.");
    }
    this.#secrets.embeddingApiKey = apiKey.trim();
  }

  setFallbackApiKey(apiKey: string): void {
    if (!apiKey.trim()) {
      throw new Error("Fallback API Key must not be empty.");
    }
    this.#secrets.fallbackApiKey = apiKey.trim();
  }

  setRetrieverApiKeys(
    apiKeys: Partial<Record<ResearchRetriever, string>>,
  ): void {
    const current = this.#secrets.retrieverApiKeys ?? {};
    this.#secrets.retrieverApiKeys = {
      ...current,
      ...Object.fromEntries(
        Object.entries(apiKeys).flatMap(([retriever, apiKey]) => {
          const normalized = apiKey?.trim();
          return normalized && RESEARCH_RETRIEVERS.includes(
            retriever as ResearchRetriever,
          )
            ? [[retriever, normalized]]
            : [];
        }),
      ) as Partial<Record<ResearchRetriever, string>>,
    };
  }

  preview(
    input: Record<string, unknown>,
    secrets: {
      apiKey?: string;
      fallbackApiKey?: string;
      embeddingApiKey?: string;
      retrieverApiKeys?: Partial<Record<ResearchRetriever, string>>;
    } = {},
    constraints?: RetrieverSelectionConstraints,
  ): RuntimeSettings {
    const candidate = this.#candidate(input);
    assertRetrieverSelection(candidate.retrievers, constraints);
    return settingsFromEnv(this.#mergedEnv(candidate, {
      ...this.#secrets,
      ...(secrets.apiKey ? { apiKey: secrets.apiKey } : {}),
      ...(secrets.fallbackApiKey ? { fallbackApiKey: secrets.fallbackApiKey } : {}),
      ...(secrets.embeddingApiKey
        ? { embeddingApiKey: secrets.embeddingApiKey }
        : {}),
      retrieverApiKeys: {
        ...(this.#secrets.retrieverApiKeys ?? {}),
        ...(secrets.retrieverApiKeys ?? {}),
      },
    }));
  }

  update(
    input: Record<string, unknown>,
    constraints?: RetrieverSelectionConstraints,
  ): PublicRuntimeSettings {
    const candidate = this.#candidate(input);
    assertRetrieverSelection(candidate.retrievers, constraints);
    // Reuse the same validation and normalization as task execution.
    settingsFromEnv(this.#mergedEnv(candidate));
    this.#overrides = candidate;
    this.#persist();
    return this.getPublicSettings();
  }

  #candidate(input: Record<string, unknown>): EditableRuntimeSettings {
    const current = this.getPublicSettings();
    return {
      openaiBaseUrl: stringValue(
        input.openaiBaseUrl,
        current.openaiBaseUrl,
      ),
      aoPlannerModel: stringValue(
        input.aoPlannerModel,
        current.aoPlannerModel,
      ),
      aoVerifierModel: optionalStringValue(
        input.aoVerifierModel,
        current.aoVerifierModel,
      ),
      fallbackEnabled: booleanValue(
        input.fallbackEnabled,
        current.fallbackEnabled,
      ),
      fallbackOpenaiBaseUrl: optionalStringValue(input.fallbackOpenaiBaseUrl, current.fallbackOpenaiBaseUrl),
      fallbackAoPlannerModel: optionalStringValue(input.fallbackAoPlannerModel, current.fallbackAoPlannerModel),
      fallbackAoVerifierModel: optionalStringValue(input.fallbackAoVerifierModel, current.fallbackAoVerifierModel),
      fallbackGptrFastLlm: optionalStringValue(input.fallbackGptrFastLlm, current.fallbackGptrFastLlm),
      fallbackGptrSmartLlm: optionalStringValue(input.fallbackGptrSmartLlm, current.fallbackGptrSmartLlm),
      gptrFastLlm: stringValue(
        input.gptrFastLlm,
        current.gptrFastLlm,
      ),
      gptrSmartLlm: stringValue(
        input.gptrSmartLlm,
        current.gptrSmartLlm,
      ),
      gptrEmbedding: stringValue(
        input.gptrEmbedding,
        current.gptrEmbedding,
      ),
      gptrEmbeddingBaseUrl: optionalStringValue(
        input.gptrEmbeddingBaseUrl,
        current.gptrEmbeddingBaseUrl,
      ),
      retrievers: retrieverListValue(
        input.retrievers ?? input.retriever,
        current.retrievers,
      ),
      concurrency: input.concurrency === undefined
        ? current.concurrency
        : Number(input.concurrency),
    };
  }

  #mergedEnv(
    overrides: Partial<EditableRuntimeSettings>,
    secrets: RuntimeSettingSecrets = this.#secrets,
  ): NodeJS.ProcessEnv {
    return {
      ...this.#baseEnv,
      ...(secrets.apiKey
        ? { OPENAI_API_KEY: secrets.apiKey }
        : {}),
      ...(secrets.fallbackApiKey
        ? { FALLBACK_OPENAI_API_KEY: secrets.fallbackApiKey }
        : {}),
      ...(secrets.embeddingApiKey
        ? { GPTR_EMBEDDING_API_KEY: secrets.embeddingApiKey }
        : {}),
      ...(secrets.retrieverApiKeys?.tavily
        ? { TAVILY_API_KEY: secrets.retrieverApiKeys.tavily }
        : {}),
      OPENAI_BASE_URL: overrides.openaiBaseUrl ??
        this.#baseEnv.OPENAI_BASE_URL,
      AO_PLANNER_MODEL: overrides.aoPlannerModel ??
        this.#baseEnv.AO_PLANNER_MODEL,
      AO_VERIFIER_MODEL: overrides.aoVerifierModel ??
        this.#baseEnv.AO_VERIFIER_MODEL,
      GPTR_FAST_LLM: overrides.gptrFastLlm ??
        this.#baseEnv.GPTR_FAST_LLM,
      GPTR_SMART_LLM: overrides.gptrSmartLlm ??
        this.#baseEnv.GPTR_SMART_LLM,
      GPTR_EMBEDDING: overrides.gptrEmbedding ??
        this.#baseEnv.GPTR_EMBEDDING,
      GPTR_EMBEDDING_BASE_URL: overrides.gptrEmbeddingBaseUrl ??
        this.#baseEnv.GPTR_EMBEDDING_BASE_URL,
      RETRIEVER: overrides.retrievers?.join(",")
        ?? this.#baseEnv.RETRIEVER,
      AO_CONCURRENCY: overrides.concurrency === undefined
        ? this.#baseEnv.AO_CONCURRENCY
        : String(overrides.concurrency),
      FALLBACK_MODEL_ENABLED: overrides.fallbackEnabled === undefined
        ? this.#baseEnv.FALLBACK_MODEL_ENABLED
        : String(overrides.fallbackEnabled),
      FALLBACK_OPENAI_BASE_URL: overrides.fallbackOpenaiBaseUrl ??
        this.#baseEnv.FALLBACK_OPENAI_BASE_URL,
      FALLBACK_AO_PLANNER_MODEL: overrides.fallbackAoPlannerModel ??
        this.#baseEnv.FALLBACK_AO_PLANNER_MODEL,
      FALLBACK_AO_VERIFIER_MODEL: overrides.fallbackAoVerifierModel ??
        this.#baseEnv.FALLBACK_AO_VERIFIER_MODEL,
      FALLBACK_GPTR_FAST_LLM: overrides.fallbackGptrFastLlm ??
        this.#baseEnv.FALLBACK_GPTR_FAST_LLM,
      FALLBACK_GPTR_SMART_LLM: overrides.fallbackGptrSmartLlm ??
        this.#baseEnv.FALLBACK_GPTR_SMART_LLM,
    };
  }

  #loadLegacy(): Partial<EditableRuntimeSettings> {
    if (!this.#filePath || !existsSync(this.#filePath)) {
      return {};
    }
    const parsed = JSON.parse(
      readFileSync(this.#filePath, "utf8"),
    ) as LegacyPersistedRuntimeSettings;
    const migrated: Partial<EditableRuntimeSettings> = {
      ...parsed,
      ...(parsed.retrievers
        ? { retrievers: parsed.retrievers }
        : parsed.retriever
        ? { retrievers: [parsed.retriever] }
        : {}),
    };
    delete (migrated as LegacyPersistedRuntimeSettings).retriever;
    // Invalid persisted settings fail loudly at startup/use rather than
    // silently running research against an unintended endpoint.
    settingsFromEnv(this.#mergedEnv(migrated));
    return migrated;
  }

  #persist(): void {
    if (this.#persistence) {
      this.#persistence.save({
        settings: this.#overrides,
        secrets: this.#secrets,
      });
      return;
    }
    if (!this.#filePath) return;
    mkdirSync(dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify(this.#overrides, null, 2)}\n`,
      "utf8",
    );
    renameSync(temporary, this.#filePath);
  }
}

function publicModelName(value: string, internalPrefix: string): string {
  return value.startsWith(internalPrefix) ? value.slice(internalPrefix.length) : value;
}

function retrieverApiKeysFromEnvironment(
  environment: NodeJS.ProcessEnv,
): Partial<Record<ResearchRetriever, string>> {
  const tavilyApiKey = environment.TAVILY_API_KEY?.trim();
  return tavilyApiKey ? { tavily: tavilyApiKey } : {};
}

function assertRetrieverSelection(
  retrievers: readonly ResearchRetriever[],
  constraints: RetrieverSelectionConstraints | undefined,
): void {
  if (!constraints) return;
  if (
    retrievers.length > constraints.maxRetrievers
    || retrievers.some(
      (retriever) => !constraints.retrievers.includes(retriever),
    )
  ) {
    throw new Error(
      "Selected retrievers must be available deployment capabilities.",
    );
  }
}

function stringValue(value: unknown, fallback: string): string {
  const result = value === undefined ? fallback : String(value).trim();
  if (!result) {
    throw new Error("required setting must not be empty");
  }
  return result;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

function optionalStringValue(value: unknown, fallback: string): string {
  return value === undefined ? fallback : String(value).trim();
}

function retrieverListValue(
  value: unknown,
  fallback: readonly ResearchRetriever[],
): ResearchRetriever[] {
  if (value === undefined) return [...fallback];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()) as ResearchRetriever[];
  }
  return [String(value).trim() as ResearchRetriever];
}
