# Evidence Bundle V1

TT-005 在不修改 AO 或 GPTR 上游源码的前提下，把每次专家研究变成可归属、可持久化、可复用的证据单元。

## 数据流

1. `ao-runtime.ts` 仅向内存工作流副本注入 `aoStepId` 和 `dependsOn`。
2. Python 适配器通过 GPTR 公开方法采集查询、来源、网页摘要、研究上下文和抓取器，返回 `researchEvidence`。
3. `GptrConnector` 将 AO 身份、Research Profile、时间、报告和 `researchEvidence` 交给任务级 `EvidenceLedger`。
4. ledger 生成版本化 `EvidenceBundle`，runner 发出一次摘要事件，TaskManager 将完整 bundle 写入任务快照。
5. `synthesis` 只接收声明依赖步骤的 bundle；GPTR 仅调用 `write_report(ext_context=...)`，不重新检索。
6. 最终引用允许列表只来自 `ledger.publicSources()`。

`method.sourceCurationRequested` 记录本轮是否请求 GPTR 原生来源策展。它只表示配置意图；GPTR 策展异常会回退原始来源，因此不能将该字段解释为“所有来源已成功评级”。
公开来源的 `sourceType` 区分 `web` 与 `specified_url`。指定来源使用安全物化后的 canonical URL；发生公共重定向时不会保留未经访问的初始 URL 作为最终引用。

## 不变量

- `aoStepId + researchRunId` 唯一标识一次研究产物。
- 同一步骤返工新增 revision，并保留旧运行；下游优先选择 AO 实际渲染的报告版本。
- 单来源摘要最多 1,000 字符，单次研究上下文最多 20,000 字符，综合上下文最多 120,000 字符。
- 私有来源只有 `locator`，类型上不存在 URL，不能进入公开引用列表。
- GPTR 失败不生成 bundle；后续 AO 步骤失败不删除已完成 bundle。
- 事件表只保存步骤、运行、模式、修订及数量摘要，不复制报告或上下文。

## 兼容与回滚

`ResearchTaskSnapshot.evidenceBundles` 和 `ResearchResponse.researchEvidence` 均为兼容性可选字段。旧 SQLite 快照无需迁移；旧研究服务响应可暂时通过 `sourceUrls/sources` 构造降级证据。删除 ledger 的读取链路即可回退，已有 JSON 不影响旧代码。
