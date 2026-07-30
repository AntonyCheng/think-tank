# TT-008 指定 URL、补充搜索与域名约束实施 Plan

## 状态

已实施并完成真实任务验收。URL-only 任务的终止综合步骤兼容问题已修复，自动化与真实研究链路均已验证。

## 真实任务回归

任务 `9809c2ac-87fa-421e-9076-c74d8a2707f4` 使用三条哈尔滨商业大学官网 URL，在 AO 自动推断终止汇总步骤为 `synthesis` 后，曾因继承 URL Source Grant 而被来源能力门控拒绝。修复后：

- 工作流解析允许综合步骤保留 URL 或域名 Source Grant；
- 综合步骤只消费依赖步骤的 Evidence Bundle；
- URL 读取器、Web 检索器和域名过滤器均不会在综合步骤中初始化；
- `deep + urls/domain filters` 仍保持禁用。

回归验证：Node `164/164`、Python `97/97`，typecheck、build 与自动化 acceptance 全部通过。

真实验收任务 `20091b98-1674-46bc-aee2-f78223385d98` 于 2026-07-30 完成：

- 三个标准研究步骤只使用任务授权的三个哈尔滨商业大学官网页面；
- 三个步骤共记录 9 条来源观测，规范化后为 3 个唯一来源；
- 终止综合步骤以 `synthesis` 运行，来源数为 0，只复用上游 Evidence Bundle；
- 最终报告包含 3 个引用，全部指向授权 URL，没有额外来源；
- 任务为 `completed_with_warnings`，警告仅来自同域名来源多样性低及跨步骤来源重复，不属于来源越权或综合步骤重复检索。

## 目标

在不修改 AO、GPTR 上游源码的前提下，为研究任务增加三种可执行来源策略：

- 仅使用 Web 搜索；
- 仅研究用户指定的 URL；
- 先研究指定 URL，再补充 Web 搜索。

Web 搜索可配置允许和排除域名。所有用户指定 URL 必须在 GPTR 使用前完成协议、DNS、目标地址、逐跳重定向、内容类型、响应大小和总资源预算校验，避免 SSRF 及不受控下载。最终证据、引用、实时来源计数和任务快照必须反映实际使用的规范化来源。

## 现状证据

- `ResearchProfile V1` 已定义 `source.mode: web | urls`、`urls`、可选 `web`、`includeDomains` 和 `excludeDomains`，TypeScript/Python 共享契约用例。
- 当前部署能力仍只开放 `web`，`domainFilters` 为 `false`；`GptrConnector` 对非 Web 来源直接报错。
- GPTR 0.16.0 原生构造参数包含 `source_urls`、`complement_source_urls` 和 `query_domains`。
- GPTR 的 URL 抓取不会满足本平台要求的私网地址、DNS 重绑定、逐跳重定向和总下载大小约束，不能把未经验证的用户 URL 直接传入。
- GPTR 标准研究会使用 `query_domains`，但递归深研创建子研究器时不会可靠传播指定 URL 和域名约束。
- `EvidenceBundle`、来源去重、引用规范化、质量指标和实时研究活动已经具备接收新来源的基础。

## 第一性原理决策

1. **来源限制是权限，不是提示词。** 用户限定的 URL 和域名形成任务级来源授权；AO 可以缩小范围，不能添加 URL、启用补充搜索或放宽域名。
2. **安全校验必须位于真实网络访问前。** TypeScript 负责结构和能力校验；Python 研究适配层是实际联网 seam，因此承担权威网络安全判断。
3. **验证与抓取必须是同一次受控访问。** 不采用“先探测、再让 GPTR 重新下载”的双请求方案，避免重定向变化、DNS 重绑定和大小限制失效。
4. **GPTR 接收已物化证据。** 指定 URL 由平台安全获取并转为带规范化 URL 的受限文本证据，再交给 GPTR 分析、策展和写作。
5. **Web 域名约束必须双重执行。** 既向 GPTR 传递 `query_domains`，又在检索结果进入抓取前按规范化主机名过滤，不能只依赖搜索语法。
6. **不虚构能力。** V1 只在 `standard` 模式开放指定 URL 和严格域名过滤；现有无约束 `deep + web` 保持可用。`deep + urls/domain filters` 在执行前给出稳定的能力错误。
7. **任务选项不污染部署设置。** URL 和域名属于本次任务，放在提交页的“本次研究设置”中；模型、端点和默认检索器继续留在系统设置。

## V1 能力矩阵

| 研究模式 | Web | Web + 域名约束 | 仅 URL | URL + Web |
|---|---:|---:|---:|---:|
| `standard` | 支持 | 支持 | 支持 | 支持 |
| `deep` | 保持现状 | 暂不支持 | 暂不支持 | 暂不支持 |
| `synthesis` | 保留授权但不搜索 | 保留授权但不执行 | 保留授权但不读取 | 保留授权但不读取或搜索 |

禁用组合返回稳定的 `profile_capability_disabled`，同时在 AO 可用能力描述中排除，避免先执行再失败。

`synthesis` 不属于来源获取组合：它可以继承任意已通过任务级校验的 Source Grant，但只消费依赖步骤已经持久化的 Evidence Bundle，不重新物化 URL 或执行 Web 检索。

## 深模块与接口

Python 新增 `source-access.py` 对应模块（实际文件使用 `source_access.py`）。它在一个小接口后隐藏 URL 规范化、域名匹配、DNS 固定、HTTP 访问、重定向、流式限额和正文提取：

```py
materialized = await materializer.materialize(
    urls=profile.source.urls,
    limits=url_access_limits,
)
```

返回不可变结果：

```py
class MaterializedSource:
    requested_url: str
    canonical_url: str
    title: str
    media_type: str
    text: str
    byte_size: int
    redirect_chain: tuple[str, ...]

class MaterializedSourceSet:
    sources: tuple[MaterializedSource, ...]
    total_bytes: int
```

模块内部定义一个网络访问 port。生产使用受限 HTTP adapter，测试使用内存 adapter；调用方不接触 DNS、socket、重定向或响应流细节。失败统一返回稳定的 `SourceAccessError(code, url, message)`，不泄露服务器网络拓扑。

TypeScript 新增纯计算模块 `research-source-scope.ts`：

```ts
assertSourceScopeWithinTask(taskSource, stepSource): void
```

它负责判断 AO 步骤来源是否仍在任务授权范围内，不执行网络请求。

## 来源授权规则

- 任务为 URL-only 时，步骤只能使用任务 URL 的子集，不能添加 Web。
- 任务为 URL+Web 时，步骤可以减少 URL、关闭补充搜索或进一步缩小域名。
- 任务为受限 Web 时，步骤 `includeDomains` 必须是任务允许域的子集，`excludeDomains` 只能保持或扩大。
- 任务为无约束 Web 时，AO 可以增加域名限制，但不能凭空生成指定 URL。
- URL 比较使用规范化结果；域名匹配只接受主机名本身或其真实子域，例如 `news.example.com` 匹配 `example.com`，`example.com.evil.test` 不匹配。
- 违反授权范围视为非法 AO 工作流，沿用现有的一次重新编排；第二次仍非法才终止任务。

## URL 安全策略

V1 固定执行以下规则：

- 只接受绝对 `http`/`https` URL；
- 拒绝用户信息、空主机、非法端口和 URL 片段，默认只允许 80/443；
- 规范化 IDNA 主机名、默认端口、路径和片段后去重；
- 拒绝 localhost、`.local`、未指定、回环、私网、链路本地、组播、保留地址和云元数据目标；
- DNS 的全部 A/AAAA 结果都必须为公共地址；连接使用本次已验证解析结果，避免校验后重新解析；
- 最多跟随 5 次重定向，每一跳重新执行协议、域名和地址校验；
- 连接后核对实际对端地址；
- 不继承进程级 HTTP 代理；受管代理能力不属于 V1；
- 每个响应最多 5 MiB，单次研究指定来源总量最多 20 MiB，并发抓取最多 4 个；
- 连接超时 10 秒、单 URL 总超时 30 秒；
- 流式读取同时检查 `Content-Length` 和实际解压后字节数；
- V1 支持 HTML、纯文本和 PDF；其他下载格式留给 TT-011；
- 解析后的单来源正文再次限制字符数，防止小体积压缩内容造成模型上下文膨胀。

安全拒绝导致当前研究运行失败；普通网络不可达可记录为来源警告。URL-only 在没有任何可用来源时失败，URL+Web 可继续搜索但最终进入证据质量警告。

## GPTR 映射

### URL-only

1. 安全物化全部指定 URL；
2. 把标题、规范化 URL 和受限正文渲染为 GPTR 外部研究上下文；
3. 将来源写入 GPTR 的 `research_sources`，使现有证据捕获与引用链继续工作；
4. 不调用 Web 检索，直接由 GPTR 基于外部上下文写作。

### URL + Web

1. 先安全物化指定 URL；
2. 使用当前检索器执行标准 Web 研究，并应用域名过滤；
3. 合并指定来源与 GPTR Web 上下文；
4. 调用一次 `write_report(ext_context=...)`，避免两份报告再拼接。

### Web 域名约束

`includeDomains` 映射到 GPTR `query_domains`，同时由检索结果过滤 adapter 强制校验。`excludeDomains` 只在过滤 adapter 执行。被过滤 URL 不进入抓取、实时来源计数、Evidence Bundle 或引用列表。

## API、任务快照与前端

`POST /api/tasks` 继续使用已有可选 `researchProfile`，不增加平行字段。提交时开放：

```json
{
  "source": {
    "mode": "urls",
    "urls": ["https://example.com/report"],
    "web": {
      "retrievers": ["duckduckgo"],
      "includeDomains": ["example.com"]
    }
  }
}
```

任务提交页增加折叠的“本次研究设置”：

- 来源方式：Web、仅指定 URL、指定 URL + Web；
- URL 文本区：每行一个；
- 允许域名与排除域名；
- 字段随来源方式显示，并提供数量及格式提示。

前端只做即时格式提示，服务端始终重新校验。提交后的完整 Profile 和能力快照继续持久化，恢复任务时不允许修改。

## 可观测性与证据

新增白名单研究活动：

- 正在验证指定来源；
- 指定来源验证完成；
- 正在读取指定来源（x/y）；
- 指定来源不可用；
- 开始补充网页搜索；
- 域名规则已过滤若干候选来源。

公开事件只包含规范化 URL、计数和安全错误码，不包含解析 IP、响应头或正文。实际采用的指定来源进入 `EvidenceBundle`，来源类型标记为 `specified_url`；补充搜索保持 `web`。重定向后的 canonical URL 用于去重和最终引用，请求 URL 与重定向链只保留在受限证据元数据中。

## TDD 实施顺序

1. **跨语言契约测试**：开放 `urls` 和域名过滤；默认 `standard + web` 不变；禁用组合错误稳定。
2. **来源授权测试**：AO 只能缩小 URL/域名范围，不能放宽任务来源权限。
3. **纯 URL 规则测试**：协议、用户信息、端口、IDNA、规范化去重及精确域名匹配。
4. **网络安全测试**：IPv4/IPv6 私网、localhost、云元数据、混合 DNS、DNS 重绑定和实际对端校验。
5. **重定向测试**：公共地址跳内网、循环、超限和 canonical URL。
6. **资源限制测试**：`Content-Length`、分块传输、解压后超限、总量、超时、并发和不支持的 MIME。
7. **GPTR adapter 测试**：URL-only 不调用检索；URL+Web 只写一份报告；指定来源进入 `research_sources`。
8. **域名检索测试**：允许/排除规则在抓取前生效，恶意相似域名不能绕过。
9. **证据与遥测测试**：来源类型、canonical URL、实时计数、质量警告和引用均准确。
10. **任务与前端测试**：API 快照、AO 步骤映射、条件字段、提交负载和错误呈现。
11. **完整回归**：Node、Python、typecheck、build、acceptance 全部通过。
12. **人工验收**：分别运行 Web、URL-only、URL+Web，并用公共 URL 重定向、无效域名和超大响应验证失败路径。
13. **综合回归**：URL-only、URL+Web 或域名约束任务的终止汇总步骤保留 Source Grant，但不重新读取或检索来源。

## 预计文件

- 新增 `services/researcher/app/source_access.py`
- 新增 `services/researcher/test/test_source_access.py`
- 新增 `apps/orchestrator/src/research-source-scope.ts`
- 新增 `apps/orchestrator/test/research-source-scope.test.ts`
- 修改两端 `research_profile`、能力声明及共享契约用例
- 修改 `gptr-connector.ts`、Python `contracts.py`、`research_policy.py`、`research_worker.py`
- 修改证据捕获、研究活动投影及相关测试
- 修改 `apps/web/public/index.html`、`app.js`、`styles.css`
- 更新 `CONTEXT.md`、Research Profile 和来源安全架构文档

## 范围与非目标

本项不实现本地文件上传、Office 文档、压缩包、受管代理、登录态网页、Cookie/自定义认证头、JavaScript 浏览器抓取、Firecrawl、站点递归爬取、多检索器、deep 模式下的严格来源约束或任意服务器文件路径。这些分别属于 TT-009、TT-010、TT-011 及后续能力。

## 验收标准

- 默认任务仍执行现有 `standard + web + DuckDuckGo`；
- API 和前端均可提交 URL-only、URL+Web 及域名规则；
- URL-only 不发生 Web 搜索，URL+Web 同时使用指定来源和补充来源；
- 用户 URL 在一次受控访问中完成 DNS、重定向、对端地址和大小限制；
- 私网、回环、云元数据、危险重定向及超大响应均被稳定拒绝；
- AO 不能添加未授权 URL、开启未授权搜索或放宽域名；
- 域名外结果在抓取前被过滤，且不进入来源计数、证据或引用；
- 指定来源带 `specified_url` 类型进入 Evidence Bundle，最终引用使用 canonical URL；
- 不安全信息和网页正文不会进入公开事件或错误消息；
- Node、Python 和完整自动化验收全部通过。

## 回滚

能力开放是附加式变更。回滚时把部署能力恢复为 `sourceModes: ["web"]`、`domainFilters: false`，隐藏前端任务来源设置，并停止调用安全来源物化模块；已保存的 URL 任务快照仍可读取，但在重新执行时返回能力未启用，不需要迁移或删除历史任务。
