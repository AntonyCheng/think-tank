import type { CitationNormalization } from "./citations.js";
import type { EvidenceBundle, EvidenceSource } from "./evidence-bundle.js";
import {
  deriveReportEvidencePolicy,
  type ReportEvidencePolicy,
} from "./report-evidence-policy.js";

const CITATION_COVERAGE_TARGET = 0.75;
const VALID_LINK_RATE_TARGET = 1;
const DUPLICATION_WARNING_THRESHOLD = 0.25;
const MINIMUM_SOURCES_FOR_DIVERSITY = 3;
const MINIMUM_DOMAINS = 2;

export type EvidenceSourceType =
  | "government"
  | "academic"
  | "organization"
  | "commercial"
  | "other";

export type EvidenceQualityWarningCode =
  | "citation_coverage_low"
  | "unverified_links"
  | "no_verified_citations"
  | "no_public_sources"
  | "source_duplication_high"
  | "domain_diversity_low";

export interface EvidenceQualityWarning {
  code: EvidenceQualityWarningCode;
  message: string;
}

export interface EvidenceQualityAssessment {
  schemaVersion: 1;
  status: "passed" | "warning";
  metrics: {
    citationCoverage: {
      citedClaimParagraphs: number;
      totalClaimParagraphs: number;
      ratio: number | null;
      target: number;
    };
    validLinkRate: {
      verifiedLinks: number;
      totalLinks: number;
      ratio: number | null;
      target: number;
    };
    sourceDeduplication: {
      observedPublicSources: number;
      uniquePublicSources: number;
      duplicateSources: number;
      duplicateRatio: number | null;
    };
    domainDiversity: {
      uniqueDomains: number;
      uniquePublicSources: number;
      ratio: number | null;
    };
    sourceTypes: Record<EvidenceSourceType, number>;
  };
  reportEvidencePolicy: Pick<
    ReportEvidencePolicy,
    "strategy" | "allowsPrivateAttribution" | "forbidsExternalLinks"
  >;
  warnings: EvidenceQualityWarning[];
}

export interface EvidenceQualityInput {
  citationNormalization: CitationNormalization;
  evidenceBundles: readonly EvidenceBundle[];
  reportEvidencePolicy?: ReportEvidencePolicy;
}

export function applyCurrentEvidenceQualityTargets(
  assessment: EvidenceQualityAssessment,
): EvidenceQualityAssessment {
  const citationCoverage = assessment.metrics.citationCoverage;
  const warnings = assessment.warnings.filter((warning) =>
    warning.code !== "citation_coverage_low"
  );
  if (
    assessment.reportEvidencePolicy.strategy !== "private_bounded" &&
    citationCoverage.ratio !== null &&
    citationCoverage.ratio < CITATION_COVERAGE_TARGET
  ) {
    warnings.push({
      code: "citation_coverage_low",
      message:
        `证据质量：含数据段落的已验证引用覆盖率为 ${percent(citationCoverage.ratio)}，低于 ${percent(CITATION_COVERAGE_TARGET)}。`,
    });
  }
  return {
    ...assessment,
    status: warnings.length === 0 ? "passed" : "warning",
    metrics: {
      ...assessment.metrics,
      citationCoverage: {
        ...citationCoverage,
        target: CITATION_COVERAGE_TARGET,
      },
    },
    warnings,
  };
}

export function assessEvidenceQuality(
  input: EvidenceQualityInput,
): EvidenceQualityAssessment {
  const { citationNormalization } = input;
  const reportEvidencePolicy = input.reportEvidencePolicy ??
    deriveReportEvidencePolicy({ evidenceBundles: input.evidenceBundles });
  const observedSources = input.evidenceBundles.flatMap((bundle) =>
    bundle.sources.filter(isPublicSource)
  );
  const uniqueSources = uniquePublicSources(observedSources);
  const domains = new Set(
    [...uniqueSources.values()].flatMap((source) => {
      const hostname = sourceHostname(source.url);
      return hostname ? [hostname] : [];
    }),
  );
  const duplicateSources = observedSources.length - uniqueSources.size;
  const citationCoverage = ratio(
    citationNormalization.citedNumericClaimParagraphs,
    citationNormalization.numericClaimParagraphs,
  );
  const validLinkRate = ratio(
    citationNormalization.verifiedBodyLinkCount,
    citationNormalization.bodyLinkCount,
  );
  const duplicateRatio = ratio(
    duplicateSources,
    observedSources.length,
  );
  const domainRatio = ratio(domains.size, uniqueSources.size);
  const sourceTypes = emptySourceTypes();
  for (const source of uniqueSources.values()) {
    sourceTypes[classifySource(source.url)] += 1;
  }

  const warnings: EvidenceQualityWarning[] = [];
  if (
    reportEvidencePolicy.strategy !== "private_bounded" &&
    citationCoverage !== null &&
    citationCoverage < CITATION_COVERAGE_TARGET
  ) {
    warnings.push({
      code: "citation_coverage_low",
      message:
        `证据质量：含数据段落的已验证引用覆盖率为 ${percent(citationCoverage)}，低于 ${percent(CITATION_COVERAGE_TARGET)}。`,
    });
  }
  if (
    reportEvidencePolicy.strategy !== "private_bounded" &&
    validLinkRate !== null && validLinkRate < VALID_LINK_RATE_TARGET
  ) {
    warnings.push({
      code: "unverified_links",
      message:
        `证据质量：正文来源链接的验证通过率为 ${percent(validLinkRate)}，存在不属于本次证据包的链接。`,
    });
  }
  if (
    reportEvidencePolicy.strategy !== "private_bounded" &&
    uniqueSources.size > 0 &&
    citationNormalization.verifiedBodyLinkCount === 0
  ) {
    warnings.push({
      code: "no_verified_citations",
      message: "证据质量：报告未在正文中保留任何本次研究的已验证引用。",
    });
  }
  if (
    reportEvidencePolicy.strategy !== "private_bounded" &&
    uniqueSources.size === 0 &&
    citationNormalization.numericClaimParagraphs > 0
  ) {
    warnings.push({
      code: "no_public_sources",
      message: "证据质量：报告包含量化陈述，但本次任务没有可验证的公开来源。",
    });
  }
  if (
    observedSources.length >= 4 &&
    duplicateRatio !== null &&
    duplicateRatio > DUPLICATION_WARNING_THRESHOLD
  ) {
    warnings.push({
      code: "source_duplication_high",
      message:
        `证据质量：${observedSources.length} 条步骤来源中有 ${duplicateSources} 条跨步骤重复，重复率为 ${percent(duplicateRatio)}。`,
    });
  }
  if (
    uniqueSources.size >= MINIMUM_SOURCES_FOR_DIVERSITY &&
    domains.size < MINIMUM_DOMAINS
  ) {
    warnings.push({
      code: "domain_diversity_low",
      message:
        `证据质量：${uniqueSources.size} 个独立来源仅覆盖 ${domains.size} 个域名，来源多样性不足。`,
    });
  }

  return {
    schemaVersion: 1,
    status: warnings.length === 0 ? "passed" : "warning",
    metrics: {
      citationCoverage: {
        citedClaimParagraphs:
          citationNormalization.citedNumericClaimParagraphs,
        totalClaimParagraphs: citationNormalization.numericClaimParagraphs,
        ratio: citationCoverage,
        target: CITATION_COVERAGE_TARGET,
      },
      validLinkRate: {
        verifiedLinks: citationNormalization.verifiedBodyLinkCount,
        totalLinks: citationNormalization.bodyLinkCount,
        ratio: validLinkRate,
        target: VALID_LINK_RATE_TARGET,
      },
      sourceDeduplication: {
        observedPublicSources: observedSources.length,
        uniquePublicSources: uniqueSources.size,
        duplicateSources,
        duplicateRatio,
      },
      domainDiversity: {
        uniqueDomains: domains.size,
        uniquePublicSources: uniqueSources.size,
        ratio: domainRatio,
      },
      sourceTypes,
    },
    reportEvidencePolicy: {
      strategy: reportEvidencePolicy.strategy,
      allowsPrivateAttribution: reportEvidencePolicy.allowsPrivateAttribution,
      forbidsExternalLinks: reportEvidencePolicy.forbidsExternalLinks,
    },
    warnings,
  };
}

function isPublicSource(
  source: EvidenceSource,
): source is Extract<EvidenceSource, { visibility: "public" }> {
  return source.visibility === "public";
}

function uniquePublicSources(
  sources: readonly Extract<EvidenceSource, { visibility: "public" }>[],
): Map<string, Extract<EvidenceSource, { visibility: "public" }>> {
  const unique = new Map<
    string,
    Extract<EvidenceSource, { visibility: "public" }>
  >();
  for (const source of sources) {
    const key = canonicalHttpUrl(source.url);
    if (key && !unique.has(key)) unique.set(key, source);
  }
  return unique;
}

function canonicalHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/u, "");
    }
    return url.toString();
  } catch {
    return "";
  }
}

function sourceHostname(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return "";
  }
}

function classifySource(value: string): EvidenceSourceType {
  const hostname = sourceHostname(value);
  const labels = hostname.split(".");
  if (
    labels.includes("gov") ||
    labels.includes("gouv") ||
    /(?:^|\.)(?:go|gob)\.[a-z]{2}$/u.test(hostname)
  ) {
    return "government";
  }
  if (
    labels.includes("edu") ||
    labels.includes("ac") ||
    hostname === "arxiv.org" ||
    hostname === "doi.org"
  ) {
    return "academic";
  }
  if (labels.includes("org")) return "organization";
  if (labels.includes("com")) return "commercial";
  return "other";
}

function emptySourceTypes(): Record<EvidenceSourceType, number> {
  return {
    government: 0,
    academic: 0,
    organization: 0,
    commercial: 0,
    other: 0,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function percent(value: number): string {
  return `${Number((value * 100).toFixed(1))}%`;
}
