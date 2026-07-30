import assert from "node:assert/strict";
import { test } from "node:test";

import { researchCompositionDescription } from "../src/research-compose.js";

test("adds the native AO acceptance contract without changing the topic", () => {
  const description = researchCompositionDescription("研究一个主题", {
    startedAt: "2026-07-29T03:20:00.000Z",
    timeZone: "Asia/Shanghai",
    localDate: "2026-07-29",
    localTime: "11:20:00",
    weekday: "星期三",
  });

  assert.match(description, /^研究一个主题/u);
  assert.match(description, /当前日期：2026-07-29/u);
  assert.match(description, /当前时间：11:20:00/u);
  assert.match(description, /星期：星期三/u);
  assert.match(description, /时区：Asia\/Shanghai/u);
  assert.match(description, /不得把历史事件描述为当前事件/u);
  assert.match(description, /acceptance:/u);
  assert.match(description, /2-5/u);
  assert.match(description, /不能只写在 task:/u);
  assert.match(description, /depends_on/u);
  assert.match(description, /steps\[\]\.id/u);
  assert.match(description, /不得生成参考来源章节/u);
  assert.doesNotMatch(description, /并包含参考来源部分/u);
});

test("pins a relative multi-year request to the current year-to-date", () => {
  const description = researchCompositionDescription(
    "帮我分析一下美国近三年经济情况",
    {
      startedAt: "2026-07-29T03:20:00.000Z",
      timeZone: "Asia/Shanghai",
      localDate: "2026-07-29",
      localTime: "11:20:00",
      weekday: "星期三",
    },
  );

  assert.match(description, /本任务的“近三年”范围：2024、2025、2026/u);
  assert.match(description, /2026 年仅统计到 2026-07-29/u);
  assert.match(description, /acceptance.*2024.*2025.*2026/su);
});

test("tells AO the task profile and the only supported step override seam", () => {
  const description = researchCompositionDescription(
    "研究一个主题",
    {
      startedAt: "2026-07-29T03:20:00.000Z",
      timeZone: "Asia/Shanghai",
      localDate: "2026-07-29",
      localTime: "11:20:00",
      weekday: "星期三",
    },
    {
      schemaVersion: 1,
      mode: "standard",
      source: { mode: "web", retrievers: ["duckduckgo"] },
      quality: { curateSources: false },
      limits: {
        maxSearchResultsPerQuery: 5,
        maxIterations: 4,
        maxSubtopics: 3,
      },
    },
    {
      modes: ["standard", "deep", "synthesis"],
      sourceModes: ["web"],
      retrievers: ["duckduckgo"],
      maxRetrievers: 1,
      sourceCuration: false,
      domainFilters: false,
      deepResearch: {
        maxBreadth: 4,
        maxDepth: 3,
        maxResearchCalls: 32,
      },
    },
  );

  assert.match(description, /step\.llm\.params\.think_tank/u);
  assert.match(description, /maxIterations:\s*4/u);
  assert.match(description, /只能使用已启用能力/u);
  assert.match(description, /顶层 llm\.params\.think_tank/u);
  assert.match(description, /standard.*默认/u);
  assert.match(description, /deep.*breadth.*depth.*concurrency/u);
  assert.match(description, /synthesis.*depends_on/u);
  assert.match(description, /task.*上游 output 变量/u);
  assert.match(description, /预计研究调用数.*32/u);
  assert.match(description, /source 是来源授权边界/u);
  assert.match(description, /URL-only 任务启用 Web/u);
  assert.match(description, /不得扩大 includeDomains/u);
});
