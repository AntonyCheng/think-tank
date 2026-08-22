import type { RuntimeSettings } from "./settings.js";

export interface SettingsPreflightCheck {
  id: "model" | "embedding" | "retriever";
  label: string;
  status: "passed" | "failed";
  detail?: string;
}

export type SettingsPreflightScope =
  | "all"
  | "models"
  | "embedding"
  | "retrievers"
  | "scheduling"
  | "fallbackModels";

const EMBEDDING_TIMEOUT_MS = 10_000;
const SEARCH_TIMEOUT_MS = 15_000;

export async function preflightRuntimeSettings(
  settings: RuntimeSettings,
  fetchAdapter: typeof fetch = fetch,
  scope: SettingsPreflightScope = "all",
): Promise<SettingsPreflightCheck[]> {
  const checks = await Promise.all([
    ...(scope === "all" || scope === "models"
      ? [preflightModels(settings, fetchAdapter)]
      : []),
    ...(scope === "all" || scope === "fallbackModels"
      ? [preflightFallbackModels(settings, fetchAdapter)]
      : []),
    ...(scope === "all" || scope === "embedding"
      ? [preflightEmbedding(settings, fetchAdapter).then((check) => [check])]
      : []),
    ...(scope === "all" || scope === "retrievers"
      ? [preflightRetrievers(settings, fetchAdapter)]
      : []),
  ]);
  return checks.flat();
}

function preflightModels(
  settings: RuntimeSettings,
  fetchAdapter: typeof fetch,
): Promise<SettingsPreflightCheck[]> {
  return preflightModelProvider({
    baseUrl: settings.planner.base_url,
    apiKey: settings.planner.api_key,
    plannerModel: settings.planner.model,
    verifierModel: settings.verifierModel,
    fastLlm: settings.gptrFastLlm,
    smartLlm: settings.gptrSmartLlm,
  }, fetchAdapter, "主模型", settings.modelPreflightTimeoutMs);
}

async function preflightFallbackModels(
  settings: RuntimeSettings,
  fetchAdapter: typeof fetch,
): Promise<SettingsPreflightCheck[]> {
  if (!settings.fallback) {
    return [{
      id: "model",
      label: "备用模型服务",
      status: "passed",
      detail: "备用模型服务未启用",
    }];
  }
  return preflightModelProvider(
    settings.fallback,
    fetchAdapter,
    "备用模型",
    settings.modelPreflightTimeoutMs,
  );
}

async function preflightModelProvider(
  provider: {
    baseUrl?: string;
    apiKey: string;
    plannerModel: string;
    verifierModel?: string;
    fastLlm: string;
    smartLlm: string;
  },
  fetchAdapter: typeof fetch,
  labelPrefix: string,
  timeoutMs: number,
): Promise<SettingsPreflightCheck[]> {
  const candidates = [
    [`${labelPrefix}·AO 编排模型`, provider.plannerModel],
    ...(provider.verifierModel ? [[`${labelPrefix}·AO 验证模型`, provider.verifierModel]] : []),
    [`${labelPrefix}·GPTR 快速模型`, provider.fastLlm],
    [`${labelPrefix}·GPTR 深度模型`, provider.smartLlm],
  ] as const;
  const checks = new Map<string, Promise<void>>();
  return Promise.all(candidates.map(async ([label, model]) => {
    const key = `${provider.baseUrl ?? ""}\u0000${provider.apiKey}\u0000${modelName(model)}`;
    let check = checks.get(key);
    if (!check) {
      check = probeChatModel(
        provider.baseUrl,
        provider.apiKey,
        model,
        fetchAdapter,
        timeoutMs,
      );
      checks.set(key, check);
    }
    try {
      await check;
      return { id: "model", label, status: "passed" };
    } catch (error) {
      return failed("model", label, error, settingsFromProvider(provider));
    }
  }));
}

function settingsFromProvider(provider: {
  baseUrl?: string;
  apiKey: string;
}): RuntimeSettings {
  return {
    planner: {
      provider: "openai",
      api_key: provider.apiKey,
      base_url: provider.baseUrl,
      model: "preflight",
    },
    gptrServiceUrl: "",
    retriever: "duckduckgo",
    retrievers: ["duckduckgo"],
    retrieverApiKeys: {},
    gptrFastLlm: "openai:preflight",
    gptrSmartLlm: "openai:preflight",
    gptrEmbedding: "custom:preflight",
    timeZone: "UTC",
    concurrency: 1,
    modelPreflightTimeoutMs: 1,
    gptrHealthTimeoutMs: 1,
    gptrResearchTimeoutMs: 2,
    gptrCleanupGraceMs: 1,
    taskExecutionTimeoutMs: 1,
    gptrTaskConcurrencyBudget: 1,
    gptrDeepLimits: { maxBreadth: 1, maxDepth: 1, maxResearchCalls: 1 },
  };
}

async function preflightEmbedding(
  settings: RuntimeSettings,
  fetchAdapter: typeof fetch,
): Promise<SettingsPreflightCheck> {
  try {
    const baseUrl = settings.gptrEmbeddingBaseUrl;
    const apiKey = settings.gptrEmbeddingApiKey ?? settings.planner.api_key;
    const response = await fetchAdapter(
      endpoint(baseUrl, "embeddings"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName(settings.gptrEmbedding),
          input: ["健康检查"],
        }),
        signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw await responseFailure(response, "Embedding 接口");
    const payload = await response.json() as { data?: unknown };
    if (!Array.isArray(payload.data) || payload.data.length < 1) {
      throw new Error("Embedding 接口未返回向量数据");
    }
    return { id: "embedding", label: "Embedding 模型", status: "passed" };
  } catch (error) {
    return failed("embedding", "Embedding 模型", error, settings);
  }
}

async function preflightRetrievers(
  settings: RuntimeSettings,
  fetchAdapter: typeof fetch,
): Promise<SettingsPreflightCheck[]> {
  return Promise.all(settings.retrievers.map(async (retriever) => {
    try {
      const response = await fetchAdapter(
        endpoint(settings.gptrServiceUrl, "search"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "research system health check",
            retrievers: [retriever],
            limit: 1,
            ...(Object.keys(settings.retrieverApiKeys).length > 0
              ? { retrieverApiKeys: settings.retrieverApiKeys }
              : {}),
          }),
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw await responseFailure(response, "网页搜索");
      const payload = await response.json() as { results?: unknown };
      if (!Array.isArray(payload.results)) throw new Error("网页搜索返回格式无效");
      return { id: "retriever", label: `${retriever} 网页搜索`, status: "passed" };
    } catch (error) {
      return failed("retriever", `${retriever} 网页搜索`, error, settings);
    }
  }));
}

async function probeChatModel(
  baseUrl: string | undefined,
  apiKey: string,
  model: string,
  fetchAdapter: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  const response = await fetchAdapter(endpoint(baseUrl, "chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName(model),
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw await responseFailure(response, "模型接口");
  const payload = await response.json() as { choices?: unknown };
  if (!Array.isArray(payload.choices) || payload.choices.length < 1) {
    throw new Error("模型接口未返回回复");
  }
}

function endpoint(baseUrl: string | undefined, path: string): URL {
  if (!baseUrl) throw new Error("接口地址未配置");
  return new URL(path, `${baseUrl.replace(/\/+$/u, "")}/`);
}

function modelName(value: string): string {
  const separator = value.indexOf(":");
  return separator < 0 ? value : value.slice(separator + 1);
}

function failed(
  id: SettingsPreflightCheck["id"],
  label: string,
  error: unknown,
  settings: RuntimeSettings,
): SettingsPreflightCheck {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id,
    label,
    status: "failed",
    detail: redact(message, [
      settings.planner.api_key,
      settings.gptrEmbeddingApiKey,
      ...Object.values(settings.retrieverApiKeys),
    ]),
  };
}

async function responseFailure(
  response: Response,
  service: string,
): Promise<Error> {
  const body = (await response.text()).trim();
  return new Error(
    `${service}响应（HTTP ${response.status}）${body ? `：\n${body}` : ""}`,
  );
}

function redact(value: string, secrets: Array<string | undefined>): string {
  let result = value;
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, "[redacted]");
  }
  return result
    .replace(/\b(api[_-]?key|authorization|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu, "$1: [redacted]")
    .replace(/\bsk-[a-z0-9_-]+/giu, "[redacted]")
    .slice(0, 1_000);
}
