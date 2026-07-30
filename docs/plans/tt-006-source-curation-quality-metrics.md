# TT-006 来源策展与确定性质量指标实施 Plan

## 状态

已完成实现与自动化验证。

## 目标

在不修改 AO 与 GPTR 上游源码的前提下：

- `standard`、`deep` 默认启用 GPTR 原生来源策展，`synthesis` 不启用；
- 允许 AO 步骤通过 `quality.curateSources` 显式关闭研究步骤的来源策展；
- 在 AO 内容验收之外生成版本化、可复算的证据质量结果；
- 证据质量不足只让任务进入 `completed_with_warnings`，不覆盖报告或误报执行失败；
- 前端分别展示“内容验收”和“证据质量”。

## 现状证据

- GPTR 0.16.0 已通过 `CURATE_SOURCES` 调用 `SourceCurator`，当前 Python 工作进程未设置该变量。
- TypeScript 与 Python 的 `ResearchProfile` 已有 `quality.curateSources`，但能力开关均为 `false`。
- `normalizeFinalCitations()` 已统计含数据段落及其中带验证链接的段落。
- `EvidenceLedger` 已保存各步骤来源，并提供跨步骤去重后的公开来源。
- 任务状态目前把 AO 验收警告和引用警告合并成一个无类型字符串数组，前端无法区分。

## 第一性原理决策

1. 来源策展属于“检索后的来源选择”，仅适用于会搜索的 `standard/deep`；`synthesis` 只消费上游证据。
2. “有效链接”V1 定义为语法有效的 HTTP(S) 正文链接且存在于本次 EvidenceLedger 允许列表。暂不发在线 HEAD 请求，避免代理、限流和站点反爬把网络可达性误当报告质量。
3. 引用覆盖率只计算可确定识别的“含数字、百分比、金额、日期或量化单位的段落”。不使用模型猜测哪些句子是事实。
4. 域名多样性按规范化 hostname 计算；来源类型按域名后缀确定性分类为 `government`、`academic`、`organization`、`commercial`、`other`。
5. 阈值是显式策略常量，不产生虚假的综合分数：覆盖率至少 80%，有效链接率必须 100%；来源不少于 3 个时至少来自 2 个域名；跨步骤重复来源率高于 25%时警告。

## 公共契约

新增纯函数：

```ts
assessEvidenceQuality(input: {
  citationNormalization: CitationNormalization;
  evidenceBundles: readonly EvidenceBundle[];
}): EvidenceQualityAssessment
```

结果包含：

- `schemaVersion: 1`
- `status: "passed" | "warning"`
- `metrics.citationCoverage`
- `metrics.validLinkRate`
- `metrics.sourceDeduplication`
- `metrics.domainDiversity`
- `metrics.sourceTypes`
- 带稳定 `code` 和中文 `message` 的 `warnings`

`ResearchTaskSnapshot` 新增：

```ts
contentAcceptance?: { status: "passed" | "warning"; warnings: string[] }
evidenceQuality?: EvidenceQualityAssessment
```

旧 `warnings` 字段保留为兼容的合并视图。

## TDD 实施顺序

1. ResearchProfile 契约：模式默认值、显式关闭、synthesis 禁止策展、两端能力一致。
2. Python 适配：隔离工作进程准确设置 `CURATE_SOURCES`，且 synthesis 始终关闭。
3. 质量纯函数：覆盖率、允许列表链接率、跨 bundle 去重、域名、类型和边界阈值。
4. Runner：引用归一化后计算并返回证据质量；EvidenceBundle 记录“请求了策展”，不伪称策展成功。
5. TaskManager：分别持久化内容验收与证据质量，并由二者共同决定警告完成状态。
6. 前端：四项指标、分区警告卡和兼容旧任务回退。
7. 全量 Node/Python 测试、typecheck、build、acceptance、服务重启与健康检查。

## 范围与非目标

本项不实现实时 URL 可达性探测、来源权威性模型评分、逐条主张抽取、自动补研、来源浏览器或进度成本重构。GPTR 原生 curator 的内部评分不冒充平台确定性指标。

## 验收与回滚

- `standard/deep` 请求可观察到策展开关，`synthesis` 无策展和搜索；
- 同一输入的质量评估可重复得到相同结果；
- AO 内容通过但证据不足时仍交付报告，状态为有警告；
- 前端不会把证据警告显示成内容验收失败；
- 新字段均可选，旧 SQLite 快照可继续读取；回滚时关闭能力默认值并忽略新增快照字段即可。
