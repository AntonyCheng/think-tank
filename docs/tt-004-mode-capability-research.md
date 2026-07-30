# TT-004 执行模式能力核查

核查日期：2026-07-29  
锁定基线：Agency Orchestrator（AO）`0.12.1`、GPT Researcher（GPTR）`0.16.0`

## 结论

TT-004 可以在不修改两个上游项目源码的前提下实现，但三种模式不是三个同构的 GPTR `report_type`：

| 平台模式 | 稳定执行路径 | 结论 |
| --- | --- | --- |
| `standard` | `GPTResearcher(report_type="custom_report")` → `conduct_research()` → `write_report()` | 维持现状，接口稳定 |
| `deep` | `GPTResearcher(report_type="deep")` → `conduct_research()` → `write_report()` | 使用 GPTR 原生递归深研；参数通过请求隔离 worker 的环境配置注入 |
| `synthesis` | `GPTResearcher(report_type="custom_report")` → **跳过** `conduct_research()` → `write_report(ext_context=上游产出)` | 可做到不重复搜索；`ext_context` 是公开 Python 方法参数，但官方文档未承诺，必须有兼容性测试 |

`detailed_report` 是另一套长报告/子主题编排能力，不等于 `deep`，应继续留给 TT-018。

## GPTR 0.16.0 的真实接口

版本由 `.venv/Lib/site-packages/gpt_researcher-0.16.0.dist-info/METADATA` 确认。

- `ReportType.DeepResearch = "deep"`，构造器仅在该值下创建 `DeepResearchSkill`；`conduct_research()` 随后走独立深研分支。证据：`.venv/Lib/site-packages/gpt_researcher/utils/enum.py:6-27`、`gpt_researcher/agent.py:191-193,331-353`。
- 标准公共流程仍是构造 `GPTResearcher`、调用 `conduct_research()`、再调用 `write_report()`；这也与[官方 PIP 示例](https://github.com/assafelovic/gpt-researcher#run-as-pip-package)一致。
- `write_report(existing_headers, relevant_written_contents, ext_context, custom_prompt)` 会把非空 `ext_context` 直接交给报告生成器；因此可以只写报告而不检索。证据：`gpt_researcher/agent.py:451-492`、`gpt_researcher/skills/writer.py:49-88`。
- GPTR 官方深研文档也明确使用 `report_type="deep"`，并描述了递归树、并行路径和 `on_progress` 回调：[Deep Research](https://docs.gptr.dev/docs/gpt-researcher/gptr/deep_research)。

### breadth / depth / concurrency

锁定版本从以下环境变量或 config 文件读取整数：

- `DEEP_RESEARCH_BREADTH`：每层先生成的搜索分支数；
- `DEEP_RESEARCH_DEPTH`：递归层数；
- `DEEP_RESEARCH_CONCURRENCY`：**单个深研实例、当前递归调用内**同时处理查询的 semaphore 上限。

证据：`gpt_researcher/config/variables/base.py:37-39`、`default.py:38-41`、`config.py:62-75`、`skills/deep_research.py:244-249,377-485`；官方配置说明见 [Configuration](https://docs.gptr.dev/docs/gpt-researcher/gptr/config#deep-research-configuration)。

锁定源码默认值为 `breadth=3`、`depth=2`、`concurrency=4`。深研专题页仍写 breadth 默认 4，和 0.16.0 源码/配置页不一致，因此实现必须以锁定源码为准。

源码不是简单做 `breadth × depth` 次研究。成功分支会逐个递归，下一层 breadth 为 `max(2, floor(breadth / 2))`。若每次都生成足量查询且全部成功，嵌套标准研究调用数近似：

```text
N(b, 1) = b
N(b, d) = b × (1 + N(max(2, floor(b / 2)), d - 1))
```

因此默认 `3/2` 约为 9 次，而当前平台契约允许的 `10/5` 最坏约为 760 次。`breadth=1` 在第二层还会被抬到 2。证据：`skills/deep_research.py:401-485,530-559`。上游没有对这些参数做范围校验，平台现有 `1..10 / 1..5 / 1..16` 只是契约范围，不能直接当作安全运行范围。

深研每个子查询会新建一个 `report_type="research_report"` 的 `GPTResearcher`；它没有继承 AO 外层的 `agent/role`。因此 AO 专家身份能控制原始问题和最终写作，但不能保证每个递归分支都使用同一 AO `systemPrompt`。这是原生深研的稳定边界，第一版不应靠 monkey patch 改写。证据：`skills/deep_research.py:432-448`。

单分支失败会被跳过；所有分支失败时停止下钻并返回空证据，写作层会输出无法形成可靠报告的保守说明。证据：`skills/deep_research.py:476-511`、`skills/writer.py:79-88`。

## synthesis 的边界

AO 会先把依赖步骤的输出写入上下文，再用 `renderTemplate()` 生成综合步骤的最终任务文本；所以平台已能把上游报告作为 `ext_context` 交给 GPTR，无需 AO 新接口。证据：`node_modules/agency-orchestrator/dist/core/executor.js:121-139,353-367`。

第一版 synthesis 应满足：

1. 只能用于有上游依赖的普通步骤，且传入的渲染后任务必须含非空上游内容；
2. 不调用 `conduct_research()`，不得访问检索器；
3. 使用聚合步骤的 AO 完整 `systemPrompt` 和 GPTR `custom_report` 写作；
4. 独立 synthesis 响应可以没有 `sourceUrls`；当前 `research-runner.ts:180-239` 已跨所有先行 GPTR 调用聚合来源，最终引用仍能按上游已观察来源校验；
5. 由于 `ext_context` 未出现在官方 PIP 文档中，升级 GPTR 时必须用适配器契约测试证明“未调用搜索、正文来自外部上下文”。

在 TT-005 的 `EvidenceBundle` 完成前，synthesis 的证据载体只能是 AO 渲染后的文本；这能避免重复搜索，但还不是结构化证据复用。

## AO 0.12.1 可利用的控制面

版本由 `node_modules/agency-orchestrator/package.json` 确认。

- `step.llm.params` 是原生扩展点，TT-003 已用 `think_tank.mode` 选择步骤模式；无需修改 AO。
- `depends_on` 构建拓扑层，同层步骤可并行；`executeDAG()` 按顶层 `concurrency` 分批并用 `Promise.allSettled()` 执行。证据：`node_modules/agency-orchestrator/dist/types.d.ts:1-56`、`dist/core/dag.js:1-69`、`dist/core/executor.js:7-19,78-99`；[AO 官方 README](https://github.com/jnMetaCode/agency-orchestrator#工作原理)也说明 DAG、变量传递与并行。
- 默认依赖失败会跳过下游；`depends_on_mode="any_completed"` 可在至少一个分支可用时继续。TT-004 不应重写这些 AO 语义。
- 当前平台预检要求唯一终端交付步骤，天然适合把该节点设为 synthesis。证据：`apps/orchestrator/src/ao-runtime.ts:134-185`。

## 并发预算判断

目前有三层并发：

1. AO 同层步骤并发；
2. FastAPI 的 `GPTR_WORKER_CONCURRENCY`（当前默认 2）限制同时运行的独立 worker 进程；
3. 每个 deep worker 内的 `DEEP_RESEARCH_CONCURRENCY`。

证据：`apps/orchestrator/src/ao-runtime.ts:230-239`、`services/researcher/app/main.py:216-233`、`research_executor.py:62-130`。

只限制 AO 或 worker 数都不足以控制 deep 内部并发。建议 TT-004 在**任务级 `GptrConnector`** 增加加权 permit 池：

- `standard` / `synthesis` 占 1 个 permit；
- `deep` 申请 `min(requestedConcurrency, taskBudget)` 个 permit，并把实际值随请求传给 Python；
- 同一任务所有活跃 GPTR 调用占用之和不得超过 `taskBudget`；
- 请求超预算时只下调 concurrency 并记录 requested/effective 值，不静默修改 breadth/depth；
- 预计递归调用数超过安全上限时应在执行前拒绝，而不是偷偷改变研究语义；
- permit 等待必须可被任务取消和 GPTR 超时中断。

服务端还应保留 `GPTR_WORKER_CONCURRENCY` 作为跨任务外层硬上限。多个任务的内部深研仍可能相乘，所以部署层需要再设置单次 deep concurrency 硬上限；第一版不承诺跨进程的全局精确 semaphore。

TT-001 的受管环境列表目前只有标准限额，TT-004 必须把三个 `DEEP_RESEARCH_*` 变量加入 `research_executor.py` 的 `MANAGED_ENVIRONMENT`，否则请求级深研参数不能获得同等隔离。

## 稳定实施边界与风险

- **可直接实施：** standard 兼容路径、GPTR 原生 deep、无搜索 synthesis、任务级加权并发预算、请求级深研环境隔离。
- **应显式约束：** deep 第一版仍只支持 Web；synthesis 必须有上游证据；高 breadth/depth 在执行前做工作量门控。
- **质量风险：** GPTR 深研子分支不继承 AO 专家身份；`ext_context` 是源码公开但文档未承诺的兼容 seam；深研部分分支失败可能形成不完整而非失败结果。
- **性能风险：** 递归调用数呈树形增长；降低 concurrency 只能降低瞬时负载，不能降低总调用数。
- **后续归属：** 结构化证据复用交给 TT-005，确定性质量判断交给 TT-006，深研层级进度交给 TT-007，`DetailedReport` 交给 TT-018。

## 建议的 TT-004 验收焦点

1. 不带新配置的任务仍严格走现有 standard 路径。
2. deep 的 report type 和三个实际配置值与 Profile 一致，且两个并发请求互不污染。
3. synthesis 通过搜索探针证明零检索，并只根据非空上游文本写报告。
4. 同一 AO 层多个 deep 步骤的实际 permit 总和不超过任务预算；超额 concurrency 被可观测地下调。
5. 高风险 breadth/depth 在任何 GPTR 构造前被拒绝。
6. AO 自动验收返工不应再次触发完整 deep 搜索；在 TT-015 定向补研完成前，返工应转为 synthesis 型重写。
7. GPTR 0.16.0 适配器契约测试固定 `deep` 分流和 `write_report(ext_context=...)` 两个关键 seam。
