# TT-005 步骤级 EvidenceBundle 实施 Plan

## 状态

已完成实现与自动化验证。

## 目标

在不修改 Agency Orchestrator（AO）和 GPT Researcher（GPTR）上游源码的前提下，为每次 AO 研究步骤建立可审计的 `EvidenceBundle`，并满足：

- 证据能准确归属到 AO 步骤和 GPTR 运行；
- 查询、来源、上下文、研究方式、时间和报告产物可追溯；
- 下游 `synthesis` 能复用依赖步骤的结构化证据；
- 最终编号引用只认可证据包中的公开来源；
- 已完成步骤的证据随任务即时持久化，任务后续失败也不丢失；
- 私有来源在类型和引用转换两层均不会变成公开 URL。

## 现状证据与约束

- AO 0.12.1 会把 `step.llm.params` 原样合并进 connector 的 `LLMConfig`，因此可在运行时工作流副本中注入步骤元数据，无需修改 AO 源码。
- GPTR 0.16.0 已公开 `get_research_sources()`、`get_research_context()`、`get_source_urls()` 和 `get_costs()`；标准研究还会通过 `subqueries` 事件输出查询，深研进度包含 `currentQuery`。
- 当前 Node 只把所有 GPTR 来源扁平合并到全局 `observedSources`，已经丢失步骤、查询、上下文和研究方式。
- 当前 SQLite 任务表保存 `snapshot_json`，可以兼容新增可选字段；不需要数据库迁移或新增表。
- 当前任务快照同时是 API 返回模型。V1 只开放 Web 公共来源；本地文档权限与内容脱敏留给 TT-011。

## 第一性原理决策

证据的本质不是“报告中的链接”，而是一次研究运行产生的、带来源边界的结构化事实材料。因此：

1. Python 适配器在最接近 GPTR 的位置把不稳定的上游对象归一化；
2. Node 在最接近 AO 的位置补齐步骤身份、依赖关系和报告版本；
3. 一个任务级 `EvidenceLedger` 作为唯一证据入口，调用方不再直接理解 GPTR 的 `unknown[]`；
4. 引用、综合和持久化都读取同一份 ledger，避免三套来源逻辑漂移；
5. 不引入独立证据数据库、消息队列、前端证据浏览器或质量评分，这些不是 TT-005 的核心问题。

## 领域结构

新增版本化结构，字段名以实现时的 TypeScript 契约为准：

```ts
interface EvidenceBundle {
  schemaVersion: 1;
  aoStepId: string;
  researchRunId: string;
  attempt: number;
  mode: "standard" | "deep" | "synthesis";
  startedAt: string;
  completedAt: string;
  derivedFromStepIds: string[];
  queries: EvidenceQuery[];
  sources: EvidenceSource[];
  researchContext: {
    content: string;
    originalCharacters: number;
    truncated: boolean;
  };
  method: {
    sourceMode: ResearchSourceMode;
    retrievers: ResearchRetriever[];
    scraper?: string;
  };
  report: {
    format: "markdown";
    content: string;
    revision: number;
    supersedesResearchRunId?: string;
  };
  cost: number | Record<string, unknown> | null;
}
```

`EvidenceSource` 使用可辨识联合类型：

```ts
type EvidenceSource =
  | {
      id: string;
      visibility: "public";
      url: string;
      title: string;
      summary?: string;
      observedAt: string;
    }
  | {
      id: string;
      visibility: "private";
      locator: string;
      title: string;
      summary?: string;
      observedAt: string;
    };
```

私有来源类型不存在 `url` 字段，从结构上阻止误生成公开链接。Web V1 只产生 `public` 来源，但必须用合成私有 fixture 锁定该不变量。

## 模块与数据流

### 1. AO 步骤身份

`ao-runtime.ts` 只修改内存中的运行副本，为普通步骤注入保留参数：

```text
think_tank_runtime = {
  aoStepId,
  dependsOn
}
```

该字段不写回 AO YAML。`GptrConnector` 从配置中读取它并加入 `ResearchInvocation`。AO acceptance 核验仍由 verifier 路由；自动返工沿用原步骤 ID，并产生下一版报告产物。

### 2. GPTR 证据采集

Python 侧新增小型归一化模块，使用 GPTR 公开数据：

- 标准查询：`subqueries` 事件中的结构化 `output`；
- 深研查询：`deep_research.progress.currentQuery`；
- 来源：`get_research_sources()` 与 `get_source_urls()`；
- 上下文：`get_research_context()`；
- 检索器：请求 Profile；
- 抓取器：GPTR 当前有效配置，无法确认时省略；
- 时间：适配器实际开始、完成时间。

来源 `summary` 是对 `raw_content/content/snippet` 的确定性清理与限长摘录，不调用模型重新摘要，也不伪造作者、发布日期或抓取器。上下文和单来源摘要均设固定字符上限并记录截断状态，避免 SQLite 快照、API 响应和 synthesis prompt 无界膨胀。

Python `ResearchResponse` 增加稳定的 `researchEvidence` DTO。现有 `sourceUrls/sources` 暂保留为兼容字段，但 Node 的引用与持久化不再以它们为权威输入。

### 3. 任务级 EvidenceLedger

新增 `evidence-bundle.ts`，实现一个深模块，主要接口为：

```text
record(invocation, response) -> EvidenceBundle
forSynthesis(dependencyStepIds) -> EvidenceBundle[]
publicSources() -> ObservedSource[]
snapshot() -> EvidenceBundle[]
```

实现内部负责 URL 规范化、按运行和步骤去重、查询去重、报告修订号、依赖选择、公开来源投影及有界 synthesis 上下文。调用方不直接处理原始 GPTR 来源结构。

同一步骤发生 acceptance 返工时：

- 保留原研究运行及其来源；
- 新增 `synthesis` 版本，`revision + 1`；
- `supersedesResearchRunId` 指向上一报告；
- 下游读取最新报告版本，但来源允许列表保留该步骤历次真实检索来源。

### 4. 下游综合复用

运行时元数据中的 `dependsOn` 决定 synthesis 可读取哪些证据包。`GptrConnector` 只传递这些依赖步骤的 bundle，不允许综合步骤看到无关并行分支。

Python synthesis 继续调用 GPTR 原生 `write_report(ext_context=...)`，但外部上下文增加结构化证据清单：最新上游报告、公开来源、摘要和有界研究上下文。它仍禁止 `conduct_research()`。保留当前 AO 已渲染任务文本以降低行为回归风险，后续是否改成纯 EvidenceBundle 综合由 TT-018 单独评估。

### 5. 持久化与事件

`ResearchTaskSnapshot` 新增可选 `evidenceBundles`，旧快照缺失时视为 `[]`。每次 GPTR 成功完成后：

1. ledger 生成 bundle；
2. runner 发出一次 `evidence.bundle.recorded`；
3. TaskManager 将完整 bundle 原子追加到 `snapshot_json`；
4. 事件表只保存步骤 ID、运行 ID、模式、来源数和修订号，不复制报告与上下文。

这样即使后续步骤失败，已经完成的研究证据仍可诊断；但不提供服务重启后的续跑，检查点恢复属于 TT-014。

### 6. 最终引用

删除 runner 的任务级 `observedSources` 累加器。最终报告交给 `normalizeFinalCitations()` 前，仅从 `ledger.publicSources()` 构造允许列表：

- 只有公开 EvidenceSource URL 可转成正文 `[\[n\]](url)` 和“参考来源”条目；
- 私有来源没有 URL，无法进入允许列表；
- 报告中不在 bundle 的普通链接可以保留为普通链接，但不计作已验证引用，并继续产生未知来源警告；
- synthesis 自身即使没有新来源，也能使用其依赖 bundle 的来源完成引用校验。

## TDD 实施顺序

1. **领域契约测试**：先覆盖公开/私有来源联合类型、版本、字符上限、URL 规范化、查询去重和报告修订。
2. **GPTR 采集测试**：用 fake researcher 验证标准查询、深研查询、来源摘要、上下文截断、抓取器缺失和 synthesis 空查询。
3. **AO 元数据测试**：证明步骤 ID/依赖只注入运行副本，YAML 不变，connector 能稳定读取。
4. **Ledger 测试**：覆盖并行步骤、同一步骤返工、最新报告选择、来源保留和无关依赖隔离。
5. **综合契约测试**：证明 synthesis 接收到依赖 bundle、复用结构化上下文且绝不检索。
6. **引用测试**：最终引用只接受公开 bundle 来源；未知 URL 和私有 locator 都不能进入参考来源。
7. **任务持久化测试**：内存与 SQLite 均能逐步追加、重载 bundle；旧快照无字段仍能读取。
8. **失败路径测试**：后续 AO 步骤失败时已完成 bundle 仍保留；GPTR 失败不生成半成品 bundle。
9. **跨层验收测试**：fake GPTR 来源从 Python 响应进入 AO 步骤、任务快照、synthesis 和最终编号引用。
10. **全量回归**：Node 测试、typecheck、build、Python Pytest、acceptance，以及 Windows 人工研究任务。

## 预计文件

新增：

- `apps/orchestrator/src/evidence-bundle.ts`
- `apps/orchestrator/test/evidence-bundle.test.ts`
- `services/researcher/app/evidence_capture.py`
- `services/researcher/test/test_evidence_capture.py`

修改：

- `ao-runtime.ts`、`contracts.ts`、`gptr-connector.ts`、`runtime-connector.ts`；
- `research-runner.ts`、`research-tasks.ts`、`citations.ts`；
- Python `contracts.py`、`research_worker.py` 及相关契约测试；
- `docs/architecture/`、TODO 和 acceptance fixtures。

不修改 `node_modules/agency-orchestrator`、`.venv/site-packages/gpt_researcher` 或现有 SQLite 表结构。

## 验收标准

- 每个成功 GPTR 研究运行都能定位到唯一 `aoStepId + researchRunId`。
- 标准与深研 bundle 至少记录实际捕获到的查询、公开来源、研究方法、时间和报告；缺失的上游元数据不会被猜测。
- synthesis 只读取声明依赖步骤的证据，且没有检索/抓取事件。
- acceptance 返工形成报告新版本，不覆盖原始证据。
- 最终编号引用及参考来源全部来自公开 EvidenceSource。
- 私有来源 fixture 不产生 `http(s)` 链接，也不进入 `VerifiedCitation`。
- bundle 在步骤完成时写入任务快照，服务重载后仍可读取；旧任务兼容。
- bundle 和事件中不含 API key、base URL、完整专家 system prompt 或无限长网页原文。
- 现有前端、导出、引用格式和任务状态不回归。
- 全量自动化验证通过，且不依赖 Windows 专用业务逻辑。

## 非目标

- 不做来源策展、覆盖率或域名多样性评分（TT-006）。
- 不重构全部进度和成本事件（TT-007）。
- 不增加 URL、文档、MCP 或混合来源（TT-008 至 TT-012）。
- 不实现暂停、续跑或检查点恢复（TT-014）。
- 不接入 DetailedReport 或图片证据（TT-018、TT-019）。
- 不增加前端证据浏览器；V1 先把后端证据闭环做正确。

## 回滚

`EvidenceBundle` 是任务 JSON 的可选字段，不需要数据库回滚。若新链路异常，可恢复为旧的 `sourceUrls/sources` 引用收集；已有 bundle 会作为未读取的 JSON 保留。Python 响应兼容字段在 TT-005 期间不删除，便于服务独立回滚。
