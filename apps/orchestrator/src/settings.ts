import type { LLMConfig } from "agency-orchestrator";
import {
  RESEARCH_RETRIEVERS,
  type ResearchRetriever,
} from "./research-profile.js";

export interface RuntimeSettings {
  planner: LLMConfig & { api_key: string; model: string };
  fallback?: ModelProviderSettings;
  verifierModel?: string;
  gptrServiceUrl: string;
  retriever: ResearchRetriever;
  retrievers: readonly ResearchRetriever[];
  retrieverApiKeys: Partial<Record<ResearchRetriever, string>>;
  gptrFastLlm: string;
  gptrSmartLlm: string;
  gptrEmbedding: string;
  gptrEmbeddingBaseUrl?: string;
  gptrEmbeddingApiKey?: string;
  timeZone: string;
  concurrency: number;
  modelPreflightTimeoutMs: number;
  gptrHealthTimeoutMs: number;
  gptrResearchTimeoutMs: number;
  gptrCleanupGraceMs: number;
  taskExecutionTimeoutMs: number;
  gptrTaskConcurrencyBudget: number;
  gptrDeepLimits: {
    maxBreadth: number;
    maxDepth: number;
    maxResearchCalls: number;
  };
}

export interface ModelProviderSettings {
  baseUrl: string;
  apiKey: string;
  plannerModel: string;
  verifierModel: string;
  fastLlm: string;
  smartLlm: string;
}

export function settingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeSettings {
  const apiKey = required(env, "OPENAI_API_KEY");
  const plannerModel = required(env, "AO_PLANNER_MODEL");
  const plannerMaxTokens = positiveInteger(
    env,
    "AO_PLANNER_MAX_TOKENS",
    8_192,
  );
  const gptrFastLlm = normalizeGptrModel(required(env, "GPTR_FAST_LLM"));
  const gptrSmartLlm = normalizeGptrModel(required(env, "GPTR_SMART_LLM"));
  const gptrEmbedding = normalizeEmbedding(
    required(env, "GPTR_EMBEDDING"),
  );
  const fallback = fallbackProviderFromEnv(env);
  const retrievers = parseRetrievers(env.RETRIEVER ?? "duckduckgo");
  const retriever = retrievers[0]!;
  const timeZone = applicationTimeZone(env.APP_TIMEZONE);

  const concurrency = Number(env.AO_CONCURRENCY ?? "2");
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("AO_CONCURRENCY must be a positive integer.");
  }
  const modelPreflightTimeoutMs = positiveInteger(
    env,
    "MODEL_PREFLIGHT_TIMEOUT_MS",
    30_000,
  );
  const gptrHealthTimeoutMs = positiveInteger(
    env,
    "GPTR_HEALTH_TIMEOUT_MS",
    5_000,
  );
  const gptrResearchTimeoutMs = positiveInteger(
    env,
    "GPTR_RESEARCH_TIMEOUT_MS",
    30 * 60 * 1_000,
  );
  const gptrCleanupGraceMs = positiveInteger(
    env,
    "GPTR_CLEANUP_GRACE_MS",
    20_000,
  );
  if (gptrCleanupGraceMs >= gptrResearchTimeoutMs) {
    throw new Error(
      "GPTR_CLEANUP_GRACE_MS must be smaller than GPTR_RESEARCH_TIMEOUT_MS.",
    );
  }
  const taskExecutionTimeoutMs = positiveInteger(
    env,
    "TASK_EXECUTION_TIMEOUT_MS",
    2 * 60 * 60 * 1_000,
  );
  const gptrTaskConcurrencyBudget = positiveInteger(
    env,
    "GPTR_TASK_CONCURRENCY_BUDGET",
    4,
  );
  const gptrDeepLimits = {
    maxBreadth: positiveInteger(env, "GPTR_DEEP_MAX_BREADTH", 4),
    maxDepth: positiveInteger(env, "GPTR_DEEP_MAX_DEPTH", 3),
    maxResearchCalls: positiveInteger(
      env,
      "GPTR_DEEP_MAX_RESEARCH_CALLS",
      32,
    ),
  };

  return {
    planner: {
      provider: "openai",
      api_key: apiKey,
      base_url: env.OPENAI_BASE_URL,
      model: plannerModel,
      max_tokens: plannerMaxTokens,
    },
    ...(fallback ? { fallback } : {}),
    verifierModel: env.AO_VERIFIER_MODEL || undefined,
    gptrServiceUrl: env.GPTR_SERVICE_URL ?? "http://127.0.0.1:8010",
    retriever,
    retrievers: Object.freeze(retrievers),
    retrieverApiKeys: retrieverApiKeysFromEnv(env),
    gptrFastLlm,
    gptrSmartLlm,
    gptrEmbedding,
    gptrEmbeddingBaseUrl:
      env.GPTR_EMBEDDING_BASE_URL?.trim()
      || env.OPENAI_BASE_URL?.trim()
      || undefined,
    gptrEmbeddingApiKey: env.GPTR_EMBEDDING_API_KEY?.trim() || undefined,
    timeZone,
    concurrency,
    modelPreflightTimeoutMs,
    gptrHealthTimeoutMs,
    gptrResearchTimeoutMs,
    gptrCleanupGraceMs,
    taskExecutionTimeoutMs,
    gptrTaskConcurrencyBudget,
    gptrDeepLimits,
  };
}

function fallbackProviderFromEnv(
  env: NodeJS.ProcessEnv,
): ModelProviderSettings | undefined {
  const enabled = env.FALLBACK_MODEL_ENABLED?.trim().toLowerCase();
  if (enabled === "false") {
    return undefined;
  }
  const values = {
    baseUrl: env.FALLBACK_OPENAI_BASE_URL?.trim() ?? "",
    apiKey: env.FALLBACK_OPENAI_API_KEY?.trim() ?? "",
    plannerModel: env.FALLBACK_AO_PLANNER_MODEL?.trim() ?? "",
    verifierModel: env.FALLBACK_AO_VERIFIER_MODEL?.trim() ?? "",
    fastLlm: env.FALLBACK_GPTR_FAST_LLM?.trim() ?? "",
    smartLlm: env.FALLBACK_GPTR_SMART_LLM?.trim() ?? "",
  };
  // A stored API key alone must not activate the backup route. This allows an
  // administrator to save that secret before filling in the provider fields.
  const hasProviderFields = [
    values.baseUrl,
    values.plannerModel,
    values.verifierModel,
    values.fastLlm,
    values.smartLlm,
  ].some(Boolean);
  if (enabled !== "true" && !hasProviderFields) return undefined;
  const requiredValues: Array<[string, string]> = [
    ["FALLBACK_OPENAI_BASE_URL", values.baseUrl],
    ["FALLBACK_OPENAI_API_KEY", values.apiKey],
    ["FALLBACK_AO_PLANNER_MODEL", values.plannerModel],
    ["FALLBACK_AO_VERIFIER_MODEL", values.verifierModel],
    ["FALLBACK_GPTR_FAST_LLM", values.fastLlm],
    ["FALLBACK_GPTR_SMART_LLM", values.smartLlm],
  ];
  const missing = requiredValues.find(([, value]) => !value);
  if (missing) throw new Error(`${missing[0]} is required when fallback provider is configured.`);
  return {
    baseUrl: values.baseUrl,
    apiKey: values.apiKey,
    plannerModel: values.plannerModel,
    verifierModel: values.verifierModel,
    fastLlm: normalizeGptrModel(values.fastLlm),
    smartLlm: normalizeGptrModel(values.smartLlm),
  };
}

function retrieverApiKeysFromEnv(
  env: NodeJS.ProcessEnv,
): Partial<Record<ResearchRetriever, string>> {
  const tavilyApiKey = env.TAVILY_API_KEY?.trim();
  return tavilyApiKey ? { tavily: tavilyApiKey } : {};
}

function parseRetrievers(value: string): ResearchRetriever[] {
  const retrievers = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (retrievers.length < 1 || retrievers.length > 5) {
    throw new Error("RETRIEVER must contain between 1 and 5 retrievers.");
  }
  const unknown = retrievers.filter(
    (item) => !RESEARCH_RETRIEVERS.includes(item as ResearchRetriever),
  );
  if (unknown.length > 0) {
    throw new Error(`RETRIEVER contains unsupported value '${unknown[0]}'.`);
  }
  if (new Set(retrievers).size !== retrievers.length) {
    throw new Error("RETRIEVER must not contain duplicates.");
  }
  return retrievers as ResearchRetriever[];
}

function applicationTimeZone(configured: string | undefined): string {
  const timeZone = configured?.trim()
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error("APP_TIMEZONE must be a valid IANA time zone.");
  }
  return timeZone;
}

function normalizeEmbedding(model: string): string {
  return model.includes(":") ? model : `custom:${model}`;
}

function normalizeGptrModel(model: string): string {
  return model.includes(":") ? model : `openai:${model}`;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
