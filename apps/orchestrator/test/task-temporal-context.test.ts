import assert from "node:assert/strict";
import test from "node:test";

import {
  createTaskTemporalContext,
  resolveRelativeYearScope,
  renderTaskTemporalContext,
} from "../src/task-temporal-context.js";

test("creates one cross-platform local time snapshot for a research task", () => {
  const context = createTaskTemporalContext(
    new Date("2026-07-29T03:20:00.000Z"),
    "Asia/Shanghai",
  );

  assert.deepEqual(context, {
    startedAt: "2026-07-29T03:20:00.000Z",
    timeZone: "Asia/Shanghai",
    localDate: "2026-07-29",
    localTime: "11:20:00",
    weekday: "星期三",
  });
  assert.equal(Object.isFrozen(context), true);
  assert.match(renderTaskTemporalContext(context), /当前日期：2026-07-29/u);
});

test("resolves 近三年 as the current year-to-date plus two prior years", () => {
  const context = createTaskTemporalContext(
    new Date("2026-07-29T03:20:00.000Z"),
    "Asia/Shanghai",
  );

  assert.deepEqual(
    resolveRelativeYearScope("帮我分析一下美国近三年经济情况", context),
    {
      count: 3,
      startYear: 2024,
      endYear: 2026,
      includesCurrentYearToDate: true,
    },
  );
  assert.match(
    renderTaskTemporalContext(context),
    /“近 N 年”[\s\S]*默认包含当前年度截至任务启动日期/u,
  );
});

test("keeps completed calendar years when the user explicitly asks for them", () => {
  const context = createTaskTemporalContext(
    new Date("2026-07-29T03:20:00.000Z"),
    "Asia/Shanghai",
  );

  assert.deepEqual(
    resolveRelativeYearScope("分析最近三个完整自然年", context),
    {
      count: 3,
      startYear: 2023,
      endYear: 2025,
      includesCurrentYearToDate: false,
    },
  );
});
