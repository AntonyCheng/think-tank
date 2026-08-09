export type ResearchMode = "standard" | "deep" | "synthesis";
export type ResearchSourceMode = "web" | "urls" | "local" | "hybrid";
export const RESEARCH_RETRIEVERS = [
  "duckduckgo",
  "tavily",
  "arxiv",
  "openalex",
  "semantic_scholar",
  "pubmed_central",
] as const;
export type ResearchRetriever = typeof RESEARCH_RETRIEVERS[number];

export interface ResearchProfileDefaults {
  defaultRetriever: ResearchRetriever;
  defaultRetrievers?: readonly ResearchRetriever[];
}

export interface ResearchCapabilities {
  modes: readonly ResearchMode[];
  sourceModes: readonly ResearchSourceMode[];
  urlSourceModes?: readonly ResearchMode[];
  domainFilterModes?: readonly ResearchMode[];
  retrievers: readonly ResearchRetriever[];
  maxRetrievers: number;
  sourceCuration: boolean;
  domainFilters: boolean;
  deepResearch?: {
    maxBreadth: number;
    maxDepth: number;
    maxResearchCalls: number;
  };
}

export interface WebSearchPolicy {
  retrievers: readonly ResearchRetriever[];
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
}

export type ResearchSourcePolicy =
  | ({ mode: "web" } & WebSearchPolicy)
  | {
      mode: "urls";
      urls: readonly string[];
      web?: WebSearchPolicy;
    }
  | {
      mode: "local";
      documentIds: readonly string[];
    }
  | {
      mode: "hybrid";
      documentIds: readonly string[];
      urls?: readonly string[];
      web?: WebSearchPolicy;
    }
  ;

export interface ResearchLimits {
  maxSearchResultsPerQuery: number;
  maxIterations: number;
  maxSubtopics: number;
}

export interface DeepResearchParameters {
  breadth: number;
  depth: number;
  concurrency: number;
}

export interface WebSearchPolicyOverride {
  retrievers?: readonly ResearchRetriever[];
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
}

export type ResearchSourcePolicyOverride =
  | ({ mode?: "web" } & WebSearchPolicyOverride)
  | {
      mode: "urls";
      urls: readonly string[];
      web?: WebSearchPolicyOverride;
    }
  | {
      mode: "local";
      documentIds: readonly string[];
    }
  | {
      mode: "hybrid";
      documentIds: readonly string[];
      urls?: readonly string[];
      web?: WebSearchPolicyOverride;
    }
  ;

export interface ResearchProfileOverride {
  schemaVersion?: 1;
  mode?: ResearchMode;
  source?: ResearchSourcePolicyOverride;
  quality?: {
    curateSources?: boolean;
  };
  limits?: Partial<ResearchLimits>;
  deep?: DeepResearchParameters;
}

export interface ResearchProfile {
  schemaVersion: 1;
  mode: ResearchMode;
  source: ResearchSourcePolicy;
  quality: {
    curateSources: boolean;
  };
  limits: ResearchLimits;
  deep?: DeepResearchParameters;
}

export type ResearchProfileErrorCode =
  | "profile_version_unsupported"
  | "profile_unknown_field"
  | "profile_invalid_type"
  | "profile_invalid_value"
  | "profile_invariant_violation"
  | "profile_capability_disabled";

export class ResearchProfileError extends Error {
  constructor(
    readonly code: ResearchProfileErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ResearchProfileError";
  }
}

export function resolveResearchProfile(
  input: unknown,
  defaults: ResearchProfileDefaults,
  capabilities: ResearchCapabilities,
): ResearchProfile {
  const profile = input === null || input === undefined
    ? {}
    : objectValue(input, "$");
  assertKnownFields(
    profile,
    ["schemaVersion", "mode", "source", "quality", "limits", "deep"],
    "$",
  );

  const schemaVersion = profile.schemaVersion === undefined
    ? 1
    : integerValue(profile.schemaVersion, "$.schemaVersion");
  if (schemaVersion !== 1) {
    throw new ResearchProfileError(
      "profile_version_unsupported",
      "$.schemaVersion",
      `Research Profile schema version ${schemaVersion} is not supported.`,
    );
  }

  const mode = profile.mode === undefined
    ? "standard"
    : enumValue(
      profile.mode,
      ["standard", "deep", "synthesis"] as const,
      "$.mode",
    );
  const source = parseSource(profile.source, defaults);
  const quality = parseQuality(
    profile.quality,
    mode,
    capabilities.sourceCuration,
  );
  const limits = parseLimits(profile.limits);
  const deep = parseDeep(profile.deep, mode);

  const result: ResearchProfile = {
    schemaVersion,
    mode,
    source,
    quality,
    limits,
    ...(deep === undefined ? {} : { deep }),
  };

  assertCapabilities(result, capabilities);
  return deepFreeze(result);
}

function parseSource(
  value: unknown,
  defaults: ResearchProfileDefaults,
): ResearchSourcePolicy {
  if (value === undefined) {
    return {
      mode: "web",
      retrievers: defaultRetrieverSet(defaults),
    };
  }

  const source = objectValue(value, "$.source");
  const mode = source.mode === undefined
    ? "web"
    : enumValue(
      source.mode,
      ["web", "urls", "local", "hybrid"] as const,
      "$.source.mode",
    );

  switch (mode) {
    case "web": {
      const web = parseWebPolicy(source, "$.source", defaults, true);
      return { mode, ...web };
    }
    case "urls": {
      assertKnownFields(source, ["mode", "urls", "web"], "$.source");
      return {
        mode,
        urls: parseUrls(source.urls, "$.source.urls"),
        ...(source.web === undefined
          ? {}
          : { web: parseNestedWeb(source.web, "$.source.web", defaults) }),
      };
    }
    case "local": {
      assertKnownFields(source, ["mode", "documentIds"], "$.source");
      return {
        mode,
        documentIds: parseIdentifiers(
          source.documentIds,
          "$.source.documentIds",
          20,
        ),
      };
    }
    case "hybrid": {
      assertKnownFields(
        source,
        ["mode", "documentIds", "urls", "web"],
        "$.source",
      );
      const urls = source.urls === undefined
        ? undefined
        : parseUrls(source.urls, "$.source.urls");
      const web = source.web === undefined
        ? undefined
        : parseNestedWeb(source.web, "$.source.web", defaults);
      if (urls === undefined && web === undefined) {
        throw new ResearchProfileError(
          "profile_invariant_violation",
          "$.source",
          "Hybrid sources require URL or web evidence alongside documents.",
        );
      }
      return {
        mode,
        documentIds: parseIdentifiers(
          source.documentIds,
          "$.source.documentIds",
          20,
        ),
        ...(urls === undefined ? {} : { urls }),
        ...(web === undefined ? {} : { web }),
      };
    }
  }
}

function parseNestedWeb(
  value: unknown,
  path: string,
  defaults: ResearchProfileDefaults,
): WebSearchPolicy {
  return parseWebPolicy(objectValue(value, path), path, defaults, false);
}

function parseWebPolicy(
  value: Record<string, unknown>,
  path: string,
  defaults: ResearchProfileDefaults,
  includeMode: boolean,
): WebSearchPolicy {
  assertKnownFields(
    value,
    includeMode
      ? ["mode", "retrievers", "includeDomains", "excludeDomains"]
      : ["retrievers", "includeDomains", "excludeDomains"],
    path,
  );

  const retrievers = value.retrievers === undefined
    ? defaultRetrieverSet(defaults)
    : parseRetrievers(value.retrievers, `${path}.retrievers`);
  const includeDomains = parseDomains(
    value.includeDomains,
    `${path}.includeDomains`,
  );
  const excludeDomains = parseDomains(
    value.excludeDomains,
    `${path}.excludeDomains`,
  );

  if (
    includeDomains !== undefined &&
    excludeDomains !== undefined &&
    includeDomains.some((domain) => excludeDomains.includes(domain))
  ) {
    throw new ResearchProfileError(
      "profile_invariant_violation",
      path,
      "includeDomains and excludeDomains must not overlap.",
    );
  }

  return {
    retrievers,
    ...(includeDomains === undefined ? {} : { includeDomains }),
    ...(excludeDomains === undefined ? {} : { excludeDomains }),
  };
}

function defaultRetrieverSet(
  defaults: ResearchProfileDefaults,
): ResearchRetriever[] {
  return defaults.defaultRetrievers?.length
    ? [...defaults.defaultRetrievers]
    : [defaults.defaultRetriever];
}

function parseRetrievers(
  value: unknown,
  path: string,
): ResearchRetriever[] {
  if (!Array.isArray(value)) {
    throw new ResearchProfileError(
      "profile_invalid_type",
      path,
      `${path} must be an array.`,
    );
  }
  if (value.length < 1 || value.length > 5) {
    throw new ResearchProfileError(
      "profile_invalid_value",
      path,
      `${path} must contain between 1 and 5 retrievers.`,
    );
  }

  const retrievers = value.map((item, index) =>
    enumValue(
      item,
      RESEARCH_RETRIEVERS,
      `${path}[${index}]`,
    )
  );
  if (new Set(retrievers).size !== retrievers.length) {
    throw new ResearchProfileError(
      "profile_invalid_value",
      path,
      `${path} must not contain duplicate retrievers.`,
    );
  }
  return retrievers;
}

function parseDomains(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ResearchProfileError(
      "profile_invalid_type",
      path,
      `${path} must be an array.`,
    );
  }
  if (value.length < 1 || value.length > 20) {
    throw new ResearchProfileError(
      "profile_invalid_value",
      path,
      `${path} must contain between 1 and 20 domains.`,
    );
  }

  const domains = value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== "string") {
      throw new ResearchProfileError(
        "profile_invalid_type",
        itemPath,
        `${itemPath} must be a string.`,
      );
    }
    const domain = item.toLowerCase();
    if (!isHostname(domain)) {
      throw new ResearchProfileError(
        "profile_invalid_value",
        itemPath,
        `${itemPath} must be a hostname without a URL scheme or path.`,
      );
    }
    return domain;
  });

  if (new Set(domains).size !== domains.length) {
    throw new ResearchProfileError(
      "profile_invalid_value",
      path,
      `${path} must not contain duplicate domains.`,
    );
  }
  return domains;
}

function isHostname(value: string): boolean {
  if (value.length < 1 || value.length > 253) return false;
  return value.split(".").every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

function parseUrls(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new ResearchProfileError(
      "profile_invalid_type",
      path,
      `${path} must be an array.`,
    );
  }
  if (value.length < 1 || value.length > 50) {
    throw new ResearchProfileError(
      "profile_invalid_value",
      path,
      `${path} must contain between 1 and 50 URLs.`,
    );
  }

  const urls = value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== "string") {
      throw new ResearchProfileError(
        "profile_invalid_type",
        itemPath,
        `${itemPath} must be a string.`,
      );
    }
    if (item.length > 2048) {
      throw new ResearchProfileError(
        "profile_invalid_value",
        itemPath,
        `${itemPath} exceeds the 2048-character limit.`,
      );
    }
    try {
      const url = new URL(item);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        !url.hostname
      ) {
        throw new Error("unsupported URL");
      }
    } catch {
      throw new ResearchProfileError(
        "profile_invalid_value",
        itemPath,
        `${itemPath} must be an absolute HTTP(S) URL.`,
      );
    }
    return item;
  });

  if (new Set(urls).size !== urls.length) {
    throw new ResearchProfileError(
      "profile_invalid_value",
      path,
      `${path} must not contain duplicate URLs.`,
    );
  }
  return urls;
}

function parseIdentifiers(
  value: unknown,
  path: string,
  maximum: number,
): string[] {
  if (!Array.isArray(value)) {
    throw new ResearchProfileError(
      "profile_invalid_type",
      path,
      `${path} must be an array.`,
    );
  }
  if (value.length < 1 || value.length > maximum) {
    throw new ResearchProfileError(
      "profile_invalid_value",
      path,
      `${path} must contain between 1 and ${maximum} identifiers.`,
    );
  }

  const identifiers = value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== "string") {
      throw new ResearchProfileError(
        "profile_invalid_type",
        itemPath,
        `${itemPath} must be a string.`,
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item)) {
      throw new ResearchProfileError(
        "profile_invalid_value",
        itemPath,
        `${itemPath} must be a platform-managed identifier.`,
      );
    }
    return item;
  });

  if (new Set(identifiers).size !== identifiers.length) {
    throw new ResearchProfileError(
      "profile_invalid_value",
      path,
      `${path} must not contain duplicate identifiers.`,
    );
  }
  return identifiers;
}

function parseQuality(
  value: unknown,
  mode: ResearchMode,
  sourceCurationAvailable: boolean,
): ResearchProfile["quality"] {
  const defaultValue = mode !== "synthesis" && sourceCurationAvailable;
  if (value === undefined) {
    return { curateSources: defaultValue };
  }
  const quality = objectValue(value, "$.quality");
  assertKnownFields(quality, ["curateSources"], "$.quality");
  const result = {
    curateSources: booleanValue(
      quality.curateSources,
      "$.quality.curateSources",
      defaultValue,
    ),
  };
  if (mode === "synthesis" && result.curateSources) {
    throw new ResearchProfileError(
      "profile_invariant_violation",
      "$.quality.curateSources",
      "Synthesis mode cannot curate sources because it does not search.",
    );
  }
  return result;
}

function assertCapabilities(
  profile: ResearchProfile,
  capabilities: ResearchCapabilities,
): void {
  if (!capabilities.modes.includes(profile.mode)) {
    throw new ResearchProfileError(
      "profile_capability_disabled",
      "$.mode",
      `Mode '${profile.mode}' is not enabled.`,
    );
  }
  assertSourceCapabilities(profile, capabilities);

  if (profile.quality.curateSources && !capabilities.sourceCuration) {
    throw new ResearchProfileError(
      "profile_capability_disabled",
      "$.quality.curateSources",
      "Source curation is not enabled.",
    );
  }

  const deepLimits = capabilities.deepResearch;
  if (profile.mode === "deep" && profile.deep && deepLimits) {
    if (profile.deep.breadth > deepLimits.maxBreadth) {
      throw new ResearchProfileError(
        "profile_capability_disabled",
        "$.deep.breadth",
        `Deep research breadth ${profile.deep.breadth} exceeds the deployment limit ${deepLimits.maxBreadth}.`,
      );
    }
    if (profile.deep.depth > deepLimits.maxDepth) {
      throw new ResearchProfileError(
        "profile_capability_disabled",
        "$.deep.depth",
        `Deep research depth ${profile.deep.depth} exceeds the deployment limit ${deepLimits.maxDepth}.`,
      );
    }
    const estimatedCalls = estimateDeepResearchCalls(
      profile.deep.breadth,
      profile.deep.depth,
    );
    if (estimatedCalls > deepLimits.maxResearchCalls) {
      throw new ResearchProfileError(
        "profile_capability_disabled",
        "$.deep",
        `Deep research would require about ${estimatedCalls} sub-research calls, exceeding the deployment limit ${deepLimits.maxResearchCalls}.`,
      );
    }
  }
}

function assertSourceCapabilities(
  profile: ResearchProfile,
  capabilities: ResearchCapabilities,
): void {
  if (profile.mode === "synthesis") {
    return;
  }
  if (!capabilities.sourceModes.includes(profile.source.mode)) {
    throw new ResearchProfileError(
      "profile_capability_disabled",
      "$.source.mode",
      `Source mode '${profile.source.mode}' is not enabled.`,
    );
  }
  if (
    profile.source.mode === "urls" &&
    capabilities.urlSourceModes !== undefined &&
    !capabilities.urlSourceModes.includes(profile.mode)
  ) {
    throw new ResearchProfileError(
      "profile_capability_disabled",
      "$.source.mode",
      `URL sources are not enabled for mode '${profile.mode}'.`,
    );
  }

  if (profile.source.mode === "web") {
    assertWebCapabilities(
      profile.source,
      "$.source",
      profile.mode,
      capabilities,
    );
  } else if ("web" in profile.source && profile.source.web !== undefined) {
    assertWebCapabilities(
      profile.source.web,
      "$.source.web",
      profile.mode,
      capabilities,
    );
  }
}

export function estimateDeepResearchCalls(
  breadth: number,
  depth: number,
): number {
  if (depth <= 1) return breadth;
  const nextBreadth = Math.max(2, Math.floor(breadth / 2));
  return breadth * (
    1 + estimateDeepResearchCalls(nextBreadth, depth - 1)
  );
}

function assertWebCapabilities(
  policy: WebSearchPolicy,
  path: string,
  mode: ResearchMode,
  capabilities: ResearchCapabilities,
): void {
  policy.retrievers.forEach((retriever, index) => {
    if (!capabilities.retrievers.includes(retriever)) {
      throw new ResearchProfileError(
        "profile_capability_disabled",
        `${path}.retrievers[${index}]`,
        `Retriever '${retriever}' is not enabled.`,
      );
    }
  });
  if (policy.retrievers.length > capabilities.maxRetrievers) {
    throw new ResearchProfileError(
      "profile_capability_disabled",
      `${path}.retrievers`,
      `At most ${capabilities.maxRetrievers} retrievers are enabled.`,
    );
  }
  if (policy.includeDomains !== undefined && !capabilities.domainFilters) {
    throw new ResearchProfileError(
      "profile_capability_disabled",
      `${path}.includeDomains`,
      "Domain filters are not enabled.",
    );
  }
  if (policy.excludeDomains !== undefined && !capabilities.domainFilters) {
    throw new ResearchProfileError(
      "profile_capability_disabled",
      `${path}.excludeDomains`,
      "Domain filters are not enabled.",
    );
  }
  const domainPath = policy.includeDomains !== undefined
    ? `${path}.includeDomains`
    : `${path}.excludeDomains`;
  if (
    (policy.includeDomains !== undefined ||
      policy.excludeDomains !== undefined) &&
    capabilities.domainFilterModes !== undefined &&
    !capabilities.domainFilterModes.includes(mode)
  ) {
    throw new ResearchProfileError(
      "profile_capability_disabled",
      domainPath,
      `Domain filters are not enabled for mode '${mode}'.`,
    );
  }
}

function parseDeep(
  value: unknown,
  mode: ResearchMode,
): DeepResearchParameters | undefined {
  if (mode === "deep" && value === undefined) {
    throw new ResearchProfileError(
      "profile_invariant_violation",
      "$.deep",
      "Deep mode requires explicit deep parameters.",
    );
  }
  if (mode !== "deep" && value !== undefined) {
    throw new ResearchProfileError(
      "profile_invariant_violation",
      "$.deep",
      "Deep parameters are only valid in deep mode.",
    );
  }
  if (value === undefined) return undefined;

  const deep = objectValue(value, "$.deep");
  assertKnownFields(deep, ["breadth", "depth", "concurrency"], "$.deep");
  return {
    breadth: requiredBoundedInteger(deep.breadth, "$.deep.breadth", 1, 10),
    depth: requiredBoundedInteger(deep.depth, "$.deep.depth", 1, 5),
    concurrency: requiredBoundedInteger(
      deep.concurrency,
      "$.deep.concurrency",
      1,
      16,
    ),
  };
}

function parseLimits(value: unknown): ResearchLimits {
  if (value === undefined) {
    return {
      maxSearchResultsPerQuery: 5,
      maxIterations: 3,
      maxSubtopics: 3,
    };
  }
  const limits = objectValue(value, "$.limits");
  assertKnownFields(
    limits,
    ["maxSearchResultsPerQuery", "maxIterations", "maxSubtopics"],
    "$.limits",
  );
  return {
    maxSearchResultsPerQuery: boundedInteger(
      limits.maxSearchResultsPerQuery,
      "$.limits.maxSearchResultsPerQuery",
      1,
      20,
      5,
    ),
    maxIterations: boundedInteger(
      limits.maxIterations,
      "$.limits.maxIterations",
      1,
      10,
      3,
    ),
    maxSubtopics: boundedInteger(
      limits.maxSubtopics,
      "$.limits.maxSubtopics",
      1,
      20,
      3,
    ),
  };
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResearchProfileError(
      "profile_invalid_type",
      path,
      `${path} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value)
    .filter((field) => !allowed.includes(field))
    .sort()[0];
  if (unknown) {
    throw new ResearchProfileError(
      "profile_unknown_field",
      `${path}.${unknown}`,
      `${path}.${unknown} is not a recognized Research Profile field.`,
    );
  }
}

function integerValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ResearchProfileError(
      "profile_invalid_type",
      path,
      `${path} must be an integer.`,
    );
  }
  return value;
}

function booleanValue(
  value: unknown,
  path: string,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ResearchProfileError(
      "profile_invalid_type",
      path,
      `${path} must be a boolean.`,
    );
  }
  return value;
}

function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const result = integerValue(value, path);
  if (result < minimum || result > maximum) {
    throw new ResearchProfileError(
      "profile_invalid_value",
      path,
      `${path} must be between ${minimum} and ${maximum}.`,
    );
  }
  return result;
}

function requiredBoundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    throw new ResearchProfileError(
      "profile_invalid_type",
      path,
      `${path} is required and must be an integer.`,
    );
  }
  return boundedInteger(value, path, minimum, maximum, minimum);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string") {
    throw new ResearchProfileError(
      "profile_invalid_type",
      path,
      `${path} must be a string.`,
    );
  }
  if (!allowed.includes(value)) {
    throw new ResearchProfileError(
      "profile_invalid_value",
      path,
      `${path} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value as T[number];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
