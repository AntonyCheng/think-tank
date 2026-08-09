import assert from "node:assert/strict";
import test from "node:test";

import type { CitationNormalization } from "../src/citations.js";
import type { EvidenceBundle } from "../src/evidence-bundle.js";
import {
  applyCurrentEvidenceQualityTargets,
  assessEvidenceQuality,
} from "../src/evidence-quality.js";

function citationNormalization(
  overrides: Partial<CitationNormalization> = {},
): CitationNormalization {
  return {
    markdown: "# 报告",
    citations: [],
    warnings: [],
    numericClaimParagraphs: 0,
    citedNumericClaimParagraphs: 0,
    bodyLinkCount: 0,
    verifiedBodyLinkCount: 0,
    ...overrides,
  };
}

function bundle(
  aoStepId: string,
  urls: readonly string[],
): EvidenceBundle {
  return {
    schemaVersion: 1,
    aoStepId,
    researchRunId: `run-${aoStepId}`,
    attempt: 1,
    mode: "standard",
    startedAt: "2026-07-29T10:00:00.000Z",
    completedAt: "2026-07-29T10:01:00.000Z",
    derivedFromStepIds: [],
    queries: [],
    sources: urls.map((url, index) => ({
      id: `source-${index + 1}`,
      visibility: "public" as const,
      url,
      title: new URL(url).hostname,
      observedAt: "2026-07-29T10:01:00.000Z",
    })),
    researchContext: {
      content: "",
      originalCharacters: 0,
      truncated: false,
    },
    method: {
      sourceMode: "web",
      retrievers: ["duckduckgo"],
      sourceCurationRequested: true,
    },
    report: {
      format: "markdown",
      content: "# 报告",
      revision: 1,
    },
    cost: null,
  };
}

test("computes deterministic evidence metrics without a model or network", () => {
  const result = assessEvidenceQuality({
    citationNormalization: citationNormalization({
      numericClaimParagraphs: 2,
      citedNumericClaimParagraphs: 2,
      bodyLinkCount: 3,
      verifiedBodyLinkCount: 3,
      citations: [
        { id: 1, title: "Gov", url: "https://stats.gov.cn/data" },
        { id: 2, title: "Paper", url: "https://lab.edu.cn/paper" },
        { id: 3, title: "Company", url: "https://example.com/report" },
      ],
    }),
    evidenceBundles: [
      bundle("market", [
        "https://stats.gov.cn/data",
        "https://lab.edu.cn/paper",
        "https://example.com/report",
      ]),
      bundle("risk", ["https://stats.gov.cn/data"]),
    ],
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    status: "passed",
    metrics: {
      citationCoverage: {
        citedClaimParagraphs: 2,
        totalClaimParagraphs: 2,
        ratio: 1,
        target: 0.75,
      },
      validLinkRate: {
        verifiedLinks: 3,
        totalLinks: 3,
        ratio: 1,
        target: 1,
      },
      sourceDeduplication: {
        observedPublicSources: 4,
        uniquePublicSources: 3,
        duplicateSources: 1,
        duplicateRatio: 0.25,
      },
      domainDiversity: {
        uniqueDomains: 3,
        uniquePublicSources: 3,
        ratio: 1,
      },
      sourceTypes: {
        government: 1,
        academic: 1,
        organization: 0,
        commercial: 1,
        other: 0,
      },
    },
    reportEvidencePolicy: {
      strategy: "public_verified",
      allowsPrivateAttribution: false,
      forbidsExternalLinks: false,
    },
    warnings: [],
  });
});

test("returns typed warnings for low evidence quality instead of failing", () => {
  const result = assessEvidenceQuality({
    citationNormalization: citationNormalization({
      numericClaimParagraphs: 5,
      citedNumericClaimParagraphs: 2,
      bodyLinkCount: 2,
      verifiedBodyLinkCount: 1,
      citations: [{
        id: 1,
        title: "Example",
        url: "https://example.com/a",
      }],
    }),
    evidenceBundles: [
      bundle("market", [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
      ]),
      bundle("risk", [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
      ]),
    ],
  });

  assert.equal(result.status, "warning");
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    [
      "citation_coverage_low",
      "unverified_links",
      "source_duplication_high",
      "domain_diversity_low",
    ],
  );
  assert.equal(result.metrics.citationCoverage.ratio, 0.4);
  assert.equal(result.metrics.validLinkRate.ratio, 0.5);
  assert.equal(result.metrics.sourceDeduplication.duplicateRatio, 0.5);
  assert.equal(result.metrics.domainDiversity.uniqueDomains, 1);
});

test("accepts citation coverage at the 75 percent target", () => {
  const result = assessEvidenceQuality({
    citationNormalization: citationNormalization({
      numericClaimParagraphs: 4,
      citedNumericClaimParagraphs: 3,
      bodyLinkCount: 3,
      verifiedBodyLinkCount: 3,
    }),
    evidenceBundles: [bundle("market", [
      "https://example.com/a",
      "https://example.org/b",
    ])],
  });

  assert.equal(result.status, "passed");
  assert.equal(result.metrics.citationCoverage.ratio, 0.75);
  assert.equal(result.metrics.citationCoverage.target, 0.75);
});

test("reinterprets persisted coverage using the current target", () => {
  const assessment = assessEvidenceQuality({
    citationNormalization: citationNormalization({
      numericClaimParagraphs: 5,
      citedNumericClaimParagraphs: 3,
    }),
    evidenceBundles: [],
  });
  const legacy = {
    ...assessment,
    status: "warning" as const,
    metrics: {
      ...assessment.metrics,
      citationCoverage: {
        ...assessment.metrics.citationCoverage,
        ratio: 0.796,
        target: 0.8,
      },
    },
    warnings: [{
      code: "citation_coverage_low" as const,
      message: "证据质量：含数据段落的已验证引用覆盖率为 79.6%，低于 80%。",
    }],
  };

  const current = applyCurrentEvidenceQualityTargets(legacy);
  assert.equal(current.status, "passed");
  assert.equal(current.metrics.citationCoverage.target, 0.75);
  assert.deepEqual(current.warnings, []);
});

test("uses null ratios when a metric has no denominator", () => {
  const result = assessEvidenceQuality({
    citationNormalization: citationNormalization(),
    evidenceBundles: [],
  });

  assert.equal(result.status, "passed");
  assert.equal(result.metrics.citationCoverage.ratio, null);
  assert.equal(result.metrics.validLinkRate.ratio, null);
  assert.equal(result.metrics.sourceDeduplication.duplicateRatio, null);
  assert.equal(result.metrics.domainDiversity.ratio, null);
});

test("does not require public citations for private document evidence", () => {
  const privateBundle = bundle("internal", []);
  privateBundle.sources = [{
    id: "source-1",
    visibility: "private",
    locator: "document:policy/search/call_01",
    title: "Restricted policy material",
    sourceType: "document",
    observedAt: "2026-07-29T10:01:00.000Z",
  }];
  privateBundle.method = {
    sourceMode: "local",
    retrievers: [],
  };

  const result = assessEvidenceQuality({
    citationNormalization: citationNormalization({
      numericClaimParagraphs: 1,
      citedNumericClaimParagraphs: 0,
    }),
    evidenceBundles: [privateBundle],
  });

  assert.equal(result.status, "passed");
  assert.equal(result.reportEvidencePolicy.strategy, "private_bounded");
  assert.equal(result.warnings.length, 0);
});
