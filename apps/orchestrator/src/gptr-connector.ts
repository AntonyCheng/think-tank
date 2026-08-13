import type {
  LLMConfig,
  LLMConnector,
  LLMResult,
} from "agency-orchestrator";

import type {
  ResearchRequest,
  ResearchResponse,
  TaskTemporalContext,
} from "./contracts.js";
import {
  resolveResearchProfile,
  type ResearchCapabilities,
  type ResearchProfile,
  type ResearchRetriever,
} from "./research-profile.js";
import {
  currentResearchProfileEnvironment,
  defaultResearchProfile,
} from "./research-profile-runtime.js";
import { WeightedConcurrencyBudget } from "./research-concurrency-budget.js";
import { resolveResearchDeadline } from "./research-deadline.js";
import {
  type EvidenceBundle,
  EvidenceLedger,
  type ResearchEvidenceCapture,
} from "./evidence-bundle.js";
import { collectObservedSources } from "./citations.js";
import type { ResearchFailure } from "./research-telemetry.js";

export interface GptrConnectorOptions {
  taskId?: string;
  serviceUrl: string;
  retriever: ResearchRetriever;
  researchProfile?: ResearchProfile;
  researchCapabilities?: ResearchCapabilities;
  runtimeContext?: TaskTemporalContext;
  baseUrl?: string;
  apiKey?: string;
  fastLlm?: string;
  smartLlm?: string;
  embedding?: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  cleanupGraceMs?: number;
  taskConcurrencyBudget?: number;
  workflowRunId?: string;
  evidenceLedger?: EvidenceLedger;
  onResearchEvent?: (
    event: ResearchResponse["events"][number],
    invocation: ResearchInvocation,
  ) => void;
  onResearchHeartbeat?: (invocation: ResearchInvocation) => void;
  onResearchComplete?: (
    response: ResearchResponse,
    invocation: ResearchInvocation,
  ) => void;
  onResearchFailure?: (
    failure: ResearchFailure,
    invocation: ResearchInvocation,
  ) => void;
  onEvidenceBundle?: (
    bundle: EvidenceBundle,
    invocation: ResearchInvocation,
  ) => void;
}

export interface ResearchInvocation {
  id: string;
  aoStepId: string;
  dependsOn: string[];
  queuedAt: string;
  startedAt: string;
  requestedResearchProfile: ResearchProfile;
  researchProfile: ResearchProfile;
  budget: {
    capacity: number;
    requestedWeight: number;
    effectiveWeight: number;
    waitedMs: number;
    queued: boolean;
  };
}

export class GptrConnector implements LLMConnector {
  readonly #options: GptrConnectorOptions;
  readonly #budget: WeightedConcurrencyBudget;
  #invocationSequence = 0;

  constructor(options: GptrConnectorOptions) {
    this.#options = options;
    this.#budget = new WeightedConcurrencyBudget(
      options.taskConcurrencyBudget ?? 4,
    );
  }

  async chat(
    systemPrompt: string,
    userMessage: string,
    config: LLMConfig,
  ): Promise<LLMResult> {
    const fallback = defaultResearchProfile(this.#options.retriever);
    const taskProfile = this.#options.researchProfile ?? fallback.profile;
    const capabilities = this.#options.researchCapabilities ??
      fallback.capabilities;
    const rawProfile = config.params &&
        Object.hasOwn(config.params, "think_tank")
      ? config.params.think_tank
      : taskProfile;
    const environment = currentResearchProfileEnvironment(
      profileRetriever(taskProfile, this.#options.retriever),
    );
    const baseResearchProfile = resolveResearchProfile(
      rawProfile,
      environment.defaults,
      capabilities,
    );
    const runtime = researchStepRuntime(config);
    const requestedResearchProfile = baseResearchProfile;
    const requestedWeight = researchWeight(requestedResearchProfile);
    const queuedAt = new Date().toISOString();
    const lease = await this.#budget.acquire(
      requestedWeight,
      this.#options.signal,
    );
    const researchProfile = effectiveResearchProfile(
      requestedResearchProfile,
      lease.effectiveWeight,
      environment.defaults,
      capabilities,
    );
    const invocation: ResearchInvocation = {
      id: researchRunId(
        this.#options.workflowRunId,
        ++this.#invocationSequence,
      ),
      aoStepId: runtime?.aoStepId ?? "unattributed",
      dependsOn: runtime?.dependsOn ?? [],
      queuedAt,
      startedAt: new Date().toISOString(),
      requestedResearchProfile,
      researchProfile,
      budget: {
        capacity: this.#budget.capacity,
        requestedWeight: lease.requestedWeight,
        effectiveWeight: lease.effectiveWeight,
        waitedMs: lease.waitedMs,
        queued: lease.queued,
      },
    };
    this.#emitEvent("research.mode.selected", {
      requestedMode: requestedResearchProfile.mode,
      effectiveMode: researchProfile.mode,
      requestedProfile: requestedResearchProfile,
      effectiveProfile: researchProfile,
      ...(researchProfile.deep ? { deep: researchProfile.deep } : {}),
    }, invocation);
    if (lease.requestedWeight !== lease.effectiveWeight) {
      this.#emitEvent("research.budget.adjusted", {
        capacity: this.#budget.capacity,
        requestedWeight: lease.requestedWeight,
        effectiveWeight: lease.effectiveWeight,
      }, invocation);
    }
    if (lease.queued) {
      this.#emitEvent("research.budget.waited", {
        waitedMs: lease.waitedMs,
        effectiveWeight: lease.effectiveWeight,
      }, invocation);
    }
    const deadline = resolveResearchDeadline({
      configuredResearchTimeoutMs: this.#options.timeoutMs ?? 30 * 60 * 1_000,
      aoAttemptTimeoutMs: config.timeout,
      cleanupGraceMs: this.#options.cleanupGraceMs ?? 20_000,
    });
    const request: ResearchRequest = {
      researchRunId: invocation.id,
      ...(this.#options.taskId ? { taskId: this.#options.taskId } : {}),
      executionTimeoutMs: deadline.executionTimeoutMs,
      systemPrompt,
      // AO renders dependency outputs into userMessage. Synthesis already
      // receives the authoritative upstream bundles below, so sending that
      // rendered text again needlessly doubles the prompt size.
      task: researchTask(runtime, userMessage, researchProfile.mode),
      reportSource: "web",
      retriever: profileRetriever(
        researchProfile,
        this.#options.retriever,
      ),
      researchProfile,
      ...(researchProfile.mode === "synthesis" &&
          this.#options.evidenceLedger
        ? {
            upstreamEvidence: this.#options.evidenceLedger.forSynthesis(
              runtime?.dependsOn ?? [],
              userMessage,
            ),
          }
        : {}),
      runtimeContext: this.#options.runtimeContext,
      baseUrl: this.#options.baseUrl,
      apiKey: this.#options.apiKey,
      fastLlm: this.#options.fastLlm,
      smartLlm: this.#options.smartLlm,
      embedding: this.#options.embedding,
      embeddingBaseUrl: this.#options.embeddingBaseUrl,
      embeddingApiKey: this.#options.embeddingApiKey,
    };

    let heartbeat: NodeJS.Timeout | undefined;
    try {
      if (this.#options.signal?.aborted) {
        throw researchRequestError(
          this.#options.signal.reason,
          this.#options.signal,
        );
      }
      const timeoutSignal = AbortSignal.timeout(deadline.connectorTimeoutMs);
      heartbeat = setInterval(
        () => this.#options.onResearchHeartbeat?.(invocation),
        20_000,
      );
      const signal = combinedSignal(this.#options.signal, timeoutSignal);
      let response: Response;
      try {
        response = await fetch(
          new URL("/research/stream", this.#options.serviceUrl),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
            signal,
          },
        );
      } catch (error) {
        throw researchRequestError(
          error,
          this.#options.signal,
          timeoutSignal,
        );
      }

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `GPT Researcher service returned ${response.status}: ${detail}`,
        );
      }

      if (!response.body) {
        throw new Error("GPT Researcher service returned an empty stream.");
      }

      let result: ResearchResponse;
      try {
        result = await readResearchStream(
          response.body,
          (event) => this.#options.onResearchEvent?.(event, invocation),
        );
      } catch (error) {
        throw researchRequestError(
          error,
          this.#options.signal,
          timeoutSignal,
        );
      }
      if (this.#options.evidenceLedger) {
        const completedAt = new Date().toISOString();
        const bundle = this.#options.evidenceLedger.record({
          aoStepId: invocation.aoStepId,
          researchRunId: invocation.id,
          dependsOn: invocation.dependsOn,
          profile: invocation.researchProfile,
          startedAt: invocation.startedAt,
          completedAt,
          report: result.report,
          cost: result.cost,
          capture: result.researchEvidence ??
            legacyResearchEvidenceCapture(result),
        });
        this.#options.onEvidenceBundle?.(bundle, invocation);
      }
      this.#options.onResearchComplete?.(result, invocation);

      // GPT Researcher exposes aggregate cost, but not the input/output token
      // pair required by AO's LLMResult contract. Zero is explicit "unknown";
      // the real aggregate cost is retained in the side-channel response.
      return {
        content: result.report,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      };
    } catch (error) {
      const normalized = error instanceof Error
        ? error
        : new Error(String(error));
      this.#options.onResearchFailure?.({
        timestamp: new Date().toISOString(),
        state: this.#options.signal?.aborted ? "canceled" : "failed",
        error: normalized,
      }, invocation);
      throw normalized;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      lease.release();
    }
  }

  #emitEvent(
    type: string,
    data: Record<string, unknown>,
    invocation: ResearchInvocation,
  ): void {
    this.#options.onResearchEvent?.({
      timestamp: new Date().toISOString(),
      type,
      data,
    }, invocation);
  }
}


function researchStepRuntime(config: LLMConfig): {
  aoStepId: string;
  dependsOn: string[];
  taskTemplate?: string;
} | undefined {
  const value = config.params?.think_tank_runtime;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.aoStepId !== "string" ||
    !record.aoStepId.trim()
  ) {
    return undefined;
  }
  return {
    aoStepId: record.aoStepId.trim(),
    dependsOn: Array.isArray(record.dependsOn)
      ? [...new Set(record.dependsOn.flatMap((candidate) =>
          typeof candidate === "string" && candidate.trim()
            ? [candidate.trim()]
            : []
        ))]
      : [],
    taskTemplate: typeof record.taskTemplate === "string" &&
        record.taskTemplate.trim()
      ? record.taskTemplate
      : undefined,
  };
}

function researchTask(
  runtime: ReturnType<typeof researchStepRuntime>,
  userMessage: string,
  mode: ResearchProfile["mode"],
): string {
  if (mode !== "synthesis") return userMessage;
  return [
    runtime?.taskTemplate ?? userMessage,
    "",
    "Final delivery contract:",
    "- Produce a comprehensive decision-oriented report, not a compressed summary.",
    "- Represent every assigned upstream expert dimension with its evidence, implications, and material uncertainty.",
    "- Preserve upstream factual source links beside the claims they support.",
    "- Explain cross-dimension relationships, tradeoffs, risks, and forward-looking indicators when the evidence supports them.",
    "- Do not impose or optimize for a character, word, or token limit.",
  ].join("\n");
}

function researchRunId(
  workflowRunId: string | undefined,
  sequence: number,
): string {
  const localId = `research-${sequence}`;
  return workflowRunId ? `${workflowRunId}:${localId}` : localId;
}

function legacyResearchEvidenceCapture(
  response: ResearchResponse,
): ResearchEvidenceCapture {
  return {
    queries: [],
    sources: collectObservedSources(response).map((source) => ({
      visibility: "public",
      url: source.url,
      title: source.title,
    })),
    researchContext: {
      content: "",
      originalCharacters: 0,
      truncated: false,
    },
  };
}

function researchWeight(profile: ResearchProfile): number {
  return profile.mode === "deep" && profile.deep
    ? profile.deep.concurrency
    : 1;
}

function effectiveResearchProfile(
  requested: ResearchProfile,
  effectiveWeight: number,
  defaults: Parameters<typeof resolveResearchProfile>[1],
  capabilities: ResearchCapabilities,
): ResearchProfile {
  if (
    requested.mode !== "deep" ||
    !requested.deep ||
    requested.deep.concurrency === effectiveWeight
  ) {
    return requested;
  }
  return resolveResearchProfile(
    {
      ...requested,
      deep: {
        ...requested.deep,
        concurrency: effectiveWeight,
      },
    },
    defaults,
    capabilities,
  );
}

function profileRetriever(
  profile: ResearchProfile,
  fallback: ResearchRetriever,
): ResearchRetriever {
  const webPolicy = profile.source.mode === "web"
    ? profile.source
    : "web" in profile.source
    ? profile.source.web
    : undefined;
  return webPolicy?.retrievers[0] ?? fallback;
}

function combinedSignal(
  first?: AbortSignal,
  second?: AbortSignal,
): AbortSignal | undefined {
  const signals = [first, second].filter(
    (signal): signal is AbortSignal => Boolean(signal),
  );
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function researchRequestError(
  error: unknown,
  taskSignal?: AbortSignal,
  timeoutSignal?: AbortSignal,
): Error {
  if (taskSignal?.aborted) {
    return taskSignal.reason instanceof Error
      ? taskSignal.reason
      : new Error("研究任务已中止。");
  }
  if (timeoutSignal?.aborted) {
    return new Error("GPT Researcher 单次专家研究超时。");
  }
  return error instanceof Error ? error : new Error(String(error));
}

type ResearchStreamMessage =
  | {
      type: "event";
      event: ResearchResponse["events"][number];
    }
  | {
      type: "result";
      result: ResearchResponse;
    }
  | {
      type: "error";
      error: { status?: number; detail?: unknown };
    };

async function readResearchStream(
  stream: ReadableStream<Uint8Array>,
  onEvent?: (event: ResearchResponse["events"][number]) => void,
): Promise<ResearchResponse> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ResearchResponse | undefined;

  const consume = (line: string) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as ResearchStreamMessage;
    if (message.type === "event") {
      onEvent?.(message.event);
      return;
    }
    if (message.type === "error") {
      throw new Error(
        `GPT Researcher stream failed${message.error.status ? ` (${message.error.status})` : ""}: ${
          formatStreamErrorDetail(message.error.detail)
        }`,
      );
    }
    result = message.result;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  consume(buffer);

  if (!result) {
    throw new Error("GPT Researcher stream ended without a result.");
  }
  return result;
}

function formatStreamErrorDetail(detail: unknown): string {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return String(detail ?? "unknown error");
  }
  const value = detail as Record<string, unknown>;
  const message = typeof value.message === "string"
    ? value.message
    : JSON.stringify(value);
  const code = typeof value.code === "string" ? value.code : undefined;
  const path = typeof value.path === "string" ? value.path : undefined;
  return [
    ...(code ? [code] : []),
    ...(path ? [`at ${path}`] : []),
    message,
  ].join(" ");
}
