import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  settingsFromEnv,
  type RuntimeSettings,
} from "./settings.js";
import type { ResearchRetriever } from "./research-profile.js";

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
}

export interface PublicRuntimeSettings extends EditableRuntimeSettings {
  retriever: ResearchRetriever;
  apiKeyConfigured: boolean;
}

export interface RetrieverSelectionConstraints {
  retrievers: readonly ResearchRetriever[];
  maxRetrievers: number;
}

type PersistedRuntimeSettings = Partial<EditableRuntimeSettings> & {
  retriever?: ResearchRetriever;
};

export class RuntimeSettingsStore {
  readonly #baseEnv: NodeJS.ProcessEnv;
  readonly #filePath?: string;
  #overrides: Partial<EditableRuntimeSettings>;

  constructor(
    baseEnv: NodeJS.ProcessEnv = process.env,
    filePath?: string,
  ) {
    this.#baseEnv = { ...baseEnv };
    this.#filePath = filePath;
    this.#overrides = this.#load();
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
      gptrFastLlm: runtime.gptrFastLlm,
      gptrSmartLlm: runtime.gptrSmartLlm,
      gptrEmbedding: runtime.gptrEmbedding,
      gptrEmbeddingBaseUrl: runtime.gptrEmbeddingBaseUrl ?? "",
      retrievers: [...runtime.retrievers],
      retriever: runtime.retriever,
      concurrency: runtime.concurrency,
      apiKeyConfigured: Boolean(runtime.planner.api_key),
    };
  }

  setApiKey(apiKey: string): void {
    if (!apiKey.trim()) {
      throw new Error("API Key must not be empty.");
    }
    this.#baseEnv.OPENAI_API_KEY = apiKey.trim();
  }

  update(
    input: Record<string, unknown>,
    constraints?: RetrieverSelectionConstraints,
  ): PublicRuntimeSettings {
    const current = this.getPublicSettings();
    const candidate: EditableRuntimeSettings = {
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

    assertRetrieverSelection(candidate.retrievers, constraints);
    // Reuse the same validation and normalization as task execution.
    settingsFromEnv(this.#mergedEnv(candidate));
    this.#overrides = candidate;
    this.#persist();
    return this.getPublicSettings();
  }

  #mergedEnv(
    overrides: Partial<EditableRuntimeSettings>,
  ): NodeJS.ProcessEnv {
    return {
      ...this.#baseEnv,
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
    };
  }

  #load(): Partial<EditableRuntimeSettings> {
    if (!this.#filePath || !existsSync(this.#filePath)) {
      return {};
    }
    const parsed = JSON.parse(
      readFileSync(this.#filePath, "utf8"),
    ) as PersistedRuntimeSettings;
    const migrated: Partial<EditableRuntimeSettings> = {
      ...parsed,
      ...(parsed.retrievers
        ? { retrievers: parsed.retrievers }
        : parsed.retriever
        ? { retrievers: [parsed.retriever] }
        : {}),
    };
    delete (migrated as PersistedRuntimeSettings).retriever;
    // Invalid persisted settings fail loudly at startup/use rather than
    // silently running research against an unintended endpoint.
    settingsFromEnv(this.#mergedEnv(migrated));
    return migrated;
  }

  #persist(): void {
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
