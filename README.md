# Think Tank

AO 负责生成并执行专家工作流，GPT Researcher 负责普通专家节点的 Web
深度研究。两个上游项目均作为固定版本依赖使用，不修改其源码：

- `agency-orchestrator@0.12.1`
- `gpt-researcher==0.16.0`

## 当前可运行链路

```text
研究话题
  → AO composeWorkflow 生成 YAML
  → 合并任务 ResearchProfile 与 step.llm.params.think_tank，并完成能力预检
  → AO 校验并构建 DAG
  → AO 加载每个专家的完整 systemPrompt
  → 普通专家节点通过 HTTP 交给 GPTR，并以 agent/role 参数直接使用 AO 专家身份
  → AO 按 YAML 处理依赖、并发、条件、人工输入、审批、循环和验收
  → 根据 GPTR 实际返回的来源 URL 校验并规范化引用
  → 输出唯一终点节点的 Markdown
```

研究型工作流的唯一终点步骤必须声明 AO 原生 `acceptance:`。配置
`AO_VERIFIER_MODEL` 后，AO 会执行验收并按原生逻辑自动返工一次。返工后仍
未通过时，任务状态为 `completed_with_warnings`：最终报告照常交付，未满足
条目作为质量警告展示；只有真正的编排或研究执行错误才标记为 `failed`。
如果 GPTR 返工结果退化为“我接下来检查……”一类过程说明，或相较首版大幅
缩短并丢失主要章节，适配层会拒绝该返工并让 AO 保留首版完整报告；前端
时间线会明确记录这次回退。结构完整的正常返工不受影响。
编排时程序会明确要求 AO 将用户提出的内容、结构、篇幅、证据、来源和格式
限制写入最终步骤的 `acceptance:`。

AO 生成 YAML 后必须先通过完整执行预检，前端才会收到“专家工作流已生成”
事件。若首次结果包含悬空 `depends_on`、无效角色、非法终点或其他预检错误，
系统会把具体错误反馈给 AO 并自动重新编排一次；第二次仍无效才终止任务。

任务可提交可选的 `researchProfile`，AO 普通专家步骤可通过
`step.llm.params.think_tank` 覆盖其中一部分。优先级为“平台默认值 < 任务
设置 < 步骤覆盖”；完整配置在任务提交时冻结，并随工作流与每轮研究事件
  保存。当前开放 `standard | deep | synthesis + web + 单检索器`：
  standard 执行常规研究，deep 使用 GPTR 原生递归深研，synthesis 只综合
  AO 上游输出而不再次检索。deep 受任务级加权并发预算和部署递归工作量
  上限保护；未开放的多来源或多检索器会在任何研究调用前明确拒绝。

AO 已经完成专家选择，因此 researcher 服务会把完整 `systemPrompt` 作为
GPT Researcher 的 `role` 传入，同时提供固定 `agent` 名称。这会跳过 GPTR
自身的二次代理选择，避免两套专家身份互相覆盖。

## 本地配置

根目录 `.venv` 是唯一 Python 环境。复制配置模板并在本机填写，不要提交
API Key：

```powershell
Copy-Item .env.example .env
```

默认检索器是无需密钥的 DuckDuckGo。`AO_VERIFIER_MODEL` 可暂时留空；
留空时不执行 AO acceptance 自动核验。

`GPTR_EMBEDDING` 必须填写 OpenAI 兼容的向量模型，例如
`custom:m3e`。`GPTR_EMBEDDING_BASE_URL` 可指定独立的 OpenAI 兼容向量
服务地址；留空时回退到 `OPENAI_BASE_URL`。向量服务复用
`OPENAI_API_KEY` 调用 `/embeddings`，用于从抓取页面中筛选与研究问题最
相关的证据。`custom` 是 GPTR 对 OpenAI 兼容网关的适配模式，会保持输入
为字符串；若网关提供其他模型名，直接替换冒号后的名称。只填写模型名时
程序也会自动补为 `custom:模型名`。

## 启动第一次真实测试

提交版本前可运行完整自动化验收：

```powershell
npm run test:acceptance
```

自动化与真实链路的通过条件由同目录测试与 `npm run test:acceptance` 维护。

终端一启动 GPTR 服务：

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir services/researcher --host 127.0.0.1 --port 8010
```

终端二提交研究话题：

```powershell
npm run spike -- "要研究的话题"
```

生成的 AO YAML 保存在 `.think-tank/workflows/`。

## 任务 API

先启动 GPTR 服务，再启动 Node 任务 API：

```powershell
npm run api
```

默认监听 `http://127.0.0.1:3000`，可通过 `API_HOST` 修改监听地址、
通过 `API_PORT` 修改端口。局域网部署可设置
`API_HOST=0.0.0.0`，并通过服务器真实 IP 访问。
同一地址也直接提供最小研究前端；浏览器打开
`http://127.0.0.1:3000/` 即可提交话题并通过 SSE 查看执行时间线、来源数、
验收状态以及最终报告或失败原因。前端为零依赖静态资源，不需要单独启动
开发服务器。

```text
POST /api/tasks
  body: {
    "topic": "研究话题",
    "researchProfile": {
      "schemaVersion": 1,
      "limits": {
        "maxSearchResultsPerQuery": 5,
        "maxIterations": 4,
        "maxSubtopics": 3
      }
    }
  }
  researchProfile 可省略；省略时保持 standard + 当前 Web 检索器默认行为
  response: 202 + 任务快照

GET /api/tasks/:id
  response: queued/running/needs_input/canceling/canceled/completed/
            completed_with_warnings/failed
            状态与最终输出、质量警告或错误

GET /api/tasks/:id/events
  header: Last-Event-ID（可选）
  response: text/event-stream；仅续传游标之后的事件，再实时推送到任务终态

POST /api/tasks/:id/input
  body: { "answer": "用户对 AO 问题或审批的回答" }
  response: 202 + 已恢复执行的任务快照

POST /api/tasks/:id/cancel
  response: 202 + canceling/canceled 任务快照；重复取消保持幂等

GET /health
  response: API 进程存活状态，不检查外部依赖

GET /ready
  response: 配置、任务存储与 GPTR 适配器均就绪时返回 200

GET /api/settings
  response: 可在设置页编辑的非敏感运行配置；API Key 只返回是否已配置

PUT /api/settings
  body: 非敏感运行配置
  response: 持久化后的公开配置；只影响之后创建的新任务

GET /api/tasks/:id/export/markdown
GET /api/tasks/:id/export/docx
GET /api/tasks/:id/export/pdf
  response: 已完成报告的 Markdown、Word 或 PDF 下载文件
```

最终 Markdown 是所有交付格式的唯一内容源。DOCX 由 `python-docx` 直接
生成，PDF 由 ReportLab 直接生成；生产服务不调用 Microsoft Word 或
LibreOffice，也不执行 DOCX 到 PDF 的转换。PDF 是固定版式交付物，DOCX
是可编辑交付物，两者不承诺像素级一致；导出兼容性由
`.github/workflows/document-export-matrix.yml` 与对应测试维护。
PDF 固定嵌入项目资产中的 Noto Sans SC 字体，许可证随字体保存在
`services/researcher/assets/fonts/OFL.txt`，因此生成和中文文本抽取都不依赖
宿主操作系统字体。

报告正文中只有能够匹配到本次 GPTR 实际检索来源的 HTTP/HTTPS 链接才会
计入已验证引用，并在文末生成“已验证来源”。原链接已有项目名、平台名等
语义标签时会原样保留；只有 `^数字` 形式的链接会替换成可读的来源名称。
含数据段落缺少已验证来源时，报告仍会交付，但任务会显示引用质量警告。
历史任务在读取和重新导出时也会进行同样的幂等标签修复，无需迁移数据库。

第一版使用单进程任务队列，同一时间只运行一个顶层研究任务；AO 工作流内部
仍可按 YAML 并行执行专家步骤。任务快照、事件、报告与引用持久化到
`.think-tank/data/think-tank.sqlite`。API 重启后历史任务仍可读取；重启前
尚未结束的任务会明确标记为失败，不会自动重复研究。
浏览器刷新或 SSE 临时断线不会重新提交任务：前端保存当前任务 ID，并通过
任务快照与 `Last-Event-ID` 恢复时间线。设置保存到本地
`.think-tank/settings.json`，不会写回 `.env`。

运行中任务可以从页面或 `POST /api/tasks/:id/cancel` 取消。GPTR 流式请求会
立即接收取消信号；AO 0.12.1 未提供编排调用的中断参数，因此编排阶段会先
进入 `canceling`，待当前 AO 调用返回后终止后续执行。等待人工输入的时间不
计入任务执行预算。

## 本地验证

```powershell
npm test
npm run typecheck
npm run build
Set-Location services/researcher
..\..\.venv\Scripts\python.exe -m pytest test -q
```

## 已知上游兼容约束

GPTR 0.16.0 的 Windows 发布依赖存在两个上游问题：

- DuckDuckGo 检索器会导入 `ddgs`，但发布元数据没有声明该依赖，因此项目
  显式固定 `ddgs==9.14.4`。
- `litellm 1.93.0` 仅提供源码包且 Rust 元数据构建失败，因此固定到满足
  GPTR 声明范围且提供 wheel 的 `1.91.4`。
- GPTR wheel 中 `query_processing.py` 在导入类型名之前使用了运行时注解。
  本项目使用仅在首次导入期间生效的兼容垫片，不修改第三方源码。
