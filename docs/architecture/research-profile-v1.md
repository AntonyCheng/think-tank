# ResearchProfile V1

`ResearchProfile` 是平台拥有的、版本化且不可变的研究策略契约。它位于 AO 编排结果与 GPTR 执行参数之间，避免业务流程依赖 GPTR 的内部配置字段。TypeScript 与 Python 使用同一份 [`cases.json`](../../contracts/research-profile/v1/cases.json) 验证规范化结果及稳定错误。

## 默认行为

缺少 Profile 或传入 `null` 时解析为 `schemaVersion: 1`、`standard`、部署默认的单一 Web 检索器、在部署支持时启用来源策展，以及 `5` 个查询结果、`3` 次迭代、`3` 个子主题。`standard/deep` 默认启用策展，调用方可显式关闭；`synthesis` 不搜索，因此强制关闭且拒绝显式启用。显式字段不会被字符串、`null` 或其他类型强制转换；数组采用整体替换。

## 字段与来源

- `mode`：`standard | deep | synthesis`。`deep` 必须同时提供 `breadth`、`depth`、`concurrency`。
- `source.mode: web`：检索器及可选域名包含/排除列表。
- `source.mode: urls`：1–50 个绝对 HTTP(S) URL，可选 Web 补充策略。
- `source.mode: local`：1–20 个平台文档 ID，不接受文件路径。
- `source.mode: hybrid`：文档 ID 加 URL 或 Web 证据。
- `source.mode: mcp`：1–10 个受管 MCP Profile ID，可选 Web 回退。
- `quality.curateSources`：是否启用来源策展。
- `limits`：每次查询结果 1–20、迭代 1–10、子主题 1–20。
- `deep`：广度 1–10、深度 1–5、并发 1–16。

域名只接受规范化主机名，包含与排除列表不能重叠。URL V1 只验证协议、绝对地址和 2048 字符上限；网络、私网和重定向安全由来源接入阶段负责。

## 解析与能力门控

解析顺序固定为：严格结构校验 → 默认值解析 → 跨字段不变量 → `ResearchCapabilities` 门控 → 深度冻结。结构合法但部署未启用的模式、来源、检索器、域名过滤或来源策展返回 `profile_capability_disabled`，不会静默降级。`synthesis` 是例外：它保留任务 Source Grant 作为证据来源边界，但不执行 Source Policy，因此只校验综合模式本身，不要求 URL、检索器或域名过滤的获取能力。

所有错误包含稳定的 `code`、JSON 风格 `path` 和说明性 `message`。未知字段返回 `profile_unknown_field`；版本、类型、取值和不变量分别使用对应错误码。

`ResearchProfileOverride` 只描述平台、任务或 AO 步骤的部分意图，不能直接执行；必须先经解析器得到完整 Profile。

## 任务与 AO 步骤映射

`POST /api/tasks` 可携带可选 `researchProfile`。API 在提交时按当时配置的检索器解析为完整 Profile，并把 Profile 与 `ResearchCapabilities` 一起写入任务 JSON 快照；排队期间修改部署设置不会改变已提交任务。

AO 普通步骤可在 `step.llm.params.think_tank` 声明部分覆盖，优先级固定为“平台默认值 < 任务配置 < 步骤覆盖”。对象字段逐项合并，数组整体替换，来源模式切换会替换整个来源联合类型。顶层 `llm.params.think_tank`、人工输入步骤和审批步骤均禁止声明。生成后的工作流在研究执行前统一解析；首次非法会触发现有的一次自动重新编排，二次非法才终止。

完整的步骤 Profile 只注入 AO 运行时副本，并随 `workflow.composed` 和 `gptr.completed` 事件记录。Node 到 Python 的请求同时保留兼容 `reportSource/retriever` 字段；Python 在启动 worker 前再次校验两者一致。

当前适配器开放 `standard + web`、`standard + urls`、`standard + urls/web`，并支持 Web 域名包含/排除规则。指定 URL 在研究服务中安全物化为正文证据，URL-only 跳过 `conduct_research()`，URL+Web 先物化再执行一次标准 Web 研究，最后只调用一次 `write_report(ext_context=...)`。`deep` 继续只支持无严格来源约束的 Web 研究；`deep + urls/domain filters` 在执行前返回 `profile_capability_disabled`。`synthesis` 只消费 AO 依赖步骤的 Evidence Bundle；即使继承了 URL 或域名 Source Grant，也不会初始化 URL 读取器、Web 检索器或域名过滤器。

任务 Source Policy 同时是 Source Grant。AO 步骤可以使用 URL 子集、关闭 URL+Web 的 Web 补充、收紧域名包含列表或增加排除范围；不得添加任务外 URL、把 URL-only 改成 Web、启用额外搜索、扩大包含域名或移除排除域名。没有收窄需求时步骤应完整继承任务来源。

三个通用限额映射到独立 worker 的 `MAX_SEARCH_RESULTS_PER_QUERY`、`MAX_ITERATIONS`、`MAX_SUBTOPICS`，来源策展映射到 GPTR 原生 `CURATE_SOURCES`。deep 的广度、深度和并发分别映射到 `DEEP_RESEARCH_BREADTH`、`DEEP_RESEARCH_DEPTH`、`DEEP_RESEARCH_CONCURRENCY`。每个研究调用使用独立子进程环境，参数不会在并发任务之间串扰。

部署通过 `GPTR_DEEP_MAX_BREADTH`、`GPTR_DEEP_MAX_DEPTH` 和 `GPTR_DEEP_MAX_RESEARCH_CALLS` 限制递归工作量。单个 AO 任务另有 `GPTR_TASK_CONCURRENCY_BUDGET` 加权预算：standard/synthesis 权重为 1，deep 权重为有效 concurrency；超过预算时只降低 deep concurrency，breadth/depth 超限则在 GPTR 构造前拒绝。AO acceptance 的一次自动返工临时使用 synthesis，避免重复建立研究树。

## 边界与演进

Profile 不包含 API key、模型、base URL、网络超时、进程并发、报告格式、篇幅、任务正文、system prompt 或时间上下文。它们继续由部署设置、任务契约或 `TaskTemporalContext` 管理。

TT-002 建立基础契约，TT-003 接入 HTTP、AO YAML、任务快照与 worker，TT-004 打通标准、深研、综合三种真实执行路径及任务级资源预算，TT-006 启用 GPTR 原生来源策展，TT-008 开放指定 URL、补充搜索和严格域名约束。破坏性字段变更必须增加 `schemaVersion`，V1 不接受未知版本。
