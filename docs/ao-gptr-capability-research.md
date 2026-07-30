# AO × GPT Researcher 能力增强调研

调研日期：2026-07-29  
基线：本仓库 `agency-orchestrator==0.12.1`、`gpt-researcher==0.16.0`

## 结论

最稳定的边界是：

- **AO 是唯一控制面**：负责专家选型、完整 `systemPrompt`、YAML/DAG、变量传递、条件、人工节点、循环、验收、返工与恢复。
- **GPTR 是研究执行面**：每个 AO 普通研究步骤调用一次 GPTR，负责检索、抓取、递归深研、来源策展、文档/MCP 上下文、证据与报告草稿。
- **平台是适配与治理面**：解释 AO 的所有节点类型，将 GPTR 事件映射为统一事件，保存证据包、成本与产物，并执行并发和安全策略。

不建议默认启用 GPTR 自带的 LangGraph/AG2 多代理团队，因为它也包含 Chief Editor、Reviewer、Revisor、Writer 等编排角色，会与 AO 重复分工、重复审核并模糊失败归属。GPTR 的递归 `deep` 和 `DetailedReport` 则是研究算法/长报告能力，可以在 AO 控制下按需使用。

## 已核实的上游能力边界

### AO 0.12.1

本仓库安装的 `0.12.1` 与当前官方稳定标签一致。[v0.12.1 Release](https://github.com/jnMetaCode/agency-orchestrator/releases/tag/v0.12.1) AO 的工作流类型原生包含顶层 `concurrency`、`verify`、输入与步骤；步骤包含 `acceptance`、`verify`、`skill(s)`、`depends_on`、`depends_on_mode`、`condition`、`approval`、`human_input`、步骤级 LLM 覆盖和有界 `loop`。角色定义明确包含完整 `systemPrompt`。[官方类型定义](https://github.com/jnMetaCode/agency-orchestrator/blob/main/src/types.ts)

关键语义：

- `depends_on` 构建 DAG，无依赖冲突的步骤可并行；输出通过 `{{变量}}` 传入下游。[官方 README：工作原理](https://github.com/jnMetaCode/agency-orchestrator#工作原理)
- `acceptance` 会注入步骤提示、自动核验并最多返工一轮；**验收未过是质量信号，不是执行错误**，带警告的结果仍可流向下游。[`StepVerification` 官方定义](https://github.com/jnMetaCode/agency-orchestrator/blob/main/src/types.ts#L144-L158)
- `approval` 与 `human_input` 是暂停等待人的节点；`condition`、`any_completed` 和 `loop` 都会改变运行分支。[官方 YAML Schema](https://github.com/jnMetaCode/agency-orchestrator#yaml-schema)
- LLM 调用失败可按 `llm.retry` 重试；超时重试会放大 timeout。CLI 还支持 `--resume` 和 `--from`。[官方 README](https://github.com/jnMetaCode/agency-orchestrator#cli-命令)

因此，后端不能只识别“专家 + task + 顺序”，也不能把 acceptance 未通过直接改写成任务失败。

AO 在 compose 阶段只用角色的 `path/name/emoji/description/category` 做匹配，执行阶段才由公开 `loadAgent()` 加载完整正文并作为连接器的 system prompt；本仓库用 AO 编程 API + 自定义 GPTR connector 的方向与上游接口一致，无需复制 AO 源码。[角色加载器](https://github.com/jnMetaCode/agency-orchestrator/blob/main/src/agents/loader.ts) [公开导出](https://github.com/jnMetaCode/agency-orchestrator/blob/main/src/index.ts)

当前适配还需留意两个上游语义：

- 原生 `human_input/approval` 是**运行到该节点时**才暂停，prompt 可以引用上游输出；若平台在执行前一次性收集所有人工输入，会提前提问且无法渲染上游变量。动态澄清应实现 `waiting_for_input` 的平台状态，而不是继续前置收集。
- `condition` 只支持不区分大小写的 `contains/equals`，不是通用表达式；`any_completed` 会在任一依赖完成时放行，因此综合报告必须显式标记缺失分支。[条件实现](https://github.com/jnMetaCode/agency-orchestrator/blob/main/src/core/condition.ts)

### GPT Researcher 0.16.0

PyPI 当前发布物为 `0.16.0`。[官方 PyPI](https://pypi.org/project/gpt-researcher/) 核心 `GPTResearcher` 构造器原生接受 `report_type`、`report_source`、`source_urls`、`document_urls`、`query_domains`、LangChain documents/vector store、`agent`、`role`、`context`、`websocket`、`log_handler` 和 `mcp_configs`，并提供来源、上下文、图片、总成本和分步骤成本读取方法。[官方 `agent.py`](https://github.com/assafelovic/gpt-researcher/blob/main/gpt_researcher/agent.py)

报告类型包括 `research_report`、`resource_report`、`outline_report`、`custom_report`、`detailed_report`、`subtopic_report` 和递归深研 `deep`；来源类型包括 web、local、hybrid、LangChain documents/vector store 等。[官方枚举](https://github.com/assafelovic/gpt-researcher/blob/main/gpt_researcher/utils/enum.py)

## 建议接入顺序

| 优先级 | 能力 | 价值 | 建议 |
|---|---|---|---|
| P0 | 研究档位与单步配置快照 | 直接提升研究深度，改动集中 | 先做 |
| P0 | 结构化证据包与来源策展 | 提升可靠性和可审计性 | 先做 |
| P0 | 细粒度成本、阶段、深研进度 | 让可观测性从日志升级为指标 | 先做 |
| P1 | 指定 URL、域名白名单、多检索器与抓取降级 | 控制来源质量、扩大覆盖 | 随后做 |
| P1 | 本地文档 + Web 混合研究 | 进入企业/个人知识研究 | 随后做 |
| P1 | MCP + Web 混合研究 | 连接 GitHub、数据库和业务系统 | 随后做 |
| P1 | 面向 acceptance 的定向补研 | 减少盲目整篇重跑 | 随后做 |
| P2 | DetailedReport 长报告 | 复杂课题的最终综合更完整 | 按需 |
| P2 | 来源图片与 AI 插图 | 改善交付表达 | 按需、显式标识 |
| 暂缓 | GPTR LangGraph/AG2 多代理 | 与 AO 重复编排 | 不默认启用 |

## 可接入能力详解

### P0-1：研究档位，而不是所有专家同一种 GPTR 调用

**上游证据**：GPTR `deep` 使用树状递归，支持 breadth、depth、concurrency 和进度回调；官方说明其会并发探索多条路径并聚合上下文。[Deep Research 文档](https://docs.gptr.dev/docs/gpt-researcher/gptr/deep_research) 配置还原生提供 `MAX_ITERATIONS`、`MAX_SEARCH_RESULTS_PER_QUERY`、`MAX_SUBTOPICS`、`TOTAL_WORDS`、`CURATE_SOURCES`、三个模型角色及深研参数。[配置文档](https://docs.gptr.dev/docs/gpt-researcher/gptr/config)

**集成方式**：在平台定义三个稳定 profile，而不修改 AO YAML：

- `standard`：现有 `custom_report`，适合大多数专家步骤。
- `deep`：`report_type="deep"`，只给需要追踪线索、跨来源验证的研究步骤。
- `detailed`：只用于最终长报告或少数综合节点，使用上游 `DetailedReport` 包装器。

默认由用户在任务页选择全局档位；以后再允许 AO step 的元数据或平台规则覆盖。每次调用生成不可变的 GPTR 配置快照并随步骤存档。

**风险**：`deep` 的时间和请求量随 breadth × depth 增长；AO 并行与 GPTR 内部并行会相乘。必须设置平台级总并发、超时、取消和每任务预算。官方给出的约 5 分钟、约 0.4 美元只是特定模型示例，不是本地模型服务的 SLA。

### P0-2：来源策展与证据包

**上游证据**：`CURATE_SOURCES=true` 会多一次 LLM 调用来改善来源选择。[配置文档](https://docs.gptr.dev/docs/gpt-researcher/gptr/config) `GPTResearcher` 可读取 visited URLs、完整 research sources、research context 和 images。[官方 `agent.py`](https://github.com/assafelovic/gpt-researcher/blob/main/gpt_researcher/agent.py) 官方架构也明确包含“逐资源摘要和来源跟踪，再过滤聚合”。[官方 README](https://github.com/assafelovic/gpt-researcher#architecture)

**集成方式**：每个 AO 步骤除了 Markdown，还保存：

```text
evidenceBundle
  sourceUrls[]
  sources[{url,title,content/images...}]
  researchContext[]
  searchQueries[]
  visitedAt / retriever / scraper
  reportLinks[]
```

最终引用仍由平台正规化；验收器可检查事实性段落是否引用 evidence bundle 中的 URL。高可靠模式开启 `CURATE_SOURCES`，普通模式保持关闭。

**风险**：策展提高质量但不能证明事实为真；抓取内容可能过期、重复或受版权约束。不要向前端泄露私有文档全文或 MCP 密钥，证据包需要访问控制和保留期限。

### P0-3：原生阶段、深研进度与成本

**上游证据**：GPTR 日志是带 timestamp、type、data 的事件，覆盖规划、子查询、抓取、子主题和写作阶段。[日志文档](https://docs.gptr.dev/docs/gpt-researcher/handling-logs/all-about-logs) `conduct_research(on_progress=...)` 为 deep 模式提供深度/广度进度，`get_costs()` 与 `get_step_costs()` 返回总成本及阶段成本。[官方 `agent.py`](https://github.com/assafelovic/gpt-researcher/blob/main/gpt_researcher/agent.py) LangSmith 还能跟踪 LLM 调用、错误、成本和时延。[LangSmith 文档](https://docs.gptr.dev/docs/gpt-researcher/handling-logs/langsmith-logs)

**集成方式**：

- 保留当前压缩后的用户时间线，同时新增内部原始事件存档。
- 统一事件字段：`taskId/aoStepId/researchRunId/phase/progress/cost/sourceCount`。
- UI 展示“规划 → 查询 → 抓取 → 聚合 → 写作”，deep 额外显示 depth/breadth。
- 响应增加 `stepCosts`；平台累加为专家、任务和模型维度的指标。
- LangSmith 作为可选运维集成，不作为平台运行依赖。

**风险**：不同 OpenAI 兼容服务可能不返回标准 usage/价格，成本可能是 0 或估算；事件文本不应直接当稳定 API，优先消费结构化 type/metadata。

### P1-1：受控来源、域名策略与多检索器

**上游证据**：

- `source_urls` 可限制为给定 URL；`complement_source_urls=true` 可再补充 Web 搜索。[Tailored Research](https://docs.gptr.dev/docs/gpt-researcher/context/tailored-research)
- `query_domains` 可限制域名；GPTR 支持多个检索器及自定义 HTTP retriever 的标准结果格式。[Search Engines](https://docs.gptr.dev/docs/gpt-researcher/search-engines)
- 抓取器可选轻量 BeautifulSoup、支持 JavaScript 的 browser/Selenium，以及 Tavily Extract、Firecrawl 等生产抓取服务。[Scraping Options](https://docs.gptr.dev/docs/gpt-researcher/gptr/scraping)

**集成方式**：设置页增加“来源策略”而非暴露全部环境变量：

- Web 全网；
- 仅指定 URL；
- 指定 URL + Web 补充；
- 域名白名单；
- retriever 组合与 scraper 降级链。

第一层继续 DuckDuckGo；遇到抓取空内容/JS 页面时按配置切换 scraper，而不是重复同一请求。

**风险**：检索器的结果结构、配额和地域可用性不同；多检索器会产生重复 URL。需要 URL canonicalization、去重、超时隔离和单 provider 熔断。动态浏览器抓取资源更重，也更容易触发站点条款与反爬限制。

### P1-2：本地文档与混合研究

**上游证据**：GPTR 支持 PDF、纯文本、CSV、Excel、Markdown、PowerPoint、Word；`report_source="local"` 只研究本地文档，`"hybrid"` 将文档与 Web 合并。[Local Documents](https://docs.gptr.dev/docs/gpt-researcher/context/local-docs) [Hybrid Research](https://docs.gptr.dev/docs/examples/hybrid_research) 构造器也接受 `document_urls`、LangChain documents 和 vector store。[官方 `agent.py`](https://github.com/assafelovic/gpt-researcher/blob/main/gpt_researcher/agent.py)

**集成方式**：上传文件先进入 task-scoped 隔离目录，API 只传受控路径/文档对象；页面提供 `web / local / hybrid`。AO 仍决定每个专家任务，GPTR 只改变证据来源。企业场景可把既有向量库以 `vector_store` 接入。

**风险**：不能允许用户直接提交服务器路径；需限制格式、体积、解压炸弹和解析超时。混合报告必须在 evidence bundle 中标注来源类型，避免把内部材料链接暴露到公开报告。大文档会增加内存和向量化成本。

### P1-3：MCP + Web 混合研究

**上游证据**：GPTR MCP 使用两阶段策略：先由模型选择工具，再生成与查询相关的参数执行；支持纯 MCP 或与 Web/学术检索器组合，支持 stdio、HTTP、WebSocket 连接，以及 `fast/deep/disabled` 策略。[MCP Integration](https://docs.gptr.dev/docs/gpt-researcher/retrievers/mcp-configs) 核心构造器直接接受 `mcp_configs`，且当前实现避免把会话 MCP 设置写入全局环境。[官方 `agent.py`](https://github.com/assafelovic/gpt-researcher/blob/main/gpt_researcher/agent.py)

**集成方式**：从管理员维护的 MCP 连接注册表选择，不接受任务任意传 command/env。典型组合：

- 技术调研：DuckDuckGo + GitHub MCP；
- 企业分析：Web + 内部知识库/数据库 MCP；
- 学术调研：Web + arXiv/论文库 MCP。

步骤保存工具名、参数摘要、返回来源标识，但对 token 和敏感字段脱敏。

**风险**：MCP 是工具执行边界，不只是搜索源。必须做 server allowlist、工具 allowlist、超时、输出大小限制、路径限制和凭据隔离。`deep` 会对多个子查询反复调用 MCP，默认应为 `fast`。

### P1-4：根据 AO acceptance 做定向补研

**上游证据**：AO 的 acceptance 会核验、返工并产生 `failed[]/reworked/pass` 结构，但未通过不会把步骤置为 failed。[官方类型定义](https://github.com/jnMetaCode/agency-orchestrator/blob/main/src/types.ts) GPTR 可接受已有 context、指定 URL、外部 context 和 custom report prompt。[官方 `agent.py`](https://github.com/assafelovic/gpt-researcher/blob/main/gpt_researcher/agent.py)

**集成方式**：

1. 首次 GPTR 产出交给 AO acceptance 语义核验。
2. 若缺项属于“缺少来源/某维度数据不足”，生成一个**补研 query**，复用原专家 role、原证据 URL 和 failed 条目。
3. 只研究缺口，再将补研证据与原报告交给 GPTR/平台合成一次。
4. 仍未过则以 `completed_with_warning` 流向下游，完整保留两次证据与验收记录。

这比无条件整篇重跑更省时间，也更符合 AO 的一次返工语义。

**风险**：必须区分传输失败、研究失败和质量未通过，三者不能共用 retry 计数；模型可能为满足验收而编造数据，因此补研仍只能使用已验证 URL。

### P1-5：恢复、局部重跑与运行时澄清

**上游证据**：AO 支持 `--resume` 复用已完成步骤、`--from` 从指定步骤及其下游重跑、`--feedback` 携带上一版产出定向返工；执行器还有 step/batch 生命周期回调。[官方 Resume/Feedback](https://github.com/jnMetaCode/agency-orchestrator#迭代优化resume) [官方执行器](https://github.com/jnMetaCode/agency-orchestrator/blob/main/src/core/executor.ts)

**集成方式**：

- 将每个 GPTR 步骤的报告、证据、配置快照和 AO 输出变量作为 checkpoint。
- 用户修改一个专家结论时，只失效该步骤及其 DAG 下游，不重复昂贵的上游深研。
- 执行到 `human_input/approval` 时进入 `waiting_for_input`，把渲染后的 prompt 推到前端，回答后恢复同一运行。
- AO `skill/skills` 已会加入专家 system prompt，可沉淀“证据分级、反方论证、竞品矩阵、事实核查”等研究方法论，而无需改 AO。

**风险**：恢复前应比较 workflow hash、输入 hash、研究 profile 和模型配置，避免错误复用旧证据。AO README/类型注释与执行器默认 retry 的代码兜底存在差异；研究工作流应显式写 `retry: 1` 或 `2`，防止 AO 外层重试与 GPTR 内部重试相乘。

### P2-1：DetailedReport 用于最终综合

**上游证据**：`DetailedReport` 会先研究主题、拆分子主题、逐主题补充研究、避免重复，最后加入引言、目录、结论和参考来源。[Detailed Report](https://docs.gptr.dev/docs/examples/detailed_report) [官方实现](https://github.com/assafelovic/gpt-researcher/blob/main/backend/report_type/detailed_report/detailed_report.py)

**集成方式**：只在“最终综合”节点可选使用；把 AO 已完成步骤的结论作为外部 context/指定 subtopics，避免 GPTR 重新决定专家团队。标准任务继续沿用当前轻量综合。

**风险**：它会再次拆子主题并进行多轮研究，若每个 AO 专家都用会造成请求爆炸和大量重复。其自身参考文献格式还需经过平台引用正规化。

### P2-2：图片

**上游证据**：GPTR 能收集、筛选网页图片；还可在研究后、写作前通过 Gemini/ModelsLab 生成内联插图并发送 image planning/generation 事件。[官方 README](https://github.com/assafelovic/gpt-researcher#features) [Inline Image Generation](https://docs.gptr.dev/docs/gpt-researcher/gptr/image_generation)

**集成方式**：先接“来源图片”，保存原 URL、页面 URL、alt 与许可证备注；AI 插图后接，并在图注标明“AI 生成示意图”，本地代理下载后再用于网页/DOCX/PDF。

**风险**：网页图片版权和热链不稳定；生成图不能当事实证据，图中文字和数据可能错误。远程图片下载需防 SSRF、超大文件和恶意媒体。

## 不建议默认启用的 GPTR 多代理

GPTR 官方 LangGraph 示例包含 Chief Editor、Researcher、Editor、Reviewer、Revisor、Writer、Publisher 和人工监督，并自行完成规划、并行子主题、复核、修订和发布。[官方 LangGraph 文档](https://docs.gptr.dev/docs/gpt-researcher/multi_agents/langgraph) 这与 AO 的专家/DAG/acceptance/返工/最终综合几乎逐层重叠。

默认叠加会产生：

- AO 专家内部再出现一套不可见的专家团队；
- AO acceptance 与 GPTR Reviewer/Revisor 重复；
- 两层并行相乘，难以控制速率、成本和取消；
- 前端无法清楚解释“哪个专家、哪次审核、哪层失败”；
- AO 完整 systemPrompt 可能被 GPTR 内层角色稀释。

若未来需要对比实验，应把它作为独立 `researchEngine=ao_gptr_multiagent` 模式，限定只运行一个 AO 顶层节点，并单独评估质量、成本、耗时和可解释性，不能替换默认路径。

## 推荐的适配协议

扩展 researcher service 时，建议保持一个稳定请求合同，而不是让 TypeScript 后端直接操纵 GPTR 环境变量：

```yaml
expert:
  rolePath: string
  systemPrompt: string
  skills: [string]
task:
  query: string
  acceptance: string?
research:
  profile: standard | deep | detailed
  sourceMode: web | local | hybrid | urls | mcp
  sourceUrls: [url]
  complementSources: boolean
  domains: [domain]
  retrievers: [duckduckgo, mcp]
  scraperPolicy: static_then_dynamic
  curateSources: boolean
  deep: {breadth, depth, concurrency}
  mcpProfileIds: [string]
limits:
  timeoutMs: number
  maxSources: number
  maxCost: number?
```

响应至少包括 `report`、`evidenceBundle`、`events`、`cost/stepCosts`、`warnings` 和可重试错误分类。

当前服务通过 `os.environ` 切换 retriever、LLM 和 embedding endpoint；在 AO 开启并行步骤后存在进程级配置竞争风险。优先改为 GPTR 的 task-scoped `config_path`/构造参数；仍只能读环境变量的 endpoint 应通过配置锁或按配置隔离的 worker 进程处理。否则在添加能力前，不应提高 AO 并发。

## 建议实施里程碑

1. **研究 profile + 配置快照**：先开放 standard/deep，固定安全上限。
2. **证据与指标**：evidence bundle、source curation 开关、step costs、deep progress。
3. **来源控制**：URL/域名、retriever 组合、scraper fallback。
4. **控制面闭环**：真正的运行时 human_input/approval、checkpoint、局部 resume/from/feedback。
5. **知识接入**：任务隔离上传、local/hybrid；随后是管理员托管 MCP。
6. **质量闭环**：根据 AO verification.failed 做一次定向补研，并保持 warning 语义。
7. **高级交付**：最终节点 DetailedReport、来源图片，再评估 AI 插图。

第一阶段完成后，平台已经不只是“让多个专家分别调用 Web 搜索”，而是由 AO 保持可解释的组织结构，由 GPTR 为每个专家提供可配置、可追踪、可审计的深度研究能力。
