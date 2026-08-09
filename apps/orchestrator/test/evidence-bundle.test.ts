import assert from "node:assert/strict";
import test from "node:test";

import {
  EvidenceLedger,
  type EvidenceRecord,
} from "../src/evidence-bundle.js";
import type { ResearchProfile } from "../src/research-profile.js";

const webProfile: ResearchProfile = {
  schemaVersion: 1,
  mode: "standard",
  source: {
    mode: "web",
    retrievers: ["duckduckgo"],
  },
  quality: {
    curateSources: true,
  },
  limits: {
    maxSearchResultsPerQuery: 5,
    maxIterations: 3,
    maxSubtopics: 3,
  },
};

function record(
  overrides: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  return {
    aoStepId: "market",
    researchRunId: "run-1",
    dependsOn: [],
    profile: webProfile,
    startedAt: "2026-07-29T10:00:00.000Z",
    completedAt: "2026-07-29T10:02:00.000Z",
    report: "Report",
    cost: null,
    capture: {
      queries: [],
      sources: [],
      researchContext: {
        content: "",
        originalCharacters: 0,
        truncated: false,
      },
    },
    ...overrides,
  };
}

test("records one auditable evidence bundle for an AO research step", () => {
  const ledger = new EvidenceLedger();
  const bundle = ledger.record({
    aoStepId: "market_analysis",
    researchRunId: "research-1",
    dependsOn: [],
    profile: webProfile,
    startedAt: "2026-07-29T10:00:00.000Z",
    completedAt: "2026-07-29T10:02:00.000Z",
    report: "# 市场报告",
    cost: 0.25,
    capture: {
      queries: [
        { kind: "subquery", text: "2026 AI 市场规模" },
        { kind: "subquery", text: "2026 AI 市场规模" },
      ],
      sources: [{
        visibility: "public",
        url: "https://example.com/report/#section",
        title: "行业报告",
        summary: "可验证的市场数据",
      }],
      researchContext: {
        content: "研究上下文",
        originalCharacters: 5,
        truncated: false,
      },
      scraper: "BeautifulSoupScraper",
    },
  });

  assert.deepEqual(bundle, {
    schemaVersion: 1,
    aoStepId: "market_analysis",
    researchRunId: "research-1",
    attempt: 1,
    mode: "standard",
    startedAt: "2026-07-29T10:00:00.000Z",
    completedAt: "2026-07-29T10:02:00.000Z",
    derivedFromStepIds: [],
    queries: [{
      id: "query-1",
      kind: "subquery",
      text: "2026 AI 市场规模",
    }],
    sources: [{
      id: "source-1",
      visibility: "public",
      url: "https://example.com/report/",
      title: "行业报告",
      sourceType: "web",
      summary: "可验证的市场数据",
      observedAt: "2026-07-29T10:02:00.000Z",
    }],
    researchContext: {
      content: "研究上下文",
      originalCharacters: 5,
      truncated: false,
    },
    method: {
      sourceMode: "web",
      retrievers: ["duckduckgo"],
      sourceCurationRequested: true,
      scraper: "BeautifulSoupScraper",
    },
    report: {
      format: "markdown",
      content: "# 市场报告",
      revision: 1,
    },
    cost: 0.25,
  });
  assert.deepEqual(ledger.snapshot(), [bundle]);
});

test("preserves complete source summaries and research context", () => {
  const ledger = new EvidenceLedger();
  const bundle = ledger.record({
    aoStepId: "bounded_evidence",
    researchRunId: "research-1",
    dependsOn: [],
    profile: webProfile,
    startedAt: "2026-07-29T10:00:00.000Z",
    completedAt: "2026-07-29T10:02:00.000Z",
    report: "# 报告",
    cost: null,
    capture: {
      queries: [],
      sources: [{
        visibility: "public",
        url: "https://example.com/large",
        title: "大页面",
        summary: "摘".repeat(1_500),
      }],
      researchContext: {
        content: "文".repeat(25_000),
        originalCharacters: 25_000,
        truncated: false,
      },
    },
  });

  assert.equal(bundle.sources[0]?.summary?.length, 1_500);
  assert.equal(bundle.researchContext.content.length, 25_000);
  assert.equal(bundle.researchContext.originalCharacters, 25_000);
  assert.equal(bundle.researchContext.truncated, false);
});

test("keeps revision history but synthesizes only the latest dependency attempt", () => {
  const ledger = new EvidenceLedger();
  ledger.record(record({
    researchRunId: "run-1",
    report: "First report",
    capture: {
      queries: [{ kind: "subquery", text: "market evidence" }],
      sources: [{
        visibility: "public",
        url: "https://example.com/market",
        title: "Market source",
      }],
      researchContext: {
        content: "Original research context",
        originalCharacters: 25,
        truncated: false,
      },
    },
  }));
  ledger.record(record({
    researchRunId: "run-2",
    report: "Corrected report",
  }));

  const snapshot = ledger.snapshot();
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[1]?.attempt, 2);
  assert.equal(snapshot[1]?.report.revision, 2);
  assert.equal(snapshot[1]?.report.supersedesResearchRunId, "run-1");
  const [synthesisInput] = ledger.forSynthesis(["market"]);
  assert.equal(synthesisInput?.researchRunId, "run-2");
  assert.equal(synthesisInput?.report.content, "Corrected report");
  assert.equal(synthesisInput?.sources[0]?.title, "Market source");
  assert.equal(
    synthesisInput?.researchContext.content,
    "Original research context",
  );

  const [acceptedInput] = ledger.forSynthesis(
    ["market"],
    "AO rendered dependency:\n\nFirst report",
  );
  assert.equal(acceptedInput?.researchRunId, "run-1");
  assert.equal(acceptedInput?.report.content, "First report");
});

test("exposes only public evidence to final citation normalization", () => {
  const ledger = new EvidenceLedger();
  ledger.record(record({
    capture: {
      queries: [],
      sources: [
        {
          visibility: "public",
          url: "https://example.com/public",
          title: "Public source",
        },
        {
          visibility: "private",
          locator: "document:customer-notes",
          title: "Customer notes",
        },
      ],
      researchContext: {
        content: "",
        originalCharacters: 0,
        truncated: false,
      },
    },
  }));

  assert.deepEqual(ledger.publicSources(), [{
    title: "Public source",
    url: "https://example.com/public",
  }]);
});

test("tracks private document evidence without exposing locators", () => {
  const ledger = new EvidenceLedger();
  const bundle = ledger.record(record({
    profile: {
      schemaVersion: 1,
      mode: "standard",
      source: {
        mode: "local",
        documentIds: ["policy-library"],
      },
      quality: { curateSources: false },
      limits: {
        maxSearchResultsPerQuery: 5,
        maxIterations: 2,
        maxSubtopics: 3,
      },
    },
    capture: {
      queries: [],
      sources: [{
        visibility: "private",
        locator: "document:policy-library/search_policy/call_01",
        title: "本地文档",
        sourceType: "document",
      }],
      researchContext: {
        content: "bounded local document evidence",
        originalCharacters: 20,
        truncated: false,
      },
    },
  }));

  assert.deepEqual(ledger.publicSources(), []);
});
