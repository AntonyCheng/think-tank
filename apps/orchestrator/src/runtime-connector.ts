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

export interface RuntimeConnectorObservers {
  onResearchEvent?: (
    event: ResearchEvent,
    invocation: ResearchInvocation,
  ) => void;
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
  evidenceLedger?: EvidenceLedger,
): LLMConnector {
  const researchConnector = new GptrConnector({
    serviceUrl: settings.gptrServiceUrl,
    retriever: settings.retriever,
    researchProfile: researchPolicy?.profile,
    researchCapabilities: researchPolicy?.capabilities,
    runtimeContext,
    baseUrl: settings.planner.base_url,
    apiKey: settings.planner.api_key,
    fastLlm: settings.gptrFastLlm,
    smartLlm: settings.gptrSmartLlm,
    embedding: settings.gptrEmbedding,
    embeddingBaseUrl: settings.gptrEmbeddingBaseUrl,
    signal,
    timeoutMs: settings.gptrResearchTimeoutMs,
    taskConcurrencyBudget: settings.gptrTaskConcurrencyBudget,
    evidenceLedger,
    onResearchEvent: observers.onResearchEvent,
    onResearchFailure: observers.onResearchFailure,
    onEvidenceBundle: observers.onEvidenceBundle,
    onResearchComplete: (response, invocation) => {
      observers.onResearchComplete?.(response, invocation);
    },
  });

  return new RoutingConnector({
    research: researchConnector,
    onReworkRejected: observers.onReworkRejected,
    verifier: settings.verifierModel
      ? {
          apiKey: settings.planner.api_key,
          baseUrl: settings.planner.base_url,
          model: settings.verifierModel,
        }
      : undefined,
  });
}
