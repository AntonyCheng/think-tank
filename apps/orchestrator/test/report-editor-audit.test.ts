import assert from "node:assert/strict";
import test from "node:test";

import { auditReportCitations } from "../src/report-editor-audit.js";

test("audits unverified links and incomplete numeric claim citations", () => {
  const audit = auditReportCitations(
    "GDP grew 3.2% [official](https://stats.example/gdp).\n\nInflation was 5.1% [unknown](https://unknown.example/cpi).",
    4,
    [{ title: "Official statistics", url: "https://stats.example/gdp" }],
  );

  assert.equal(audit.version, 4);
  assert.equal(audit.totalLinks, 2);
  assert.equal(audit.verifiedLinks, 1);
  assert.equal(audit.numericClaimParagraphs, 2);
  assert.equal(audit.citedNumericClaimParagraphs, 1);
  assert.equal(audit.citationCoverage, 0.5);
  assert.equal(audit.warnings.length, 2);
});
