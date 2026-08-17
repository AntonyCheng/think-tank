import type {
  ResearchProfile,
  ResearchRetriever,
} from "./research-profile.js";
import type {
  EvidenceBundle,
  ResearchEvidenceCapture,
} from "./evidence-bundle.js";

export interface TaskTemporalContext {
  startedAt: string;
  timeZone: string;
  localDate: string;
  localTime: string;
  weekday: string;
}

export interface ResearchRequest {
  taskId?: string;
  researchRunId?: string;
  executionTimeoutMs?: number;
  systemPrompt: string;
  task: string;
  reportSource: "web";
  retriever: ResearchRetriever;
  researchProfile?: ResearchProfile;
  upstreamEvidence?: EvidenceBundle[];
  runtimeContext?: TaskTemporalContext;
  baseUrl?: string;
  apiKey?: string;
  fastLlm?: string;
  smartLlm?: string;
  fallbackBaseUrl?: string;
  fallbackApiKey?: string;
  fallbackFastLlm?: string;
  embedding?: string;
  embeddingBaseUrl?: string;
  embeddingApiKey?: string;
  retrieverApiKeys?: Partial<Record<ResearchRetriever, string>>;
}

export interface ResearchEvent {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

export interface ResearchResponse {
  report: string;
  sourceUrls: string[];
  sources: unknown[];
  researchEvidence?: ResearchEvidenceCapture;
  cost: number | Record<string, unknown> | null;
  events: ResearchEvent[];
}
