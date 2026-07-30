# TT-003 AO 步骤到 ResearchProfile 映射实施 Plan

## 状态

已完成（2026-07-29）。本项已接通任务、AO 步骤、研究连接器和 Python worker 的配置链路，当前只启用已有的 `standard + web + 单检索器` 能力。

## 目标

让平台默认策略、任务级 `researchProfile` 和 AO 原生 `step.llm.params.think_tank` 按固定优先级生成每个专家步骤的完整 `ResearchProfile`：

`平台默认值 < 任务设置 < 专家步骤覆盖`

解析必须在任何专家研究开始前完成。合法 Profile 随任务和工作流事件持久化，并由 Python worker 映射到 GPTR；非法或未启用能力不降级、不忽略。

## 现状证据

- Agency Orchestrator 0.12.1 的 `LLMConfig.params` 是 `Record<string, unknown>`，步骤执行时用 `{ ...workflow.llm, ...step.llm }` 浅合并，并把结果传给 `connector.chat(..., config)`。
- 因此步骤级入口可直接使用 `step.llm.params.think_tank`，无需修改 AO；但任务配置不能放进顶层 `llm.params`，否则会被步骤的整个 `params` 替换。
- 当前 API 只接受 `{ topic }`，任务快照只持久化话题和执行结果。
- `GptrConnector` 目前固定构造 `reportSource: web` 和部署检索器，Python 请求没有 Profile。
- GPTR 0.16.0 已从进程环境读取 `MAX_SEARCH_RESULTS_PER_QUERY`、`MAX_ITERATIONS` 和 `MAX_SUBTOPICS`；TT-001 已保证这些变量可在独立 worker 中安全设置。

## 核心设计

### 深模块与 seam

新增纯计算模块 `research-profile-mapping.ts`，其唯一主要接口为：

```ts
resolveWorkflowResearchProfiles(
  workflow: WorkflowDefinition,
  taskProfile: ResearchProfile,
  capabilities: ResearchCapabilities,
): ReadonlyMap<string, ResearchProfile>
```

模块内部负责提取 `think_tank`、合并、路径重写、能力门控和深度冻结。工作流预检、运行器和测试都只跨这个 seam，不各自复制合并规则。

### 任务提交契约

`POST /api/tasks` 扩展为：

```json
{
  "topic": "研究主题",
  "researchProfile": {
    "schemaVersion": 1,
    "limits": {
      "maxIterations": 4
    }
  }
}
```

`researchProfile` 可省略；现有前端继续只发送 `topic`。提交时使用当时的设置解析并冻结完整 Profile，同时保存安全的 `ResearchCapabilities` 快照。排队期间修改设置不会改变已经提交的任务。

Profile 错误返回 HTTP 422，并保持当前前端可读的 `error: string`，附加稳定的 `code` 和重写后的 `path`，例如 `$.researchProfile.limits.maxIterations`。

### AO 步骤契约

AO 仅允许在普通专家步骤中写：

```yaml
llm:
  params:
    think_tank:
      schemaVersion: 1
      limits:
        maxSearchResultsPerQuery: 8
        maxIterations: 4
        maxSubtopics: 5
```

顶层 `workflow.llm.params.think_tank` 被拒绝，避免出现不明确的第四层优先级。`params` 中与 `think_tank` 并列的 AO 字段原样保留。人工输入和审批节点不能声明研究 Profile。

研究编排提示词将包含当前任务 Profile、已启用能力和上述 YAML 示例。AO 第一次生成非法 Profile 时，沿用现有机制自动重新编排一次；第二次仍非法才终止。

### 合并语义

- 根标量由步骤覆盖任务；缺失表示继承，显式 `null` 不作为删除指令。
- 任务 `researchProfile` 为 `null` 时按兼容默认值处理；步骤一旦声明 `think_tank` 就必须是对象，`null` 会在预检中被拒绝。
- `quality`、`limits` 按已知字段合并；数组始终整体替换。
- 步骤没有 `source` 时继承任务来源。
- 任务与步骤来源均为 Web 时，Web 字段合并，检索器和域名数组整体替换。
- 步骤切换来源模式时，步骤 `source` 整体替换；不会把旧联合类型字段带入新模式。
- 有效模式不是 `deep` 时丢弃继承的 deep 参数；显式提交 deep 参数仍按不变量报错。
- 有效模式是 `deep` 时，只有任务本身也是 deep 才可继承其参数，否则步骤必须给出完整 deep 参数。
- 合并后始终重新调用 TT-002 的 `resolveResearchProfile`，任何层都不能绕过严格校验。

当前运行能力固定为 `standard + web + 提交时配置的单检索器`，关闭来源策展和域名过滤。其他结构虽被 V1 识别，但返回 `profile_capability_disabled`；由后续 TODO 逐项开放。

## 运行链路

1. API 根据部署检索器构造默认值和当前能力，解析任务覆盖值。
2. 任务存储保存完整任务 Profile 与能力快照；旧快照缺少字段时按当前默认兼容。
3. 编排提示词告知 AO 当前能力；生成 YAML 后为每个普通步骤解析有效 Profile。
4. 预检失败进入一次 AO 自动重编排；成功后把完整 Profile 注入运行时副本的 `step.llm.params.think_tank`，不修改磁盘中的上游源码或 AO 包。
5. AO 把有效 `LLMConfig` 传给 `RoutingConnector`；验收调用仍路由到 verifier，研究及返工调用进入 `GptrConnector`。
6. `GptrConnector` 再做一次防御性解析，将完整 `researchProfile` 和兼容字段发送给 Python。
7. Python 重新验证当前只允许标准 Web 单检索器，将 limits 映射为 worker 内的三个 GPTR 环境变量，然后创建 `GPTResearcher`。
8. `workflow.composed` 事件保存每个 step 的 Profile；`gptr.completed` 保存本次实际 Profile。前端本项不新增设置或时间线节点。

## HTTP 与 Python 兼容

TypeScript `ResearchRequest` 和 Python `ResearchRequest` 增加可选 `researchProfile`。旧调用仍可只传 `reportSource/retriever`，Python 会解析为默认标准 Web Profile。新调用同时保留旧字段，并要求其与 Profile 一致，防止两个配置源产生歧义。

Python 在启动 worker 前验证 Profile，错误以 422 返回 `{ code, path, message }`。Profile 不进入密钥环境列表，且 TT-002 会拒绝 API key、模型和 base URL 等字段。

## 范围与非目标

本项实现：

- 任务级 Profile 输入和快照；
- AO 步骤提取、合并、预检、一次自动重编排；
- 完整 Profile 的 Node → Python 传输；
- 标准 Web 单检索器和三项 GPTR 研究限额的实际应用；
- 配置快照事件和兼容路径。

本项不：

- 增加前端高级设置；
- 启用 deep、synthesis、多检索器、URL、域名过滤、策展、本地文档或 MCP；
- 改变 AO 的 DAG、验收、返工或人工节点语义；
- 修改 AO/GPTR 上游源码；
- 把模型、端点、凭据、网络超时或部署并发放进 Profile。

## 预计文件

新增：

- `apps/orchestrator/src/research-profile-mapping.ts`
- `apps/orchestrator/test/research-profile-mapping.test.ts`
- `contracts/research-profile/v1/merge-cases.json`

修改：

- `research-compose.ts`、`workflow-composer.ts`：能力提示和自动重编排预检；
- `ao-runtime.ts`：向运行时步骤副本注入完整 Profile；
- `api-server.ts`、`research-tasks.ts`：任务输入、快照和持久化；
- `research-runner.ts`、`runtime-connector.ts`、`gptr-connector.ts`：传递并记录有效 Profile；
- Node/Python `contracts`：增加可选 `researchProfile`；
- `research_executor.py`、`research_worker.py`：二次校验和 GPTR limits 映射；
- 对应 Node/Python 测试与架构文档。

SQLite 继续使用 JSON 快照，不需要表结构迁移；旧快照按字段缺失兼容。

## TDD 实施顺序

1. 建立共享 merge fixtures，先覆盖三层优先级、对象合并、数组替换、来源模式切换、deep 联动及错误路径。
2. 先写 `resolveWorkflowResearchProfiles` 的失败测试，再完成纯 TypeScript 映射模块。
3. 增加 workflow composer 测试：合法 Profile 一次通过，非法 Profile 自动重编排一次，二次非法终止，且未调用研究连接器。
4. 增加 API/任务存储测试：旧 `{ topic }` 不变，任务 Profile 在提交时冻结，非法值返回 422，SQLite 重载后快照一致。
5. 增加连接器契约测试：不同 AO 步骤发出不同完整 Profile；验收与返工路由不受影响；请求和事件不含密钥。
6. 先写 Python 失败测试，再扩展请求模型和验证；验证旧请求默认行为。
7. 用 worker 环境探针证明三个 limits 进入独立子进程，两个并发任务互不污染；验证不支持的模式在 GPTR 构造前被拒绝。
8. 增加一条跨层验收：AO YAML 步骤 limits → Node HTTP 请求 → Python worker 的 GPTR 配置值完全一致。
9. 运行全量 Node、类型检查、构建、Python、V1 acceptance 和健康检查。

## 验收标准

- 不带 Profile 的现有网页任务输出与当前行为一致。
- 任务和两个 AO 专家步骤可得到三个不同、确定且可追溯的有效 Profile。
- 步骤数组替换而非拼接；切换联合来源不残留旧字段。
- 非法任务配置在 HTTP 提交时返回 422；非法 AO 配置在任何 GPTR 请求前失败或自动重编排成功。
- 当前部署无法通过 YAML 偷开 deep、多来源、多检索器或策展。
- GPTR 实际读取每个步骤解析后的三项 limits，且并发 worker 无环境串扰。
- 任务快照、事件和错误不含凭据、模型端点或完整 system prompt。
- `npm test`、`npm run typecheck`、`npm run build`、Python 全量 Pytest 与 `npm run test:acceptance` 全部通过。

## 回滚

新字段均可选，SQLite 无结构迁移。回滚时删除映射模块和 Profile 传输，Node 恢复按部署检索器构造旧请求，Python 保留可选字段也不会影响旧客户端。已有任务快照中的额外 JSON 字段会被旧代码忽略。

## 后续

TT-003 验收后实施 TT-004：在同一 Profile 和 worker 隔离基础上，开放 `deep` 与 `synthesis`，增加 AO × GPTR 总并发预算和明确的模式执行适配。
