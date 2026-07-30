import assert from "node:assert/strict";
import test from "node:test";

import {
  isApprovalGranted,
  semanticResearchStage,
  summarizeResearchEvent,
} from "../src/research-runner.js";

test("recognizes explicit AO approval answers", () => {
  for (const answer of ["yes", "Y", "true", "1", "是", "同意", "批准", "继续"]) {
    assert.equal(isApprovalGranted(answer), true);
  }
  for (const answer of ["no", "否", "不同意", "", "maybe"]) {
    assert.equal(isApprovalGranted(answer), false);
  }
});

test("cleans internal prompts from observable GPTR messages", () => {
  assert.equal(
    summarizeResearchEvent({
      type: "logs",
      data: {
        content: "subquery_context_not_found",
        output: "<expert_system_prompt>secret role</expert_system_prompt>",
      },
    }),
    "当前子问题未找到可用上下文，将继续使用其他检索结果。",
  );
  assert.equal(
    summarizeResearchEvent({
      type: "logs",
      data: {
        content: "searching",
        output: [
          "<runtime_context>current date and internal rules</runtime_context>",
          "<expert_system_prompt>secret role</expert_system_prompt>",
          "正在检索 **公开资料**。",
          "<task>private task</task>",
          "<citation_contract>internal source rules</citation_contract>",
        ].join("\n"),
      },
    }),
    "正在检索 **公开资料**。",
  );
  assert.equal(
    summarizeResearchEvent({
      type: "logs",
      data: {
        content: "writing_report",
        output: [
          "Writing report for the complete query.",
          "<citation_contract>internal source rules</citation_contract>",
        ].join("\n"),
      },
    }),
    "正在根据研究证据撰写报告。",
  );
  assert.equal(
    summarizeResearchEvent({
      type: "logs",
      data: {
        content: "report_written",
        output: "<task>private task</task>",
      },
    }),
    "报告已完成，正在整理引用与交付内容。",
  );
});

test("uses the GPTR semantic log content as the progress stage", () => {
  assert.equal(
    semanticResearchStage({
      type: "logs",
      data: {
        content: "scraping_urls",
        output: "Scraping 8 URLs",
      },
    }),
    "scraping_urls",
  );
  assert.equal(
    semanticResearchStage({
      type: "gptr.citations.normalized",
      data: { replacements: 3 },
    }),
    "gptr.citations.normalized",
  );
});

test("translates known GPTR progress details into concise Chinese", () => {
  const cases = [
    {
      stage: "scraping_urls",
      output: "🌐 Scraping content from 5 URLs...",
      expected: "正在抓取 5 个网页链接。",
    },
    {
      stage: "scraping_content",
      output: "📄 Scraped 4 pages of content",
      expected: "已整理 4 个网页的内容。",
    },
    {
      stage: "scraping_images",
      output: "🖼️ Selected 4 new images from 40 total images",
      expected: "已从 40 张候选图片中选出 4 张。",
    },
    {
      stage: "scraping_complete",
      output: "🌐 Scraping complete",
      expected: "网页内容抓取完成。",
    },
    {
      stage: "fetching_query_content",
      output: "📚 Getting relevant content based on query: AntonyCheng profile...",
      expected: "正在提取当前查询对应的相关内容。",
    },
    {
      stage: "context_combined",
      output: "📚 Combined research context: 0 MCP sources, web content",
      expected: "已合并研究上下文：0 个 MCP 来源，并纳入网页内容。",
    },
    {
      stage: "research_step_finalized",
      output: "Finalized research step.\n💸 Total Research Costs: $0.02679634",
      expected: "研究步骤已完成。\n累计研究成本：$0.026796。",
    },
  ];

  for (const item of cases) {
    assert.equal(
      summarizeResearchEvent({
        type: "logs",
        data: {
          content: item.stage,
          output: item.output,
        },
      }),
      item.expected,
    );
  }
});

test("localizes research mode, budget, deep, and synthesis milestones", () => {
  const cases = [
    {
      type: "research.mode.selected",
      data: {
        requestedMode: "deep",
        effectiveMode: "deep",
        deep: { breadth: 3, depth: 2, concurrency: 2 },
      },
      expected: "已选择深度研究模式（广度 3、深度 2、并发 2）。",
    },
    {
      type: "research.budget.adjusted",
      data: {
        capacity: 3,
        requestedWeight: 6,
        effectiveWeight: 3,
      },
      expected: "研究并发已按任务预算从 6 调整为 3（总预算 3）。",
    },
    {
      type: "deep_research.progress",
      data: {
        currentDepth: 1,
        totalDepth: 2,
        currentBreadth: 2,
        totalBreadth: 3,
      },
      expected: "深度研究进度：深度 1/2，当前分支 2/3。",
    },
    {
      type: "synthesis.started",
      data: { contextCharacters: 1200 },
      expected: "正在基于上游研究材料综合报告，不再重复检索。",
    },
  ];

  for (const item of cases) {
    assert.equal(
      summarizeResearchEvent({
        type: item.type,
        data: item.data,
      }),
      item.expected,
    );
  }
});

test("hides internal GPTR boilerplate from observable progress", () => {
  assert.equal(
    summarizeResearchEvent({
      type: "logs",
      data: {
        content: "starting_research",
        output: "Starting the research task for 'Follow the expert identity...'",
      },
    }),
    "正在启动本轮研究。",
  );
  assert.equal(
    summarizeResearchEvent({
      type: "logs",
      data: {
        content: "images",
        output: '["https://example.com/one.png", "https://example.com/two.png"]',
      },
    }),
    "已整理本轮研究发现的候选图片。",
  );
});
