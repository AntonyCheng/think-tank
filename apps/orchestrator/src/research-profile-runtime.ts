import {
  resolveResearchProfile,
  type ResearchCapabilities,
  type ResearchProfile,
  type ResearchProfileDefaults,
  type ResearchRetriever,
} from "./research-profile.js";

export interface ResearchProfileEnvironment {
  defaults: ResearchProfileDefaults;
  capabilities: ResearchCapabilities;
}

export function currentResearchProfileEnvironment(
  retriever: ResearchRetriever | readonly ResearchRetriever[],
  deepResearch: ResearchCapabilities["deepResearch"] = {
    maxBreadth: 4,
    maxDepth: 3,
    maxResearchCalls: 32,
  },
  maxRetrievers?: number,
  availableRetrievers?: readonly ResearchRetriever[],
): ResearchProfileEnvironment {
  const retrievers = typeof retriever === "string"
    ? [retriever]
    : [...retriever];
  const available = availableRetrievers
    ? [...availableRetrievers]
    : [...retrievers];
  const defaultRetriever = retrievers[0];
  if (!defaultRetriever) {
    throw new Error("At least one research retriever must be available.");
  }
  if (
    retrievers.some((item) => !available.includes(item))
  ) {
    throw new Error(
      "Default research retrievers must be available capabilities.",
    );
  }
  return {
    defaults: Object.freeze({
      defaultRetriever,
      defaultRetrievers: Object.freeze(retrievers),
    }),
    capabilities: Object.freeze({
      modes: Object.freeze(["standard", "deep", "synthesis"] as const),
      sourceModes: Object.freeze(["web", "urls"] as const),
      urlSourceModes: Object.freeze(["standard"] as const),
      domainFilterModes: Object.freeze(["standard"] as const),
      retrievers: Object.freeze(available),
      maxRetrievers: Math.min(
        maxRetrievers ?? available.length,
        available.length,
      ),
      sourceCuration: true,
      domainFilters: true,
      deepResearch: Object.freeze({ ...deepResearch }),
    }),
  };
}

export function defaultResearchProfile(
  retriever: ResearchRetriever | readonly ResearchRetriever[],
  maxRetrievers?: number,
): {
  profile: ResearchProfile;
  capabilities: ResearchCapabilities;
} {
  const environment = currentResearchProfileEnvironment(
    retriever,
    undefined,
    maxRetrievers,
  );
  return {
    profile: resolveResearchProfile(
      null,
      environment.defaults,
      environment.capabilities,
    ),
    capabilities: environment.capabilities,
  };
}
