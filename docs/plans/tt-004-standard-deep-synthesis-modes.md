# TT-004 标准、深研、综合三种执行模式实施 Plan

## 状态

已完成实施与自动化验证（2026-07-29）。

实现保持了既有适配器边界：模式分派直接位于 `research_worker.py`，没有为三处分支额外拆出只含转发逻辑的 `research_modes.py`。预算可观测性只记录模式选择、真实排队和并发调整；正常获取/释放不制造额外时间线噪声，完整资源度量留给 TT-007。

## 目标

在不修改 Agency Orchestrator（AO）或 GPT Researcher（GPTR）上游源码的前提下，让 `ResearchProfile.mode` 的三种取值进入真实执行路径：

- `standard`：保持现有 Web 研究和报告行为。
- `deep`：使用 GPTR 0.16.0 原生递归深研，并应用受控的 breadth、depth、concurrency。
- `synthesis`：只复用 AO 上游步骤已经产生的材料写报告，不再次搜索网页。

同时建立任务级总并发预算，避免 AO 步骤并行与 GPTR 深研内部并行相乘。

## 现状证据

- TT-003 已打通“任务 Profile < AO 步骤覆盖 < Python worker”的完整链路，但 Node 和 Python 的能力门控仍只开放 `standard + web`。
- AO 0.12.1 按 DAG 层并行执行步骤，`concurrency` 只限制 AO 层，并不知道 GPTR 单次调用内部还会产生多少并行研究分支。[AO executor](../../node_modules/agency-orchestrator/dist/core/executor.js)
- GPTR 0.16.0 在 `report_type="deep"` 时走 `DeepResearchSkill`；其 breadth、depth、concurrency 分别由 `DEEP_RESEARCH_BREADTH`、`DEEP_RESEARCH_DEPTH`、`DEEP_RESEARCH_CONCURRENCY` 控制，并支持 `on_progress`。[GPTR Deep Research 官方文档](https://docs.gptr.dev/docs/gpt-researcher/gptr/deep_research)
- GPTR 的可调用 `write_report(..., ext_context=...)` 可使用外部上下文代替内部研究上下文。因此综合模式可以跳过 `conduct_research()`，不需要复制 GPTR 写作逻辑。该参数存在于 0.16.0 公共 Python 方法签名中，但官方 PIP 文档未承诺其兼容性，必须由适配器契约测试锁定。[已安装 GPTR agent.py](../../.venv/Lib/site-packages/gpt_researcher/agent.py)
- 当前每次 GPTR 调用已经在独立 spawn worker 中执行，适合继续通过请求级环境快照传递深研参数。

## 核心决策

### 模式语义

| 模式 | GPTR 路径 | 是否检索 | 上下文来源 |
|---|---|---:|---|
| `standard` | `custom_report` → `conduct_research()` → `write_report()` | 是 | 本轮 Web 研究 |
| `deep` | `deep` → `conduct_research(on_progress)` → `write_report()` | 是 | 递归研究树聚合结果 |
| `synthesis` | `custom_report` → `write_report(ext_context=...)` | 否 | AO 已渲染的上游步骤输出 |

不把 `detailed_report` 混入 TT-004。它会自行拆分子主题并再次研究，留到 TT-018 单独评估。

### 综合模式是步骤级能力

`synthesis` 只能用于普通 AO 步骤，并必须满足：

1. 存在至少一个 `depends_on`；
2. `task` 至少引用一个依赖步骤的 `output` 变量；
3. 引用的变量确实来自其 DAG 上游。

任务顶层 Profile 不接受 `synthesis`，因为根步骤没有可复用材料。AO 可以在 `step.llm.params.think_tank.mode` 中显式声明；若 AO 省略 mode，平台会把满足上述约束且位于 DAG 终点的聚合步骤归一化为 synthesis。显式声明的 standard/deep 不会被覆盖。编排提示词会要求 AO 只把 synthesis 用于汇总、对比、审查或最终报告步骤。预检不满足时沿用现有的一次自动重新编排，仍不合法才终止，且不会调用 GPTR。

AO acceptance 触发的一次自动返工属于例外：它已经携带上一版完整产出和未满足条目，因此运行时把返工调用临时降为 synthesis，只重写、不重新检索。若问题确实是证据不足，第二次验收仍按现有 `completed_with_warning` 语义交付；TT-015 再负责有边界的定向补研。

### AO 专家身份边界

三种模式都继续向 GPTR 根实例传入 AO 加载出的完整 `systemPrompt`，并把专家约束放入研究 query。GPTR 0.16.0 的深研内部会创建自己的子研究实例，当前没有公开钩子把 AO `role` 逐个注入这些内部实例；不使用 monkey patch 或复制 `DeepResearchSkill`。根查询规划和最终写作仍受 AO 专家约束，AO acceptance 继续负责输出验收。该上游限制需要记录在架构文档和测试说明中。

## 并发与资源策略

新增任务级加权并发预算，生命周期与单次 `runResearchTopic()` 相同：

- `standard`、`synthesis` 权重为 `1`；
- `deep` 权重为实际 `deep.concurrency`；
- AO 同时发起多个步骤时，所有权重之和不得超过 `GPTR_TASK_CONCURRENCY_BUDGET`；
- 等待预算不消耗单次 GPTR 请求超时，但仍受任务总超时和取消信号控制；
- 请求结束、失败或取消都必须在 `finally` 中释放预算。

默认任务预算为 `4`。若深研请求的 concurrency 高于预算，只降低实际 concurrency，不改变 breadth/depth，并产生可观测警告；请求 Profile 与实际执行 Profile 都要记录。breadth/depth 超过部署安全上限时不静默修改，而是在研究开始前返回稳定错误。

降低 concurrency 只控制瞬时负载，不能减少递归总工作量。按 GPTR 0.16.0 的递归规则预估嵌套标准研究调用数：

```text
N(b, 1) = b
N(b, d) = b × (1 + N(max(2, floor(b / 2)), d - 1))
```

当前 Profile 合法上限 `10/5` 最坏约产生 760 次子研究，不能直接开放。执行前同时检查 breadth、depth 和预计调用数；任一超过部署上限都拒绝，不通过静默削减研究树改变语义。

Python 端现有 `GPTR_WORKER_CONCURRENCY` 继续作为跨任务、跨请求的第二道全局进程上限。两层含义不同：

- Node：限制单个 AO 任务内部的理论并行研究操作；
- Python：限制整个 researcher 服务同时运行的顶层 worker 数。

## 接口与事件变化

### 配置

新增环境项：

```dotenv
GPTR_TASK_CONCURRENCY_BUDGET=4
GPTR_DEEP_MAX_BREADTH=4
GPTR_DEEP_MAX_DEPTH=3
GPTR_DEEP_MAX_RESEARCH_CALLS=32
```

`deep.concurrency` 的有效上限同时受 Profile V1 硬上限、任务预算和 GPTR worker 能力约束。环境项只属于部署策略，不进入 `ResearchProfile`，也不允许 AO 修改。

### 运行调用

- `ResearchInvocation` 同时保留 requested/effective Profile、预算权重和降级原因。
- Python `MANAGED_ENVIRONMENT` 增加三个 `DEEP_RESEARCH_*` 字段。
- `research_worker.py` 按模式选择执行器；synthesis 把已渲染的 `request.task` 作为外部上下文，并在上下文为空时拒绝写作。
- `RoutingConnector` 在识别 AO acceptance 返工块后，仅对本次调用构造临时 synthesis Profile；工作流原始 Profile 和首次研究快照不被改写。
- synthesis 返回的本轮 `sourceUrls/sources` 可以为空；最终引用仍只能通过 Node 已收集的上游 `observedSources` 校验。

### 可观测性

沿用现有事件结构，新增稳定阶段：

- `research.mode.selected`：requested/effective mode 与执行参数；
- `research.budget.waiting/acquired/adjusted/released`；
- `deep_research_initialize/progress/complete`；
- `synthesis.started/completed`。

前端本项只需能显示已有本地化时间线；深度/广度的专用可视化和完整成本模型留到 TT-007。

## 范围与非目标

本项实现：

- 三种模式的真实 Node → Python → GPTR 映射；
- synthesis 的 DAG 上游约束和无检索保证；
- 深研参数的 worker 隔离；
- 任务级加权预算、取消与降级事件；
- 契约、失败路径和跨层测试；
- `.env.example`、Profile 架构文档和 TODO 同步。

本项不：

- 增加前端模式设置控件；
- 实现 EvidenceBundle、来源策展或新的来源类型；
- 接入 GPTR DetailedReport 或多代理框架；
- 根据 acceptance 缺口做新的检索型定向补研；
- 修改 AO/GPTR 源码或依赖内部 monkey patch；
- 承诺深研耗时、模型调用数或固定报告篇幅。

## 预计文件

新增：

- `apps/orchestrator/src/research-concurrency-budget.ts`
- `apps/orchestrator/test/research-concurrency-budget.test.ts`
- `services/researcher/app/research_modes.py`
- 对应 Python 模式测试。

修改：

- `research-profile-runtime.ts`、`research-profile-mapping.ts`、`research-compose.ts`；
- `settings.ts`、`runtime-connector.ts`、`routing-connector.ts`、`gptr-connector.ts`、`research-runner.ts`；
- Python `research_policy.py`、`research_executor.py`、`research_worker.py`；
- Node/Python 契约与现有测试；
- `.env.example`、`docs/architecture/research-profile-v1.md` 和 TODO。

不新增数据库字段；模式、请求 Profile 和有效 Profile继续保存在任务 JSON/事件快照中。

## TDD 实施顺序

1. **能力门控测试**：先让 Node/Python fixtures 证明 `standard/deep/synthesis` 均可解析；高于部署 breadth/depth 或递归调用数上限时稳定失败。
2. **综合步骤预检测试**：覆盖无依赖、无变量引用、引用非上游变量、合法多上游综合，以及非法工作流在任何 GPTR 调用前失败。
3. **Python 模式路由测试**：用 fake `GPTResearcher` 证明 standard/deep 调用研究后写作，synthesis 只调用 `write_report(ext_context)`，绝不调用 `conduct_research`。
4. **深研环境隔离测试**：两个并发请求使用不同 breadth/depth/concurrency，验证独立 spawn worker 读取各自值且父进程环境不变。
5. **加权预算单元测试**：覆盖公平排队、权重累加、超预算降级、释放、异常和 AbortSignal 取消。
6. **AO × GPTR 并发契约测试**：AO 并发专家包含 standard/deep 混合时，观察到的有效权重从不超过任务预算；Python worker 上限仍生效。
7. **事件与快照测试**：requested/effective Profile、降级原因可追溯，不包含密钥、base URL 或完整 system prompt。
8. **验收返工测试**：首次 standard/deep 研究后，AO 自动返工只调用 synthesis 写作；若仍缺证据则保留质量警告，不触发第二棵研究树。
9. **回归测试**：旧 `{topic}` 请求继续走 standard；现有引用、流式事件和导出行为不变。
10. **人工验收**：同一主题分别运行 standard/deep，确认 deep 有递归进度和更多研究分支；再运行一个多专家 + synthesis 工作流，确认综合步骤无检索事件且引用可由上游来源校验。

## 验收标准

- 不带 Profile 的现有任务与 TT-003 行为一致。
- `deep` 的实际 GPTR report type 和三个参数与有效 Profile 一致。
- `synthesis` 有上游材料时可交付完整报告，且 spy/事件均证明没有检索或抓取。
- 无上游材料的 synthesis 在执行前失败，不生成看似可信的报告。
- AO 验收返工不重复执行 standard/deep 检索；证据不足时不伪造补充事实。
- 任意时刻单任务权重不超过预算；并发过高时可排队或降低内部 concurrency，不拖垮服务。
- 超过递归调用数门槛的 Profile 在任何 GPTR 构造前失败。
- 取消等待或运行中的任务不会泄漏预算许可或残留 worker。
- 深研单个分支失败可沿用 GPTR 原生跳过语义；全部无证据时不得伪造报告。
- Node 全量测试、typecheck、build、Python 全量 Pytest 和 acceptance 全部通过。
- Windows 完成一次人工验收；Linux/macOS 的纯契约与 worker 测试不依赖平台专用命令。

## 回滚

保留 `standard` 作为默认且独立路径。若 deep 或 synthesis 上线后不稳定，可只把运行能力门控恢复为 `["standard"]`，无需迁移任务数据库；旧任务中的 mode 字段仍是普通 JSON。删除新增部署环境项后使用代码默认值。加权预算模块即使保留也不会改变串行 standard 调用的结果。

## 实施后的下一步

TT-004 验收通过后进入 TT-005：把各步骤的查询、来源、研究上下文和产物保存为结构化 `EvidenceBundle`。届时 synthesis 将从“复用已渲染的上游文本”升级为“复用可审计的上游证据包”。
