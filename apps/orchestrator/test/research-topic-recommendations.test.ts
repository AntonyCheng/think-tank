import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ResearchTopicRecommendationService,
  type ResearchTopicRecommendation,
} from "../src/research-topic-recommendations.js";

const firstGeneratedTopics: ResearchTopicRecommendation[] = [
  { id: "ignored-1", category: "科技趋势", title: "人工智能基础设施建设与产业竞争格局变化研究", summary: "分析算力供给、模型能力、应用生态和商业模式之间的关系。", sources: [{ title: "人工智能产业观察", url: "https://example.com/ai", domain: "example.com" }] },
  { id: "ignored-2", category: "宏观经济", title: "居民消费信心变化与服务消费增长动力研究", summary: "关注收入预期、消费结构、政策支持和行业分化趋势。", sources: [] },
  { id: "ignored-3", category: "能源转型", title: "新型电力系统发展对储能产业链的影响研究", summary: "研究市场机制、技术路线、成本变化和规模化应用条件。", sources: [] },
  { id: "ignored-4", category: "城市发展", title: "人口流动变化对城市住房与公共服务配置的影响", summary: "分析人口结构、空间分布、住房需求和公共资源配置。", sources: [] },
];
const generatedTopics: ResearchTopicRecommendation[] = Array.from(
  { length: 12 },
  (_, index) => {
    const template = firstGeneratedTopics[index % firstGeneratedTopics.length]!;
    return {
      ...template,
      id: `ignored-${index + 1}`,
      title: `${template.title}${index + 1}`,
    };
  },
);

test("returns fallback topics immediately while the first refresh runs", async () => {
  let resolveRefresh!: (value: ResearchTopicRecommendation[]) => void;
  const pending = new Promise<ResearchTopicRecommendation[]>((resolve) => {
    resolveRefresh = resolve;
  });
  const service = new ResearchTopicRecommendationService({
    refresh: () => pending,
    now: () => Date.parse("2026-08-13T00:00:00.000Z"),
  });

  const initial = await service.get();
  assert.equal(initial.source, "fallback");
  assert.equal(initial.refreshing, true);
  assert.equal(initial.items.length, 4);

  resolveRefresh(generatedTopics);
  await service.refresh();
  const refreshed = await service.get();
  assert.equal(refreshed.source, "generated");
  assert.equal(refreshed.refreshing, false);
  assert.equal(refreshed.items.length, 12);
  assert.equal(refreshed.items[0]?.title, generatedTopics[0]?.title);
  assert.deepEqual(refreshed.items[0]?.sources, generatedTopics[0]?.sources);
  assert.match(refreshed.items[0]?.id ?? "", /^topic-[a-f0-9]{12}$/u);
});

test("keeps cached topics for three hours and refreshes stale data in the background", async () => {
  let now = Date.parse("2026-08-13T00:00:00.000Z");
  let calls = 0;
  let releaseSecondRefresh!: (value: ResearchTopicRecommendation[]) => void;
  const service = new ResearchTopicRecommendationService({
    now: () => now,
    refresh: async () => {
      calls += 1;
      if (calls === 1) return generatedTopics;
      return new Promise<ResearchTopicRecommendation[]>((resolve) => {
        releaseSecondRefresh = resolve;
      });
    },
  });

  await service.refresh();
  const fresh = await service.get();
  assert.equal(calls, 1);
  assert.equal(fresh.refreshing, false);
  assert.equal(fresh.nextRefreshAt, "2026-08-13T03:00:00.000Z");

  now += 3 * 60 * 60 * 1_000;
  const stale = await service.get();
  assert.equal(calls, 2);
  assert.equal(stale.source, "generated");
  assert.equal(stale.refreshing, true);
  assert.equal(stale.items[0]?.title, generatedTopics[0]?.title);

  releaseSecondRefresh(generatedTopics.map((item) => ({
    ...item,
    title: `${item.title}更新版`,
  })));
  await service.refresh();
  const updated = await service.get();
  assert.equal(updated.refreshing, false);
  assert.match(updated.items[0]?.title ?? "", /更新版$/u);
  assert.equal(updated.nextRefreshAt, "2026-08-13T06:00:00.000Z");
});

test("deduplicates concurrent refreshes", async () => {
  let calls = 0;
  let resolveRefresh!: (value: ResearchTopicRecommendation[]) => void;
  const service = new ResearchTopicRecommendationService({
    refresh: async () => {
      calls += 1;
      return new Promise<ResearchTopicRecommendation[]>((resolve) => {
        resolveRefresh = resolve;
      });
    },
  });

  const first = service.refresh();
  const second = service.refresh();
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveRefresh(generatedTopics);
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});
