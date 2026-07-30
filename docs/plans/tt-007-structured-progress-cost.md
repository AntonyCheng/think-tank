# TT-007 结构化研究进度与成本实施 Plan

## 状态

已实施，自动化验收通过；待运行 standard/deep 实例完成人工验收。

## 目标

在不修改 AO、GPTR 上游源码的前提下，把现有原始事件归并为稳定、可持久化的研究运行视图：

- 每轮研究都能关联任务、AO 步骤和 GPTR 运行；
- 标准、深研、综合模式使用同一套用户级阶段；
- 深研展示原生层级、当前分支和查询进度；
- 展示分步骤耗时、来源数及 GPTR 报告的成本估算；
- 原始事件保留用于诊断，但不再生成数百个前端时间点。

## 现状证据

- `ResearchTaskEvent` 已在外层携带 `taskId`，但 `gptr.progress` 和 `gptr.completed` 缺少 `aoStepId`、耗时及结构化进度。
- `ResearchInvocation` 已有 `id`、`aoStepId`、`startedAt` 和并发等待信息，这些数据目前未进入任务快照。
- Python 适配器已转发 GPTR 0.16.0 的 `cost`，并为深研输出层级、广度及查询字段。
- GPTR `get_costs()` 返回累计美元数值，但它是 GPTR 的估算，不是模型供应商账单；私有或未知定价模型可能报告 `0`。
- GPTR 深研回调描述递归节点的局部进度，不能可靠推导全任务精确百分比。
- 前端当前按 `researchId + stage` 创建节点，阶段种类和原始事件增多时仍会膨胀。

## 第一性原理决策

1. **任务、步骤、研究运行是三个身份层级。** `taskId` 由事件外层提供，数据内只保存 `aoStepId` 与 `researchRunId`，避免重复身份不一致。
2. **进度是状态，不是日志。** 前端每个 `researchRunId` 只维护一个研究节点；阶段变化更新节点，不追加文本流。
3. **不伪造总体百分比。** 标准/综合模式显示不定进度；深研只显示可证实的“当前层级、当前分支、完成查询/本分支查询”。
4. **成本必须标明来源和覆盖率。** 数值 `0` 是有效的 GPTR 报告值；`null`、非法对象或缺失值显示“未提供”。任务总成本只汇总有值的运行，同时显示覆盖运行数。
5. **耗时区分等待与执行。** `queueWaitMs` 表示并发预算等待，`elapsedMs` 表示实际研究运行时间；并行运行的分步骤耗时不能冒充任务墙钟耗时。
6. **诊断事件与用户事件分流。** 原始事件保存为受限、脱敏的诊断记录，不进入 SSE 和前端事件计数；用户事件经过归并、去重后才持久化和广播。

## 模块与接口

新增 `research-telemetry.ts` 深模块，复杂的阶段映射、去重、耗时、来源和成本规范化均隐藏在其实现中。调用方只使用三个接口：

```ts
tracker.observe(rawEvent, invocation): TelemetryUpdate
tracker.complete(completion, invocation): TelemetryUpdate
tracker.fail(failure, invocation): TelemetryUpdate
```

`TelemetryUpdate` 返回：

- 可选的 `publicEvent`：只有阶段或有意义计数发生变化时存在；
- 一条受限的 `diagnosticRecord`；
- 当前 `ResearchTelemetrySnapshot`。

失败/取消路径使用同一模块的 `fail(...)` 收口，不把错误文本直接当阶段。

## 公共数据契约

```ts
type ResearchPhase =
  | "preparing"
  | "planning"
  | "searching"
  | "collecting"
  | "analyzing"
  | "writing"
  | "finalizing"
  | "completed"
  | "failed"
  | "canceled";

interface ResearchRunProgress {
  schemaVersion: 1;
  aoStepId: string;
  researchRunId: string;
  mode: "standard" | "deep" | "synthesis";
  state: "queued" | "running" | "completed" | "failed" | "canceled";
  phase: ResearchPhase;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  queueWaitMs: number;
  elapsedMs: number;
  sourceCount: number;
  deep?: {
    currentLevel?: number;
    totalLevels?: number;
    completedQueries?: number;
    totalQueries?: number;
    currentBranch?: number;
    totalBranches?: number;
  };
  cost: {
    status: "reported" | "unavailable";
    currency: "USD";
    amount?: number;
    provenance: "gptr";
    estimated: true;
  };
}
```

`ResearchTaskSnapshot` 新增可选 `researchTelemetry`：

```ts
interface ResearchTelemetrySnapshot {
  schemaVersion: 1;
  runs: ResearchRunProgress[];
  summary: {
    runCount: number;
    completedRunCount: number;
    uniqueSourceCount: number;
    reportedCostUsd: number;
    reportedCostRuns: number;
    totalElapsedMs: number;
  };
}
```

公开 SSE 使用 `research.progress`、`research.completed`、`research.failed`。前端保留对旧 `gptr.progress/gptr.completed` 事件的只读兼容，以便重放旧 SQLite 任务；新任务不再发出旧进度事件。

## 阶段归并规则

- 启动、模式选择、身份加载 → `preparing`
- 研究规划、子问题生成 → `planning`
- 搜索、执行子查询 → `searching`
- 抓取、提取网页、收集来源 → `collecting`
- 上下文合并、证据分析、深研递归 → `analyzing`
- 报告生成 → `writing`
- 报告清理、引用规范化 → `finalizing`
- 连接器完成/失败/取消 → 对应终态

未知 GPTR 事件只进入诊断记录，不直接生成新的用户阶段。相同运行、相同阶段、相同结构化计数不重复发事件。

## 深研进度处理

Python 适配器根据配置的根深度，把 GPTR 递归节点的“剩余深度”规范化为绝对 `currentLevel`，同时保留当前节点的查询与分支计数。V1 不计算全局百分比，也不把理论最大分支数当实际工作量。

## 诊断保留策略

- SQLite 增加独立 `research_task_diagnostics` 表，不改变现有公开事件表语义；
- 保存原始类型、原始阶段、时间、两个运行身份及脱敏后的结构化数据；
- 单个字符串最多 4 KiB，单任务最多 2,000 条；超限后以一条汇总记录累计丢弃数量；
- 屏蔽密钥、认证头、完整 system prompt 和运行时提示块；
- V1 不提供浏览器诊断接口，避免把内部 prompt 或大段抓取内容暴露给前端。

## 前端行为

- 一个研究运行对应一个可更新的时间线节点，不再按阶段创建多个节点；
- 节点标题显示“专家步骤 · 当前阶段”，详情显示模式、耗时、来源及深研层级/分支；
- 任务概览新增“研究耗时（累计）”和“模型成本（估算）”；
- 成本部分缺失时显示覆盖情况，例如“$0.0123（2/3 轮有数据）”，完全缺失显示“未提供”；
- 旧事件重放仍按现有方式显示，但不会影响新任务的结构化视图。

## TDD 实施顺序

1. **纯契约测试**：阶段、状态、成本、时间和深研字段的解析边界。
2. **归并测试**：重复日志、长文本、未知阶段不会产生重复公开事件。
3. **深研适配测试**：递归层级转为绝对层级；标准/综合不伪造深研进度。
4. **连接器测试**：所有事件带两个运行身份，完成/失败/取消均有终态和耗时。
5. **并发测试**：并行 AO 步骤的进度、成本和来源互不串线。
6. **持久化测试**：快照可恢复；诊断记录不进入 SSE；旧数据库和旧快照可读。
7. **任务生命周期测试**：公开事件更新 `researchTelemetry`，终态汇总准确。
8. **前端契约测试**：同一运行只创建一个节点，成本缺失和 `0` 正确区分。
9. **回归验收**：Node、Python、typecheck、build、acceptance 全部通过。
10. **人工验收**：各运行一次 standard/deep；确认深研层级、分步骤耗时/成本和时间线数量。

## 预计文件

- 新增 `apps/orchestrator/src/research-telemetry.ts`
- 新增 `apps/orchestrator/test/research-telemetry.test.ts`
- 修改 `gptr-connector.ts`、`research-runner.ts`、`research-tasks.ts`
- 修改 `research-task-store.ts` 及其测试
- 修改 Python `contracts.py`、`research_worker.py` 及相关 Pytest
- 修改 `apps/web/public/index.html`、`app.js`、`styles.css`
- 新增 `docs/architecture/research-telemetry-v1.md`

## 范围与非目标

本项不实现供应商账单对账、token 精确统计、预算强制中止、跨任务成本报表、OpenTelemetry/LangSmith、诊断管理页面或全局精确完成百分比。成本数据只使用 GPTR 已返回的结果，不调用额外模型或计费接口。

## 验收标准

- 每个公开研究事件都能由外层 `taskId`、`aoStepId`、`researchRunId` 唯一定位；
- standard/deep/synthesis 均展示一致的用户级阶段；
- deep 展示可信的层级和本分支查询进度，不显示虚假总体百分比；
- 每个 AO 专家步骤能看到耗时、来源数及成本状态；
- 一轮研究无论产生多少原始日志，前端始终只有一个可更新研究节点；
- 原始诊断事件受限持久化，不通过 SSE、任务快照或网页泄露；
- 旧任务快照、旧公开事件及现有研究结果继续可读。

## 回滚

新增快照字段和数据表均为附加式变更。回滚时停止生成 `research.*` 事件，前端回退旧事件处理，忽略 `researchTelemetry` 和诊断表即可；无需迁移或删除旧任务数据。
