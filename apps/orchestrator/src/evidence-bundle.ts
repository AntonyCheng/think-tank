import { createHash } from "node:crypto";

import type {
  ResearchMode,
  ResearchProfile,
  ResearchRetriever,
  ResearchSourceMode,
  ResearchSourcePolicy,
} from "./research-profile.js";

export type EvidenceQueryKind = "subquery" | "deep";

export interface EvidenceQueryCapture {
  kind: EvidenceQueryKind;
  text: string;
}

export type EvidenceSourceCapture =
  | {
      visibility: "public";
      url: string;
      title?: string;
      sourceType?: "web" | "specified_url";
      summary?: string;
    }
  | {
      visibility: "private";
      locator: string;
      title: string;
      sourceType?: "document";
      summary?: string;
    };

export interface ResearchEvidenceCapture {
  queries: EvidenceQueryCapture[];
  sources: EvidenceSourceCapture[];
  researchContext: {
    content: string;
    originalCharacters: number;
    truncated: boolean;
  };
  scraper?: string;
}

export interface EvidenceQuery {
  id: string;
  kind: EvidenceQueryKind;
  text: string;
}

export type EvidenceSource =
  | {
      id: string;
      visibility: "public";
      url: string;
      title: string;
      sourceType?: "web" | "specified_url";
      summary?: string;
      observedAt: string;
    }
  | {
      id: string;
      visibility: "private";
      locator: string;
      title: string;
      sourceType?: "document";
      summary?: string;
      observedAt: string;
    };

export interface EvidenceClaimCitation {
  claim: string;
  sourceIds: string[];
}

export interface EvidenceBundle {
  schemaVersion: 1;
  aoStepId: string;
  researchRunId: string;
  attempt: number;
  mode: ResearchMode;
  startedAt: string;
  completedAt: string;
  derivedFromStepIds: string[];
  queries: EvidenceQuery[];
  sources: EvidenceSource[];
  claimCitations?: EvidenceClaimCitation[];
  researchContext: {
    content: string;
    originalCharacters: number;
    truncated: boolean;
  };
  method: {
    sourceMode: ResearchSourceMode;
    retrievers: ResearchRetriever[];
    sourceCurationRequested?: boolean;
    scraper?: string;
  };
  report: {
    format: "markdown";
    content: string;
    revision: number;
    supersedesResearchRunId?: string;
  };
  cost: number | Record<string, unknown> | null;
}

export interface EvidenceRecord {
  aoStepId: string;
  researchRunId: string;
  dependsOn: readonly string[];
  profile: ResearchProfile;
  startedAt: string;
  completedAt: string;
  report: string;
  cost: number | Record<string, unknown> | null;
  capture: ResearchEvidenceCapture;
}

export interface EvidencePublicSource {
  title: string;
  url: string;
}

type NormalizedEvidenceSource =
  | {
      visibility: "public";
      url: string;
      title: string;
      sourceType: "web" | "specified_url";
      summary?: string;
    }
  | {
      visibility: "private";
      locator: string;
      title: string;
      sourceType?: "document";
      summary?: string;
    };

export class EvidenceLedger {
  readonly #bundles: EvidenceBundle[];

  constructor(bundles: readonly EvidenceBundle[] = []) {
    this.#bundles = bundles.map((bundle) => structuredClone(bundle));
  }

  record(input: EvidenceRecord): EvidenceBundle {
    const previous = this.#bundles.filter(
      (bundle) => bundle.aoStepId === input.aoStepId,
    );
    const superseded = previous.at(-1);
    const attempt = previous.length + 1;
    const contextContent = input.capture.researchContext.content;
    const originalContextCharacters = Math.max(
      input.capture.researchContext.content.length,
      input.capture.researchContext.originalCharacters,
    );
    const sources = normalizeSources(
      input.capture.sources,
      input.completedAt,
      input.aoStepId,
    );
    const claimCitations = claimCitationsForReport(input.report, sources);
    const bundle: EvidenceBundle = {
      schemaVersion: 1,
      aoStepId: input.aoStepId,
      researchRunId: input.researchRunId,
      attempt,
      mode: input.profile.mode,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      derivedFromStepIds: uniqueText(input.dependsOn),
      queries: normalizeQueries(input.capture.queries),
      sources,
      ...(claimCitations.length > 0 ? { claimCitations } : {}),
      researchContext: {
        content: contextContent,
        originalCharacters: originalContextCharacters,
        truncated: input.capture.researchContext.truncated,
      },
      method: {
        sourceMode: input.profile.source.mode,
        retrievers: [...sourceRetrievers(input.profile.source)],
        sourceCurationRequested: input.profile.quality.curateSources,
        ...(input.capture.scraper?.trim()
          ? { scraper: input.capture.scraper.trim() }
          : {}),
      },
      report: {
        format: "markdown",
        content: input.report,
        revision: attempt,
        ...(superseded
          ? { supersedesResearchRunId: superseded.researchRunId }
          : {}),
      },
      cost: structuredClone(input.cost),
    };
    this.#bundles.push(bundle);
    return structuredClone(bundle);
  }

  snapshot(): EvidenceBundle[] {
    return structuredClone(this.#bundles);
  }

  forSynthesis(
    dependencyStepIds: readonly string[],
    renderedTask?: string,
  ): EvidenceBundle[] {
    return structuredClone(
      uniqueText(dependencyStepIds).flatMap((stepId) => {
        const allAttempts = this.#bundles.filter(
          (bundle) => bundle.aoStepId === stepId,
        );
        const renderedAttempts = renderedTask
          ? allAttempts.filter((bundle) =>
              renderedTask.includes(bundle.report.content)
            )
          : [];
        const latest = renderedAttempts.at(-1) ?? allAttempts.at(-1);
        if (!latest) return [];
        const latestIndex = allAttempts.indexOf(latest);
        const attempts = allAttempts.slice(0, latestIndex + 1);
        const latestContext = [...attempts].reverse().find(
          (bundle) => bundle.researchContext.content.length > 0,
        )?.researchContext ?? latest.researchContext;
        const sources = mergeEvidenceSources(
          attempts.flatMap((bundle) => bundle.sources),
        );
        return [{
          ...latest,
          queries: normalizeQueries(
            attempts.flatMap((bundle) =>
              bundle.queries.map(({ kind, text }) => ({ kind, text }))
            ),
          ),
          sources,
          claimCitations: claimCitationsForReport(
            latest.report.content,
            sources,
          ),
          researchContext: latestContext,
        }];
      }),
    );
  }

  publicSources(): EvidencePublicSource[] {
    const sources = new Map<string, EvidencePublicSource>();
    for (const bundle of this.#bundles) {
      for (const source of bundle.sources) {
        if (source.visibility !== "public") continue;
        const key = canonicalHttpUrl(source.url);
        if (!key || sources.has(key)) continue;
        sources.set(key, {
          title: source.title,
          url: source.url,
        });
      }
    }
    return [...sources.values()];
  }
}

function normalizeQueries(
  captures: readonly EvidenceQueryCapture[],
): EvidenceQuery[] {
  return uniqueBy(
    captures.flatMap((capture) => {
      const text = capture.text.trim();
      return text ? [{ ...capture, text }] : [];
    }),
    (capture) => `${capture.kind}\u0000${capture.text}`,
  ).map((query, index) => ({
    id: `query-${index + 1}`,
    ...query,
  }));
}

function normalizeSources(
  captures: readonly EvidenceSourceCapture[],
  observedAt: string,
  aoStepId: string,
): EvidenceSource[] {
  const normalized: NormalizedEvidenceSource[] = [];
  for (const capture of captures) {
    const summary = capture.summary?.trim();
    if (capture.visibility === "public") {
      const url = normalizedHttpUrl(capture.url);
      if (!url) continue;
      normalized.push({
        visibility: "public" as const,
        url,
        title: capture.title?.trim() || hostnameTitle(url),
        sourceType: capture.sourceType === "specified_url"
          ? "specified_url"
          : "web",
        ...(summary ? { summary } : {}),
      });
      continue;
    }
    const locator = capture.locator.trim();
    const title = capture.title.trim();
    if (!locator || !title) continue;
    normalized.push({
      visibility: "private" as const,
      locator,
      title,
      ...(capture.sourceType ? { sourceType: capture.sourceType } : {}),
      ...(summary ? { summary } : {}),
    });
  }
  return uniqueBy(
    normalized,
    (source) =>
      source.visibility === "public"
        ? `public\u0000${canonicalHttpUrl(source.url)}`
        : `private\u0000${source.locator}`,
  ).map((source, index): EvidenceSource => ({
    id: evidenceSourceId(aoStepId, source, index),
    ...source,
    observedAt,
  }));
}

function mergeEvidenceSources(
  sources: readonly EvidenceSource[],
): EvidenceSource[] {
  return uniqueBy(
    sources,
    (source) =>
      source.visibility === "public"
        ? `public\u0000${canonicalHttpUrl(source.url)}`
        : `private\u0000${source.locator}`,
  );
}

function claimCitationsForReport(
  report: string,
  sources: readonly EvidenceSource[],
): EvidenceClaimCitation[] {
  const sourceIdsByUrl = new Map(
    sources.flatMap((source) => source.visibility === "public"
      ? [[canonicalHttpUrl(source.url), source.id] as const]
      : []),
  );
  const seen = new Set<string>();
  return report
    .split(/\n\s*\n/u)
    .flatMap((paragraph) => {
      const claim = paragraph.trim();
      if (!claim || /^#{1,6}\s/u.test(claim)) return [];
      const sourceIds = [...new Set(
        [...claim.matchAll(/https?:\/\/[^\s)<]+/giu)]
          .map((match) => canonicalHttpUrl(match[0]))
          .map((url) => sourceIdsByUrl.get(url))
          .filter((id): id is string => Boolean(id)),
      )];
      if (sourceIds.length === 0) return [];
      const key = `${sourceIds.join("\u0000")}\u0000${claim}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        claim: claim.length > 700 ? `${claim.slice(0, 697)}...` : claim,
        sourceIds,
      }];
    })
    .slice(0, 40);
}

function evidenceSourceId(
  aoStepId: string,
  source: NormalizedEvidenceSource,
  index: number,
): string {
  const identity = source.visibility === "public"
    ? canonicalHttpUrl(source.url)
    : source.locator;
  const step = aoStepId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "") || "expert";
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 10);
  return `source-${step}-${index + 1}-${digest}`;
}

function sourceRetrievers(
  source: ResearchSourcePolicy,
): readonly ResearchRetriever[] {
  if (source.mode === "web") return source.retrievers;
  if (
    (source.mode === "urls" ||
      source.mode === "hybrid") &&
    source.web
  ) {
    return source.web.retrievers;
  }
  return [];
}

function uniqueText(values: readonly string[]): string[] {
  return uniqueBy(
    values.map((value) => value.trim()).filter(Boolean),
    (value) => value,
  );
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

function canonicalHttpUrl(value: string): string {
  const normalized = normalizedHttpUrl(value);
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/u, "");
    }
    return url.toString();
  } catch {
    return "";
  }
}

function normalizedHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function hostnameTitle(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}
