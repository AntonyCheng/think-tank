# Source Access V1

TT-008 在不修改 GPTR 上游源码的前提下，为用户指定 URL 建立平台拥有的安全网络边界。`SourceMaterializer` 是唯一入口：它在一次受控请求链中完成校验、下载和正文提取，再把不可变的 Materialized Source 交给 GPTR。

## 安全不变量

- 只接受无用户信息、无片段、标准端口的绝对 HTTP(S) URL。
- 每一跳先解析 DNS；任一结果为私网、环回、链路本地、保留地址或非全局地址即拒绝。
- HTTP 连接使用固定解析结果，并核对实际对端 IP，避免 DNS 重绑定。
- 禁止自动重定向；最多手动跟随 5 跳，每一跳重新执行完整地址校验。
- 单响应解压后最多 5 MiB，任务指定来源合计最多 20 MiB，请求总超时 30 秒。
- HTML、纯文本和 PDF 在内存中提取；单来源正文最多 200,000 字符。脚本、样式和页面正文不会进入公开事件或错误。
- HTTP 客户端不读取系统代理、Cookie、认证头或登录态。

URL 规范化用于去重和最终引用。域名规则采用精确主机或子域匹配，排除优先；`example.com.evil.test` 不匹配 `example.com`。

## 失败语义

地址、对端、重定向和资源边界违规是硬失败。普通网络不可达、不支持的媒体类型或空正文会形成受限来源警告：URL-only 在没有任何可用来源时失败，URL+Web 则继续补充搜索并由证据质量层反映来源不足。跨进程错误保留稳定的 `code/path/message`，同时递归脱敏部署密钥。

## 执行映射

- URL-only：安全物化 → `add_research_sources` → `write_report(ext_context=...)`，不调用 Web 检索。
- URL+Web：安全物化 → 标准 Web 研究 → 合并上下文 → 单次写报告。
- Web 域名规则：同时传给 GPTR 的 `query_domains`，并包装检索器，在结果进入抓取前再次过滤。
- Synthesis：保留任务 Source Grant 用于溯源，但完全绕过本模块和 Web 检索，只消费上游 Evidence Bundle。

V1 不支持登录态网页、JavaScript 浏览器抓取、站点递归、非标准端口、本地文件或 deep 模式下的指定来源。
