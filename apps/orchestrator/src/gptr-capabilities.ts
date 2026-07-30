import {
  RESEARCH_RETRIEVERS,
  type ResearchRetriever,
} from "./research-profile.js";

export interface RetrieverCapability {
  id: ResearchRetriever;
  label: string;
  category: "web" | "academic";
  selectable: true;
  credentialRequired: boolean;
  timeoutMs: number;
}

export interface RetrieverCatalog {
  schemaVersion: 1;
  retrievers: readonly RetrieverCapability[];
  maxRetrievers: number;
}

export interface ResearchCapabilityProvider {
  getCatalog(
    serviceUrl: string,
    timeoutMs: number,
  ): Promise<RetrieverCatalog>;
}

type FetchAdapter = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class HttpResearchCapabilityProvider
implements ResearchCapabilityProvider {
  readonly #fetch: FetchAdapter;

  constructor(fetchAdapter: FetchAdapter = fetch) {
    this.#fetch = fetchAdapter;
  }

  async getCatalog(
    serviceUrl: string,
    timeoutMs: number,
  ): Promise<RetrieverCatalog> {
    const response = await this.#fetch(
      new URL("/capabilities", serviceUrl),
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!response.ok) {
      throw new Error(
        `GPT Researcher capabilities returned ${response.status}.`,
      );
    }
    return parseRetrieverCatalog(await response.json());
  }
}

export class CachedResearchCapabilityProvider
implements ResearchCapabilityProvider {
  readonly #delegate: ResearchCapabilityProvider;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<
    string,
    { observedAt: number; catalog: RetrieverCatalog }
  >();
  readonly #inFlight = new Map<string, Promise<RetrieverCatalog>>();

  constructor(
    delegate: ResearchCapabilityProvider,
    ttlMs = 30_000,
    now: () => number = Date.now,
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1) {
      throw new Error("Capability cache TTL must be a positive integer.");
    }
    this.#delegate = delegate;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  async getCatalog(
    serviceUrl: string,
    timeoutMs: number,
  ): Promise<RetrieverCatalog> {
    const cached = this.#cache.get(serviceUrl);
    if (cached && this.#now() - cached.observedAt < this.#ttlMs) {
      return cached.catalog;
    }
    const pending = this.#inFlight.get(serviceUrl);
    if (pending) return pending;

    const request = this.#delegate
      .getCatalog(serviceUrl, timeoutMs)
      .then((catalog) => {
        this.#cache.set(serviceUrl, {
          observedAt: this.#now(),
          catalog,
        });
        return catalog;
      })
      .finally(() => this.#inFlight.delete(serviceUrl));
    this.#inFlight.set(serviceUrl, request);
    return request;
  }
}

export function parseRetrieverCatalog(value: unknown): RetrieverCatalog {
  if (!isObject(value) || value.schemaVersion !== 1) {
    throw new Error("GPT Researcher returned an invalid capability catalog.");
  }
  if (!Array.isArray(value.retrievers)) {
    throw new Error("GPT Researcher capability catalog has no retrievers.");
  }
  const retrievers = value.retrievers.map(parseRetrieverCapability);
  const maxRetrievers = value.maxRetrievers;
  if (
    !Number.isInteger(maxRetrievers)
    || Number(maxRetrievers) < 0
    || Number(maxRetrievers) > 5
    || Number(maxRetrievers) > retrievers.length
  ) {
    throw new Error(
      "GPT Researcher returned an invalid retriever capability limit.",
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    retrievers: Object.freeze(retrievers),
    maxRetrievers: Number(maxRetrievers),
  });
}

function parseRetrieverCapability(value: unknown): RetrieverCapability {
  if (!isObject(value) || typeof value.id !== "string") {
    throw new Error("GPT Researcher returned an invalid retriever.");
  }
  if (
    !RESEARCH_RETRIEVERS.includes(value.id as ResearchRetriever)
  ) {
    throw new Error(
      `GPT Researcher returned unknown retriever '${value.id}'.`,
    );
  }
  if (
    typeof value.label !== "string"
    || !value.label.trim()
    || (value.category !== "web" && value.category !== "academic")
    || value.selectable !== true
    || typeof value.credentialRequired !== "boolean"
    || !Number.isInteger(value.timeoutMs)
    || Number(value.timeoutMs) < 1
  ) {
    throw new Error(
      `GPT Researcher returned invalid capability for '${value.id}'.`,
    );
  }
  return Object.freeze({
    id: value.id as ResearchRetriever,
    label: value.label.trim(),
    category: value.category,
    selectable: true as const,
    credentialRequired: value.credentialRequired,
    timeoutMs: Number(value.timeoutMs),
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
