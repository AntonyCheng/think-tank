# Think Tank V1 验收矩阵

本矩阵把 V1 核心需求分成自动化验收和真实链路验收。自动化测试负责
确定性契约；真实链路测试负责外部模型、网络和 AO 实际编排质量，二者不能
互相替代。

## 自动化验收

运行：

```powershell
npm run test:acceptance
```

| 编号 | 能力 | 通过条件 | 证据 |
| --- | --- | --- | --- |
| A01 | AO 专家编排 | 加载完整专家 systemPrompt，按 DAG 依赖执行 | `ao-runtime.test.ts` |
| A02 | AO YAML 安全 | 拒绝绕过 GPTR connector 的步骤级连接配置 | `ao-runtime.test.ts` |
| A03 | AO 原生输入 | 顶层 inputs、human_input、approval 均映射为可回答请求 | `ao-runtime.test.ts` |
| A04 | 任务状态机 | queued、running、needs_input、completed、warning、failed 可达且合法 | `research-tasks.test.ts` |
| A05 | 刷新恢复 | 快照可重读，SSE 按 Last-Event-ID 续传且不重复 | `research-tasks.test.ts`、`api-server.test.ts` |
| A06 | GPTR 流式观测 | GPTR event 先于 result 到达，Node 可处理跨 chunk NDJSON | `test_research.py`、`gptr-connector.test.ts` |
| A07 | 报告交付 | 验收警告不吞掉可用报告，失败与警告明确区分 | `research-tasks.test.ts`、`api-server.test.ts` |
| A08 | 报告清理 | 去除显式推理块和重复整篇报告，保留正常重复 | `test_research.py` |
| A09 | 引用链接 | 标题/编号引用转换为真实 HTTP(S) 来源，前端拒绝相对链接 | `test_research.py`、`api-server.test.ts` |
| A10 | 独立向量服务 | 向量 Base URL 仅在构造 embedding client 时生效，随后恢复 LLM URL | `test_research.py`、`settings.test.ts` |
| A11 | 设置安全 | 非敏感设置可更新，API Key 只返回 configured 布尔值 | `settings-store.test.ts`、`api-server.test.ts` |
| A12 | 构建质量 | Node/Python 测试、TypeScript 类型检查和构建全部通过 | `scripts/acceptance.mjs` |
| A13 | 持久化恢复 | SQLite 原子保存状态和事件；重启后保留终态并终止未完成任务 | `research-task-store.test.ts` |
| A14 | 取消与超时 | 运行、排队和等待输入任务可取消；主动执行预算耗尽后失败 | `research-tasks.test.ts`、`api-server.test.ts` |
| A15 | 就绪探针 | `/health` 仅检查存活，`/ready` 检查配置与 GPTR 适配器 | `api-server.test.ts`、`test_health.py` |
| A16 | AO 研究策略映射 | 任务配置与步骤覆盖确定性合并；非法能力在研究前拒绝；三个 GPTR 限额在并发 worker 间隔离 | `research-profile-mapping.test.ts`、`workflow-composer.test.ts`、`test_research_executor.py` |
| A17 | 多检索器执行 | 只公开已启用且就绪的 adapter；任务冻结检索器授权；结果预算共享；跨提供商 URL 去重；单提供商故障可降级 | `gptr-capabilities.test.ts`、`research-source-scope.test.ts`、`test_retriever_runtime.py`、`test_research.py` |

## 真实链路验收

| 编号 | 场景 | 操作 | 通过条件 |
| --- | --- | --- | --- |
| R01 | DuckDuckGo | 提交一个需要近期网页证据的中文研究题 | 时间线出现检索进展；最终来源数大于 0 |
| R02 | 专家库利用 | 检查生成 YAML 与执行时间线 | 专家来自 AO 库；执行使用完整 systemPrompt，不只是名称/task |
| R03 | 实时可观测 | 研究过程中保持页面打开 | 报告完成前持续出现 GPTR 进度，而非完成后一次性补齐 |
| R04 | 页面刷新 | 任务运行中刷新浏览器 | 自动恢复同一任务、历史时间线和后续事件，不重复提交 |
| R05 | AO 反问 | 提交信息明显不足、需要偏好或范围的题目 | 若 AO 生成 human_input，页面进入 needs_input；回答后继续同一任务 |
| R06 | 设置生效 | 在设置页修改非敏感配置后新建任务 | 新任务采用新配置；旧任务不被中途改写；API Key 不出现在页面响应 |
| R07 | 引用跳转 | 点击最终报告中的引用编号 | 新标签页打开外部 HTTP(S) 来源，不跳到 `127.0.0.1` |
| R08 | 质量警告 | 使用较严格的 acceptance 触发未完全通过 | 报告仍展示，同时明确列出警告，不显示为“任务未完成” |
| R09 | 步骤研究限额 | 通过 API 提交限额并检查 YAML、任务事件与 researcher 请求 | 任务快照和每个普通步骤记录完整 Profile；实际检索采用对应限额 |
| R10 | 多检索器研究 | 在设置页选择两个已就绪检索器后提交一个学术主题 | 任务快照保留两项授权；时间线显示提供商状态；来源实时增长且去重；单个提供商失败时报告可降级完成 |

真实链路验收要记录任务 ID、开始/结束时间、最终状态和失败截图。模型或网络
偶发失败应保留日志后重试一次；重复失败才判为该项不通过。
