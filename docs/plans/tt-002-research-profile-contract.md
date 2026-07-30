# TT-002 统一 ResearchProfile 契约实施 Plan

## 状态

已完成（2026-07-29）。本项只建立契约和验证方案，未改变现有请求、执行器或前端行为。

## 目标

在 TypeScript 与 Python 两端建立版本一致、严格验证的 `ResearchProfile`。缺省 Profile 必须精确保持当前“标准模式 + Web 搜索 + 部署所选检索器”的行为，同时为深研、多来源和多检索器保留稳定扩展口。

## 现状证据

- `ResearchRequest` 目前只接受 `reportSource: "web"` 和单个 `retriever`。
- `GptrConnector` 始终构造 Web 研究请求，尚无步骤级研究策略入口。
- GPTR 当前默认值包含每次查询 5 个结果、3 次迭代、3 个子主题，以及深研广度、深度和并发参数。
- AO 的步骤级 `llm.params` 可承载未来的 `think_tank` 覆盖值，但映射属于 TT-003。
- 设置页管理模型、端点、凭据、检索器和进程并发；这些部署配置不应混入研究策略。

## 范围与非目标

本项实现独立的 Profile 类型、解析器、默认值解析、能力门控、稳定错误和双端契约测试。

本项不：

- 修改 `ResearchRequest`、AO YAML 解析、`GptrConnector` 或研究 worker；
- 启用 deep、synthesis、URL、本地文档、hybrid、MCP 或多检索器执行；
- 把 API key、模型、base URL、超时、进程并发、报告格式、精确字数、任务或 system prompt 放入 Profile；
- 直接暴露 GPTR 的 `report_type` 或任意原始配置字段。

## V1 数据契约

线上的 JSON 使用 camelCase；Python 内部使用 snake_case 并通过别名保持同一协议。解析后的 Profile 深度不可变，未知字段一律拒绝。

当前缺省解析结果：

```json
{
  "schemaVersion": 1,
  "mode": "standard",
  "source": {
    "mode": "web",
    "retrievers": ["<deployment default>"]
  },
  "quality": {
    "curateSources": false
  },
  "limits": {
    "maxSearchResultsPerQuery": 5,
    "maxIterations": 3,
    "maxSubtopics": 3
  }
}
```

`mode` 的结构枚举为 `standard | deep | synthesis`。`deep` 模式必须提供：

```json
{
  "deep": {
    "breadth": 3,
    "depth": 2,
    "concurrency": 2
  }
}
```

`source` 使用可辨识联合类型：

- `web`：一个或多个 `retrievers`，可选 `includeDomains` / `excludeDomains`；
- `urls`：绝对 HTTP(S) `urls`，可选择附带同结构的 Web 补充策略；
- `local`：平台管理的 `documentIds`，禁止文件系统路径；
- `hybrid`：文档 ID 与 Web/URL 来源组合；
- `mcp`：平台管理的 `mcpProfileIds`，禁止命令和环境变量。

V1 先固定这些端口，但由 `ResearchCapabilities` 控制是否可执行。当前部署只启用 `standard + web + 当前配置的单检索器`。结构合法但未启用的能力返回错误，不降级、不忽略；TT-004、TT-008、TT-009、TT-011 和 TT-012 再逐项开启。

## 约束与错误

- 所有数值必须是整数，不接受字符串强制转换。
- `maxSearchResultsPerQuery` 为 1–20，`maxIterations` 为 1–10，`maxSubtopics` 为 1–20。
- 深研 `breadth` 为 1–10，`depth` 为 1–5，`concurrency` 为 1–16。
- 检索器最多 5 个、URL 最多 50 个、文档 ID 最多 20 个、MCP Profile ID 最多 10 个；这些是平台安全上限，不是 GPTR 限制。
- 域名列表各最多 20 个，只接受规范化主机名；同一域名不能同时出现在包含和排除列表。
- URL 在本项只校验绝对 HTTP(S) 地址和长度；DNS、私网与重定向防护在 TT-008 实现。
- 后续合并覆盖值时，数组采用整体替换而非拼接；优先级与 AO 映射在 TT-003 实现。

两端统一输出 `{ code, path, message }`。`code` 和 `path` 必须一致，文案可按运行环境调整：

- `profile_version_unsupported`
- `profile_unknown_field`
- `profile_invalid_type`
- `profile_invalid_value`
- `profile_invariant_violation`
- `profile_capability_disabled`

## 模块接口

TypeScript 暴露：

```ts
resolveResearchProfile(
  input: unknown,
  defaults: ResearchProfileDefaults,
  capabilities: ResearchCapabilities,
): ResearchProfile
```

Python 暴露语义相同的 `resolve_research_profile(...) -> ResearchProfile`。另提供只负责严格解析部分输入的 Profile Override 类型；它不能直接交给执行器。

V1 不增加 JSON Schema、Ajv 或代码生成依赖。两端手工实现窄接口，以同一份 fixture 语料保证行为一致。

## 计划文件

- `contracts/research-profile/v1/cases.json`：双端共用的合法、非法与能力门控样例。
- `apps/orchestrator/src/research-profile.ts`：TypeScript 类型、解析、默认值解析和冻结。
- `apps/orchestrator/test/research-profile.test.ts`：Node 契约测试。
- `services/researcher/app/research_profile.py`：Pydantic 模型、解析与稳定错误。
- `services/researcher/test/test_research_profile.py`：Python 契约测试。
- `docs/architecture/research-profile-v1.md`：字段语义、边界和扩展规则。

## TDD 实施顺序

1. 先写共享 fixtures，覆盖缺省值、每种合法结构、未知字段、错误类型、范围、不变量和禁用能力。
2. 写 Node 失败测试，再实现 TypeScript 解析器与不可变结果。
3. 用同一 fixtures 写 Python 失败测试，再实现 Pydantic 镜像。
4. 增加双端规范化结果、错误 `code/path` 和能力门控的等价性断言。
5. 补齐架构文档，运行全量回归，确认现有 HTTP 请求与研究行为没有变化。

## 验收标准

- 同一份 fixtures 在 Node 与 Python 中全部通过。
- 缺省输入解析为当前标准 Web 行为，默认检索器来自部署设置而非契约硬编码。
- 未启用能力在研究开始前以稳定错误拒绝。
- 未知字段、凭据、模型字段及 GPTR 原始字段不能进入 Profile。
- 解析结果不可变，原始覆盖对象后续修改不影响结果。
- `npm test`、`npm run typecheck`、`npm run build`、Python 全量 Pytest 和 `npm run test:acceptance` 全部通过。

## 回滚

TT-002 的模块尚未接入生产请求链路。若契约需要重做，可删除新增模块、fixtures 和测试，不迁移数据、不影响当前任务执行；一旦 TT-003 接入后，变更必须通过新的 `schemaVersion` 演进。

## 后续

TT-002 验收后实施 TT-003：把“平台默认值 < 任务设置 < `step.llm.params.think_tank`”解析为本契约，并将已解析 Profile 传入研究服务。
