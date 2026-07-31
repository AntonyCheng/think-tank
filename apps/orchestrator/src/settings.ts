import type { LLMConfig } from "agency-orchestrator";
import {
  RESEARCH_RETRIEVERS,
  type ResearchRetriever,
} from "./research-profile.js";

export interface RuntimeSettings {
  planner: LLMConfig & { api_key: string; model: string };
  verifierModel?: string;
  gptrServiceUrl: string;
  retriever: ResearchRetriever;
  retrievers: readonly ResearchRetriever[];
  gptrFastLlm: string;
  gptrSmartLlm: string;
  gptrEmbedding: string;
  gptrEmbeddingBaseUrl?: string;
  timeZone: string;
  concurrency: number;
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

export function settingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeSettings {
  const apiKey = required(env, "OPENAI_API_KEY");
  const plannerModel = required(env, "AO_PLANNER_MODEL");
  const gptrFastLlm = normalizeGptrModel(required(env, "GPTR_FAST_LLM"));
  const gptrSmartLlm = normalizeGptrModel(required(env, "GPTR_SMART_LLM"));
  const gptrEmbedding = normalizeEmbedding(
    required(env, "GPTR_EMBEDDING"),
  );
  const retrievers = parseRetrievers(env.RETRIEVER ?? "duckduckgo");
  const retriever = retrievers[0]!;
  const timeZone = applicationTimeZone(env.APP_TIMEZONE);

  const concurrency = Number(env.AO_CONCURRENCY ?? "2");
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("AO_CONCURRENCY must be a positive integer.");
  }
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
    },
    verifierModel: env.AO_VERIFIER_MODEL || undefined,
    gptrServiceUrl: env.GPTR_SERVICE_URL ?? "http://127.0.0.1:8010",
    retriever,
    retrievers: Object.freeze(retrievers),
    gptrFastLlm,
    gptrSmartLlm,
    gptrEmbedding,
    gptrEmbeddingBaseUrl:
      env.GPTR_EMBEDDING_BASE_URL?.trim()
      || env.OPENAI_BASE_URL?.trim()
      || undefined,
    timeZone,
    concurrency,
    gptrHealthTimeoutMs,
    gptrResearchTimeoutMs,
    gptrCleanupGraceMs,
    taskExecutionTimeoutMs,
    gptrTaskConcurrencyBudget,
    gptrDeepLimits,
  };
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
