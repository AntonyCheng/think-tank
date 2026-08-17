import type { LLMConnector } from "agency-orchestrator";

import {
  GptrConnector,
  type ResearchInvocation,
} from "./gptr-connector.js";
import { RoutingConnector } from "./routing-connector.js";
import type {
  ResearchEvent,
  ResearchResponse,
  TaskTemporalContext,
} from "./contracts.js";
import type { RuntimeSettings } from "./settings.js";
import type {
  ResearchCapabilities,
  ResearchProfile,
} from "./research-profile.js";
import {
  type EvidenceBundle,
  EvidenceLedger,
} from "./evidence-bundle.js";
import type { ResearchFailure } from "./research-telemetry.js";
import {
  FailoverConnector,
  openAiProviderConnector,
  type ProviderRoute,
} from "./model-provider-router.js";

export interface RuntimeConnectorObservers {
  onResearchEvent?: (
    event: ResearchEvent,
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
  onReworkRejected?: (reason: string) => void;
}

export function createRuntimeConnector(
  settings: RuntimeSettings,
  observers: RuntimeConnectorObservers = {},
  signal?: AbortSignal,
  runtimeContext?: TaskTemporalContext,
  researchPolicy?: {
    profile: ResearchProfile;
    capabilities: ResearchCapabilities;
  },
  taskId?: string,
  evidenceLedger?: EvidenceLedger,
  workflowRunId?: string,
): LLMConnector {
  const createResearchConnector = (provider: {
    baseUrl: string;
    apiKey: string;
    fastLlm: string;
    smartLlm: string;
  }, providerName: "primary" | "fallback", fallback?: GptrConnector, compressionFallback?: {
    baseUrl: string;
    apiKey: string;
    fastLlm: string;
  }): GptrConnector => new GptrConnector({
    serviceUrl: settings.gptrServiceUrl,
    retriever: settings.retriever,
    researchProfile: researchPolicy?.profile,
    taskId,
    researchCapabilities: researchPolicy?.capabilities,
    runtimeContext,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    fastLlm: provider.fastLlm,
    smartLlm: provider.smartLlm,
    fallbackBaseUrl: compressionFallback?.baseUrl,
    fallbackApiKey: compressionFallback?.apiKey,
    fallbackFastLlm: compressionFallback?.fastLlm,
    embedding: settings.gptrEmbedding,
    embeddingBaseUrl: settings.gptrEmbeddingBaseUrl,
    embeddingApiKey: settings.gptrEmbeddingApiKey,
    retrieverApiKeys: settings.retrieverApiKeys,
    signal,
    timeoutMs: settings.gptrResearchTimeoutMs,
    cleanupGraceMs: settings.gptrCleanupGraceMs,
    // The platform scheduling setting is the authoritative concurrency
    // control for AO dispatch, GPTR request admission, and Researcher slots.
    taskConcurrencyBudget: settings.concurrency,
    evidenceLedger,
    workflowRunId,
    onResearchEvent: observers.onResearchEvent,
    onResearchHeartbeat: observers.onResearchHeartbeat,
    onResearchFailure: observers.onResearchFailure,
    onEvidenceBundle: observers.onEvidenceBundle,
    onResearchComplete: (response, invocation) => {
      observers.onResearchComplete?.(response, invocation);
    },
    fallback,
    providerName,
    // One focused retry avoids silently synthesizing a Web expert's report
    // from an insufficient evidence set while preserving existing results.
    minimumPublicSources: 2,
  });

  const fallbackResearch = settings.fallback
      ? createResearchConnector({
        baseUrl: settings.fallback.baseUrl,
        apiKey: settings.fallback.apiKey,
        fastLlm: settings.fallback.fastLlm,
        smartLlm: settings.fallback.smartLlm,
      }, "fallback")
    : undefined;
  const researchConnector = createResearchConnector({
    baseUrl: settings.planner.base_url ?? "",
    apiKey: settings.planner.api_key,
    fastLlm: settings.gptrFastLlm,
    smartLlm: settings.gptrSmartLlm,
  }, "primary", fallbackResearch, settings.fallback
    ? {
        baseUrl: settings.fallback.baseUrl,
        apiKey: settings.fallback.apiKey,
        fastLlm: settings.fallback.fastLlm,
      }
    : undefined);

  const verifier = settings.verifierModel
    ? createProviderFailover(
        {
          baseUrl: settings.planner.base_url ?? "",
          apiKey: settings.planner.api_key,
          model: settings.verifierModel,
        },
        settings.fallback
          ? {
              baseUrl: settings.fallback.baseUrl,
              apiKey: settings.fallback.apiKey,
              model: settings.fallback.verifierModel,
            }
          : undefined,
      )
    : undefined;

  return new RoutingConnector({
    research: researchConnector,
    onReworkRejected: observers.onReworkRejected,
    verifier: settings.verifierModel
      ? {
          apiKey: settings.planner.api_key,
          baseUrl: settings.planner.base_url,
          model: settings.verifierModel,
          connector: verifier,
        }
      : undefined,
  });
}

export function createPlannerConnector(settings: RuntimeSettings): LLMConnector {
  return createProviderFailover(
    {
      baseUrl: settings.planner.base_url ?? "",
      apiKey: settings.planner.api_key,
      model: settings.planner.model,
    },
    settings.fallback
      ? {
          baseUrl: settings.fallback.baseUrl,
          apiKey: settings.fallback.apiKey,
          model: settings.fallback.plannerModel,
        }
      : undefined,
  );
}

function createProviderFailover(
  primary: { baseUrl: string; apiKey: string; model: string },
  fallback?: { baseUrl: string; apiKey: string; model: string },
): LLMConnector {
  const primaryRoute = openAiProviderConnector(primary);
  const fallbackRoute: ProviderRoute | undefined = fallback
    ? openAiProviderConnector(fallback)
    : undefined;
  return new FailoverConnector({
    primary: primaryRoute,
    ...(fallbackRoute ? { fallback: fallbackRoute } : {}),
  });
}
