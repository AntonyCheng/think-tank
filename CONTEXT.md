# 智研AI助手

本上下文描述 AO 编排出的专家步骤如何获得研究策略，并由研究服务执行。它统一平台、编排产物和研究引擎之间的业务语言。

## Language

**Research Profile**:
一个专家步骤完整、不可变且可执行的研究策略，描述研究模式、来源策略、质量策略和资源边界。
_Avoid_: GPTR config, research settings, report config

**Research Profile Override**:
来自平台默认值、任务设置或专家步骤的部分研究意图，必须解析为 Research Profile 后才能执行。
_Avoid_: Profile, patch, config fragment

**Research Mode**:
平台定义的研究执行策略，目前规划为 standard、deep 和 synthesis；它不等同于 GPTR 的报告类型。
_Avoid_: Report type, agent type

**Source Policy**:
声明一次研究允许使用哪些来源以及如何获取这些来源的策略。
_Avoid_: Retriever config, search config

**Source Grant**:
任务提交时冻结的来源权限边界；AO 步骤可以减少 URL、关闭 Web 补充、减少检索器或收紧域名，但不能添加来源、启用未授权检索器或放宽限制。
综合步骤继续携带同一授权用于证据溯源，但不再次执行来源获取。
_Avoid_: Source suggestion, search hint

**Materialized Source**:
由研究服务在同一次受控网络访问中完成地址校验、下载限制和正文提取后形成的不可变公开证据。
_Avoid_: Scraped URL, validated link

**Domain Constraint**:
应用于 Web 检索结果的主机名允许/排除规则；匹配精确域名及其子域，排除规则优先。
_Avoid_: Search query suffix, site hint

**Research Capabilities**:
某次部署当前允许执行的研究模式、来源模式和检索器集合。
_Avoid_: Feature flags, GPTR capabilities

**Retriever Catalog**:
研究服务根据部署启用项、adapter 可导入性和必需凭据生成的只读检索器能力快照；它是设置页、任务校验和 AO Source Grant 的权威可用集合。
_Avoid_: Retriever list, frontend options

**Retriever Runtime**:
安装在 GPTR 原生检索器类外的请求级执行边界，负责共享结果预算、域名过滤、规范化 URL 去重、提供商超时、降级和结构化诊断。
_Avoid_: Search engine, custom retriever

**Research Limits**:
约束单次研究算法规模的边界，例如迭代、子主题和深研广度；不包含部署级并发或网络超时。
_Avoid_: Timeout config, worker limits, infrastructure limits

**Evidence Bundle**:
一次 GPTR 研究运行归属于一个 AO 步骤的版本化证据包，包含实际查询、来源、受限上下文、研究方式、时间和报告产物。
_Avoid_: Sources, raw GPTR response, citation list

**Evidence Ledger**:
单个研究任务内 Evidence Bundle 的唯一写入与读取入口，负责修订、依赖选择、公开来源投影和持久化快照。
_Avoid_: Source cache, report history

**Research Run**:
AO 某一步骤对 GPTR 的一次完整调用；同一步骤返工会产生新的 Research Run，而不会覆盖旧证据。
_Avoid_: AO step, task, retry

**Research Telemetry**:
单个研究任务中所有 Research Run 的结构化、可恢复运行视图，包含用户级阶段、耗时、来源数、深研层级和研究服务报告的成本估算。
_Avoid_: Progress log, trace, global percentage

**Research Activity**:
归属于一个 Research Run、经过白名单筛选、中文化、脱敏和去重的公开实时研究事件；可写入任务事件并通过 SSE 展示，但不等同于原始研究回调。
_Avoid_: Raw callback, diagnostic, execution node

**Research Diagnostic**:
与公开进度分离的受限原始研究事件，仅用于本地故障诊断；必须脱敏、限制大小和数量，且不进入 SSE 或任务快照。
_Avoid_: Timeline event, user progress, audit log
