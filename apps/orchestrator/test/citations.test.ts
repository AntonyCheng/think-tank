import assert from "node:assert/strict";
import test from "node:test";

import {
  collectObservedSources,
  formatCitationReport,
  normalizeFinalCitations,
} from "../src/citations.js";

test("normalizes verified source links into numbered report citations", () => {
  const sources = collectObservedSources({
    sourceUrls: [
      "https://stats.example/ai-2026",
      "https://policy.example/rules",
    ],
    sources: [{
      title: "2026 AI Industry Statistics",
      url: "https://stats.example/ai-2026",
    }],
  });
  const result = normalizeFinalCitations(
    [
      "# Report",
      "",
      "市场规模达到 100 亿元（[2026 AI Industry Statistics](https://stats.example/ai-2026)）。",
      "",
      "## References",
      "",
      "- legacy list",
    ].join("\n"),
    sources,
  );

  assert.match(
    result.markdown,
    /100 亿元（\[\\\[1\\\]\]\(https:\/\/stats\.example\/ai-2026\)）/u,
  );
  assert.match(result.markdown, /## 参考来源/u);
  assert.match(
    result.markdown,
    /\[1\] \[2026 AI Industry Statistics\]\(https:\/\/stats\.example\/ai-2026\)/u,
  );
  assert.match(
    result.markdown,
    /\n {4}https:\/\/stats\.example\/ai-2026/u,
  );
  assert.doesNotMatch(result.markdown, /legacy list/u);
  assert.deepEqual(result.citations, [{
    id: 1,
    title: "2026 AI Industry Statistics",
    url: "https://stats.example/ai-2026",
  }]);
  assert.equal(result.numericClaimParagraphs, 1);
  assert.equal(result.citedNumericClaimParagraphs, 1);
  assert.deepEqual(result.warnings, []);
});

test("keeps semantic links and appends the matching numbered citation", () => {
  const url =
    "https://github.com/AntonyCheng/spring-boot-init-template";
  const title = [
    "GitHub - AntonyCheng/spring-boot-init-template:",
    "基于 Java Web 项目的 SpringBoot 框架初始化模板",
    "· GitHub",
  ].join(" ");
  const result = normalizeFinalCitations(
    [
      "# Report",
      "",
      "| 项目 | Stars |",
      "| --- | --- |",
      `| [spring-boot-init-template](${url}) | 542 |`,
      "",
      `来源：[^4](${url})`,
      "",
      "## References",
      "",
      `[^4](${url})`,
    ].join("\n"),
    [{ title, url }],
  );

  assert.match(
    result.markdown,
    /\[spring-boot-init-template\]\(https:\/\/github\.com\/AntonyCheng\/spring-boot-init-template\)\[\\\[1\\\]\]\(https:\/\/github\.com\/AntonyCheng\/spring-boot-init-template\)/u,
  );
  assert.match(
    result.markdown,
    /来源：\[\\\[1\\\]\]\(https:\/\/github\.com\/AntonyCheng\/spring-boot-init-template\)/u,
  );
  assert.match(result.markdown, /## 参考来源/u);
  assert.doesNotMatch(result.markdown, /## References/u);
  assert.deepEqual(result.citations, [{ id: 1, title, url }]);
});

test("collapses descriptive prose source links into one numbered citation", () => {
  const url = "https://example.com/tencent-2025-results";
  const result = normalizeFinalCitations(
    [
      "# 腾讯年度经营调研",
      "",
      `Non-IFRS 净利润同比增长 16%。[腾讯2025年总营收7518亿元：微信及WeChat月活高达14.18亿](${url})`,
    ].join("\n"),
    [{
      title: "腾讯控股有限公司 2025 年度业绩公告",
      url,
    }],
  );

  assert.match(
    result.markdown,
    new RegExp(`增长 16%。\\[\\\\\\[1\\\\\\]\\]\\(${url.replaceAll("/", "\\/")}\\)`, "u"),
  );
  assert.doesNotMatch(result.markdown, /腾讯2025年总营收/u);
  assert.equal(
    (result.markdown.match(/\[\\\[1\\\]\]\(https:\/\/example\.com/gu) ?? [])
      .length,
    1,
  );
  assert.match(result.markdown, /## 参考来源/u);
});

test("formats persisted citation links and their source list idempotently", () => {
  const url = "https://github.com/AntonyCheng/share-study";
  const sources = [{
    title: "GitHub - AntonyCheng/share-study: 教学资源共享平台 · GitHub",
    url,
  }];
  const legacy = [
    "# 报告",
    "",
    `正文使用旧角标 [^5](${url})。`,
    "",
    `正文使用旧来源名称 [AntonyCheng/share-study · GitHub](${url})。`,
    "",
    "## 已验证来源",
    "",
    `1. [旧来源名称](${url})`,
  ].join("\n");

  const formatted = formatCitationReport(legacy, sources);

  assert.match(
    formatted,
    new RegExp(`旧角标 \\[\\\\\\[1\\\\\\]\\]\\(${url.replaceAll("/", "\\/")}\\)`, "u"),
  );
  assert.match(formatted, /## 参考来源/u);
  assert.equal((formatted.match(/## 参考来源/gu) ?? []).length, 1);
  assert.equal(formatCitationReport(formatted, sources), formatted);
});

test("removes numbered reference sections before rebuilding one source list", () => {
  const url = "https://example.com/news";
  const sources = [{ title: "来源", url }];
  for (
    const heading of [
      "## 六、参考来源",
      "## 第六章 参考文献",
      "## 6. References",
    ]
  ) {
    const input = [
      "# 报告",
      "",
      `正文数据 42%。[来源](${url})`,
      "",
      heading,
      "",
      `[来源](${url})`,
    ].join("\n");

    const formatted = formatCitationReport(input, sources);

    assert.doesNotMatch(formatted, new RegExp(heading.slice(3), "u"));
    assert.equal(
      (formatted.match(/^#{1,6}\s+参考来源\s*$/gmu) ?? []).length,
      1,
    );
    assert.equal(
      (formatted.match(/\[\\\[1\\\]\]\(https:\/\/example\.com\/news\)/gu) ??
        []).length,
      1,
    );
    assert.equal(formatCitationReport(formatted, sources), formatted);
  }
});

test("warns when data claims or links cannot be verified", () => {
  const result = normalizeFinalCitations(
    "收入增长 42%，但没有引用。\n\n[未知来源](https://unknown.example/data)",
    [{ title: "Known", url: "https://known.example/data" }],
  );

  assert.equal(result.citations.length, 0);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings.join("\n"), /未保留任何/u);
  assert.match(result.warnings.join("\n"), /含数据段落/u);
  assert.match(result.warnings.join("\n"), /不在本次检索来源/u);
});
