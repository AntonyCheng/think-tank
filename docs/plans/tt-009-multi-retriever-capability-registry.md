# TT-009 多检索器能力注册表实施 Plan

## 状态

已实施。能力目录、跨语言契约、设置迁移、Source Grant、多检索器运行时、失败语义、可观测事件和前端选择器均已接入；自动化回归已通过，真实多检索器网络路径留待重启服务后人工验收。

## 目标

在不修改 AO 或 GPTR 上游源码的前提下，让一次 Web 研究能够安全使用一个或多个已配置检索器，并保持现有单 DuckDuckGo 行为完全兼容。平台必须知道哪些检索器真实可用、AO 能使用哪些能力、用户为本次任务授权了哪些检索器，以及某个提供商失败后任务应继续还是终止。

## 现状证据

- 两端 `ResearchProfile` 已把 `retrievers` 定义为数组，最多解析 5 项，但运行能力固定为 `maxRetrievers: 1`。
- TypeScript `GptrConnector` 当前只取 `retrievers[0]`，Python `ResearchRequest` 和环境变量也只接受 DuckDuckGo 或 Tavily 单值。
- 本地 GPTR 0.16.0 的 `Config.parse_retrievers()` 原生解析逗号分隔列表，`get_retrievers()` 会构造多个检索器，标准研究流程会遍历它们。
- 本地 GPTR 已包含 DuckDuckGo、Tavily、arXiv、OpenAlex、Semantic Scholar 和 PubMed Central adapter；环境中已有 `ddgs 9.14.4`、`arxiv 4.0.0` 和 `requests 2.33.1`。
- GPTR 会跳过单个检索器异常并对已访问 URL 做基础去重，但没有平台所需的配置可用性、超时、规范化 URL 去重和结构化提供商诊断。

## 第一性原理决策

1. **复用 GPTR 原生多检索器流程。** 平台只在适配 seam 配置和观察检索器，不复制查询生成、抓取、上下文压缩或报告写作。
2. **可用能力不等于代码中存在。** 检索器必须同时满足“平台显式启用、adapter 可导入、必需凭据存在”才可被选择。
3. **部署能力、默认选择和任务授权分离。** 部署决定可用集合；设置页决定默认集合；任务 Profile 是本次 Source Grant，AO 只能选择其子集。
4. **资源预算按查询共享。** 增加检索器不能线性放大抓取量；结果上限在提供商之间分配，合并后仍受 Profile 总量约束。
5. **失败语义由证据是否仍可形成决定。** 单个提供商失败时降级；Web-only 的全部提供商失败或无结果时稳定失败；URL+Web 若已有指定 URL 证据则完成并给出警告。
6. **公开事件保持可读，完整诊断保持结构化。** 时间线只显示合并后的提供商状态，逐次尝试、耗时和错误码进入诊断数据，禁止泄露密钥、请求头或服务器网络信息。

## V1 检索器矩阵

| ID | 类型 | 必需配置 | 可选配置 |
|---|---|---|---|
| `duckduckgo` | 通用 Web | `ddgs` 可导入 | 无 |
| `tavily` | 通用 Web | `TAVILY_API_KEY` | 无 |
| `arxiv` | 学术论文 | `arxiv` 可导入 | 无 |
| `openalex` | 学术元数据 | 无 | `OPENALEX_EMAIL`、`OPENALEX_API_KEY` |
| `semantic_scholar` | 开放论文 | 无 | 无 |
| `pubmed_central` | 生物医学全文 | 无 | `NCBI_API_KEY`、`PUBMED_DB` |

未新增配置时仍只启用 DuckDuckGo；`.env.example` 演示如何显式启用五个无需密钥的 adapter。V1 最多允许一次任务选择 3 个检索器；未显式启用或未就绪的项不会出现在任务可选项中。

## 配置与兼容

新增：

```dotenv
GPTR_ENABLED_RETRIEVERS=duckduckgo
GPTR_MAX_RETRIEVERS=3
GPTR_RETRIEVER_TIMEOUT_MS=20000
```

现有 `RETRIEVER` 改为默认检索器列表并兼容旧单值：

```dotenv
RETRIEVER=duckduckgo,openalex
```

未配置 `GPTR_ENABLED_RETRIEVERS` 时，自动使用 `RETRIEVER` 中的项目作为启用集合，保证现有 `.env` 无需修改即可运行。旧设置文件中的标量 `retriever` 在读取时迁移为单元素 `retrievers`，不修改历史任务快照。

## 深模块与接口

Python 新增 `retriever_runtime.py`，在一个小接口后隐藏 GPTR factory、凭据检查、adapter 包装、域名过滤、超时、结果预算、URL 去重和提供商统计：

```py
catalog = build_retriever_catalog(environment)
run = install_retriever_runtime(
    researcher=researcher,
    selection=web_policy.retrievers,
    catalog=catalog,
    limits=limits,
    observer=observer,
)
```

该模块替代现有独立的域名包装逻辑，避免形成多层浅包装。内部以共享、线程安全的运行状态按规范化 URL 去重；测试使用内存 provider adapter，生产使用 GPTR 已安装的 provider class。

Researcher 服务新增只读能力接口：

```json
{
  "schemaVersion": 1,
  "retrievers": [
    {
      "id": "duckduckgo",
      "label": "DuckDuckGo",
      "category": "web",
      "selectable": true,
      "credentialRequired": false,
      "timeoutMs": 20000
    }
  ],
  "maxRetrievers": 3
}
```

Python 是真实运行能力的权威来源。TypeScript 在 GPTR HTTP seam 增加能力读取 port，生产使用 HTTP adapter，测试使用内存 adapter；API 缓存最近一次成功快照，但新任务仍必须按当前快照校验。

## 契约与执行规则

- `ResearchRetriever` 跨语言枚举扩展为矩阵中的 6 个稳定 ID。
- `ResearchCapabilities.retrievers` 只包含就绪项，`maxRetrievers` 来自服务能力快照。
- `ResearchProfile.source.*.retrievers` 继续作为唯一任务字段，不增加平行请求参数。
- `GptrConnector` 不再丢弃数组；Python 从已解析 Profile 生成逗号分隔的 GPTR `RETRIEVER` 配置。
- AO 步骤的检索器必须是任务 Source Grant 的子集；可以缩小，不能添加用户未授权的提供商。
- URL-only 与 `synthesis` 不初始化检索器；URL+Web 仅为补充搜索安装检索器。
- 多提供商结果在抓取前按规范化 URL 去重，域名允许/排除规则在去重后、抓取前执行。
- 每个来源 Evidence Bundle 继续记录完整 `method.retrievers`；提供商运行统计进入遥测和诊断。

## 降级与可观测性

公开研究活动增加并合并显示：

- 已启用检索器；
- 某检索器正在查询；
- 某检索器无结果或已降级；
- 多检索器结果已合并及去重；
- 全部检索器不可用。

同一提供商的重复子查询事件在时间线中更新计数，不产生数百个节点。诊断记录 provider ID、查询序号、开始/结束时间、返回数、保留数、重复数、超时或稳定错误码；原始异常只写受限日志并脱敏。

## TDD 实施顺序

1. Python 注册表测试：显式启用、adapter 缺失、必需/可选凭据和安全能力响应。
2. 能力接口与 TypeScript HTTP adapter 合约测试；不可用项不进入可选择集合。
3. 跨语言 Profile 契约扩展及旧 `retriever` 设置迁移测试。
4. Source Grant 测试：AO 只能选择任务授权检索器的子集。
5. Connector 测试：多值完整传到 GPTR；URL-only 和 `synthesis` 不安装检索器。
6. 运行模块测试：两个内存 provider 的预算分配、规范化去重、域名过滤和稳定顺序。
7. 降级测试：单 provider 异常、超时、空结果、全部失败，以及 URL+Web 有上游证据时继续。
8. 证据与遥测测试：实际选择、唯一来源数、提供商统计和公开事件一致。
9. 前端测试：设置页与任务页只显示可用项，至少选择一项且不超过能力上限。
10. Node、Python、typecheck、build、acceptance 全量回归。
11. 人工验收：DuckDuckGo 单检索器、多检索器学术主题、未配置 Tavily、单提供商故障四条路径。

## 预计文件

- 新增 `services/researcher/app/retriever_runtime.py`
- 新增 `services/researcher/test/test_retriever_runtime.py`
- 修改 Researcher 能力路由、contracts、research profile/policy/worker
- 修改 TypeScript research profile、settings、GPTR connector、来源授权和证据遥测
- 修改设置页与任务级研究设置
- 更新 `.env.example`、共享契约 fixtures、架构文档和本 TODO

## 范围与非目标

TT-009 不实现新的抓取器、JavaScript 页面回退、登录态搜索、自定义 provider 插件、MCP、本地文件、自动按主题动态购买付费检索额度或 deep 模式的严格域名传播；分别留给 TT-010、TT-011、TT-012 及后续条目。V1 不把 API key 存入浏览器或公开设置文件，提供商凭据仍由部署环境管理。

## 验收标准

- 未改 `.env` 的现有 DuckDuckGo 任务行为不变；
- 只有显式启用且真实就绪的检索器可被设置页、任务页和 AO 使用；
- 任务可选择 1～3 个检索器，数组不会在连接层被压成第一项；
- 多检索器总结果受统一预算限制，重复 URL 不重复抓取或计数；
- 单 provider 失败不影响其余 provider，全部失败有稳定终态和完整诊断；
- URL-only 和综合步骤不触发检索，URL+Web 可在 Web 失败时使用指定来源降级完成；
- 时间线可见提供商进度但事件数量有界；
- Node、Python、typecheck、build、acceptance 和人工四路径验收全部通过。

## 回滚

将 `GPTR_ENABLED_RETRIEVERS` 与 `RETRIEVER` 恢复为 `duckduckgo`，把 `maxRetrievers` 恢复为 1，即可关闭多检索器执行。Profile 数组、能力响应和历史任务无需迁移；包含当前部署不再支持的检索器的旧任务仍可查看，重新执行时返回稳定的能力不可用错误。

## 实施结果

- Python `/capabilities` 只公开显式启用、adapter 可导入且凭据完整的检索器，`/ready` 同时要求至少一个检索器就绪。
- TypeScript 使用带 TTL 的能力读取 port；设置页保存有序默认集合，任务页冻结本次检索器 Source Grant，历史标量设置自动兼容。
- GPTR 继续使用自身 0.16.0 原生多检索器循环；平台包装层按查询分摊结果预算，并在抓取前执行域名过滤和跨提供商规范化 URL 去重。
- 单提供商异常或超时返回空结果并继续；Web-only 全部失败或无可用结果返回稳定错误，URL + Web 有指定证据时允许降级完成。
- 时间线公开显示检索器启用、首次查询、降级和合并摘要；逐查询耗时、返回数和稳定错误码保留为受限诊断，同一提供商重复查询不会生成重复公开节点。
- `.env.example` 已记录启用集合、默认集合、最多选择数和单提供商超时；未新增浏览器端密钥配置。
