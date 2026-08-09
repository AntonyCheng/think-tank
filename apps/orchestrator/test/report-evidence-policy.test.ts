import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { deriveReportEvidencePolicy } from "../src/report-evidence-policy.js";
import type { EvidenceBundle } from "../src/evidence-bundle.js";
import type { ResearchProfile } from "../src/research-profile.js";

interface PolicyFixture {
  name: string;
  profile: Pick<ResearchProfile, "mode" | "source">;
  upstreamEvidence?: Array<{ sources: Array<{ visibility: "public" | "private" }> }>;
  expectedStrategy: string;
}

const policyFixtures = JSON.parse(readFileSync(
  new URL(
    "../../../contracts/report-evidence-policy/v1/cases.json",
    import.meta.url,
  ),
  "utf8",
)) as { cases: PolicyFixture[] };

for (const fixture of policyFixtures.cases) {
  test(`ReportEvidencePolicy: ${fixture.name}`, () => {
    const policy = deriveReportEvidencePolicy({
      profile: fixture.profile as ResearchProfile,
      evidenceBundles: fixture.upstreamEvidence?.map((upstream) => bundle(
        upstream.sources.map((source, index) => source.visibility === "private"
          ? {
              id: `source-${index + 1}`,
              visibility: "private" as const,
              locator: `document:private-${index + 1}`,
              title: "Restricted evidence",
              observedAt: "2026-08-02T00:01:00.000Z",
            }
          : {
              id: `source-${index + 1}`,
              visibility: "public" as const,
              url: `https://example.com/${index + 1}`,
              title: "Public evidence",
              observedAt: "2026-08-02T00:01:00.000Z",
            }
        ),
      )),
    });
    assert.equal(policy.strategy, fixture.expectedStrategy);
  });
}

function bundle(sources: EvidenceBundle["sources"]): EvidenceBundle {
  return {
    schemaVersion: 1,
    aoStepId: "step",
    researchRunId: "run",
    attempt: 1,
    mode: "standard",
    startedAt: "2026-08-02T00:00:00.000Z",
    completedAt: "2026-08-02T00:01:00.000Z",
    derivedFromStepIds: [],
    queries: [],
    sources,
    researchContext: { content: "", originalCharacters: 0, truncated: false },
    method: { sourceMode: "local", retrievers: [] },
    report: { format: "markdown", content: "# Report", revision: 1 },
    cost: null,
  };
}

test("derives a private policy from private document evidence", () => {
  const policy = deriveReportEvidencePolicy({
    evidenceBundles: [bundle([{
      id: "source-1",
      visibility: "private",
      locator: "document:policy/search/call_01",
      title: "Managed source",
      sourceType: "document",
      observedAt: "2026-08-02T00:01:00.000Z",
    }])],
  });

  assert.equal(policy.strategy, "private_bounded");
  assert.equal(policy.forbidsExternalLinks, true);
  assert.equal(policy.requiresPublicCitationForFact, false);
});

test("derives a mixed policy without exposing private locators", () => {
  const policy = deriveReportEvidencePolicy({
    evidenceBundles: [bundle([{
      id: "source-1",
      visibility: "private",
      locator: "document:private-1",
      title: "Internal document",
      observedAt: "2026-08-02T00:01:00.000Z",
    }, {
      id: "source-2",
      visibility: "public",
      url: "https://example.gov/policy#section",
      title: "Policy",
      observedAt: "2026-08-02T00:01:00.000Z",
    }])],
  });

  assert.equal(policy.strategy, "mixed_evidence");
  assert.deepEqual(policy.allowedPublicUrls, ["https://example.gov/policy#section"]);
  assert.equal(policy.sourceDisclosure, "restricted");
});
