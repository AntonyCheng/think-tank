import assert from "node:assert/strict";
import test from "node:test";

import { auditReportCitations } from "../src/report-editor-audit.js";

test("does not re-grade the initial report with an editor-only coverage metric", () => {
  const audit = auditReportCitations(
    {
      markdown: "GDP grew 3.2% [official](https://stats.example/gdp).",
      baselineMarkdown: "GDP grew 3.2% [official](https://stats.example/gdp).",
      version: 1,
      sources: [{ title: "Official statistics", url: "https://stats.example/gdp", referenceId: 1 }],
    },
  );

  assert.equal(audit.version, 1);
  assert.equal(audit.mode, "baseline");
  assert.equal(audit.totalLinks, 1);
  assert.equal(audit.verifiedLinks, 1);
  assert.equal(audit.numericClaimParagraphs, 0);
  assert.equal(audit.citationCoverage, null);
  assert.equal(audit.warnings.length, 0);
});

test("audits only changed data blocks and recognizes numbered source markers", () => {
  const audit = auditReportCitations({
    markdown: "Original context.\n\nGDP grew 3.2% [1].",
    baselineMarkdown: "Original context.",
    version: 2,
    sources: [{ title: "Official statistics", url: "https://stats.example/gdp", referenceId: 1 }],
  });

  assert.equal(audit.mode, "edited");
  assert.equal(audit.changedBlocks, 1);
  assert.equal(audit.numericClaimParagraphs, 1);
  assert.equal(audit.citedNumericClaimParagraphs, 1);
  assert.equal(audit.citationCoverage, 1);
  assert.equal(audit.warnings.length, 0);
});
