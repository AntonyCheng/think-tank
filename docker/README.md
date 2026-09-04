# Docker Compose 部署

该部署由七个容器组成：

- `thinktank-web`：Nginx 托管前端，并把 API 和流式请求反向代理到 API 容器。
- `thinktank-api`：任务编排、登录、设置和报告接口，仅在 Docker 内网开放。
- `thinktank-postgres`：平台唯一运行时数据库，仅在 Docker 内网开放，数据绑定挂载到 `docker/data/postgres`。
- `thinktank-researcher`：GPT Researcher 与文档导出，仅在 Docker 内网开放。
- `thinktank-ocr`：PaddleOCR PP-OCRv5 中文识别 sidecar，仅在 Docker 内网开放；Researcher 遇到扫描件 PDF 或图片时调用。模型首次使用时下载到绑定卷 `docker/data/ocr-models`，之后离线加载。
- `thinktank-searxng`：SearXNG 聚合搜索服务，向 Researcher 提供 JSON 搜索接口，并可选择映射宿主机端口供外部调试或检索使用。
- `thinktank-mcp`：远程 Streamable HTTP MCP，对外开放下载接口。

所有容器都加入 `thinktank_network`。宿主机映射前端（默认 `7168`）、MCP（默认 `7169`）和 SearXNG（默认 `7170`），不使用 Docker named volume，运行数据全部保存在 `docker/data`。

`thinktank-ocr` 首次启动会在后台预热并下载 PP-OCRv5 中文 mobile 模型（约几十 MB）到 `docker/data/ocr-models`。识别置信度过低时会自动升级到 server 精度模型（会额外下载一次）。设置 `OCR_WARMUP=false` 可跳过预热。跨机迁移时一并迁移 `docker/data/ocr-models` 即可免去重新下载。

前端宿主机端口可通过 `WEB_PORT` 覆盖；例如 Windows 保留 `5173` 时，可使用 `WEB_PORT=5800`。
MCP 宿主机端口可通过 `MCP_PUBLIC_PORT` 覆盖；容器内部服务端口始终为 `7010`。
SearXNG 宿主机端口可通过 `SEARXNG_PUBLIC_PORT` 覆盖；容器内部服务端口始终为 `8080`。当前 SearXNG 未配置额外鉴权，应仅在可信网络中暴露该端口。

MCP 默认关闭 Uvicorn HTTP 访问日志，因为 MCP 鉴权密钥位于连接 URL 的查询参数中。应用自身的启动、错误和工具调用日志仍会正常输出。

---

## 0. Linux 全新服务器部署（线性步骤，供自动化代理直接执行）

> 目标：在一台干净的 Linux 服务器上，从零把 `master` 分支跑起来。所有命令在**仓库根目录**执行（含 `docker/`、`apps/`、`services/` 的那一层）。Windows 开发机看第 1 节之后的 PowerShell 版本。

### 0.1 前置条件

- Docker Engine ≥ 24 + Docker Compose v2（`docker compose version` 能输出）、BuildKit 默认开启。
- 可用内存 ≥ 8 GB，磁盘 ≥ 25 GB（Researcher 镜像含 Playwright Chromium，约 2–3 GB；OCR 模型和构建缓存另算）。
- **网络连通性**——容器需要能访问：
  1. 一个 **OpenAI 兼容的大模型服务**（编排/研究/写作用）和一个 **OpenAI 兼容的向量模型服务**（来源相关性过滤、GPTR 记忆用）。这两个是硬依赖，没有平台无法工作。
  2. 出站互联网：SearXNG 抓取搜索结果、Researcher 抓取来源网页、可选的 Tavily。
  3. 构建期：`docker.io`、`mcr.microsoft.com/playwright`、以及 pip / npm 镜像源（默认阿里云 + npmmirror）。基础镜像慢或被墙时，给 Docker daemon 配镜像加速器。

### 0.2 拉取代码

```bash
git clone https://github.com/AntonyCheng/think-tank.git
cd think-tank
git checkout master
```

### 0.3 生成配置文件

```bash
cp docker/data/config/runtime/runtime.env.example  docker/data/config/runtime/runtime.env
cp docker/data/config/api/api.env.example          docker/data/config/api/api.env
cp docker/data/config/mcp/mcp.env.example          docker/data/config/mcp/mcp.env
cp docker/data/config/searxng/searxng.env.example  docker/data/config/searxng/searxng.env
cp docker/data/config/postgres/postgres.env.example docker/data/config/postgres/postgres.env
```

### 0.4 必填项（`up` 之前必须改掉，否则启动即失败或无法登录/研究）

| 文件 | 键 | 说明 |
|---|---|---|
| `postgres.env` | `POSTGRES_PASSWORD` | 长随机串。 |
| `api.env` | `APP_AUTH_USERNAME` / `APP_AUTH_PASSWORD` | 后台管理员账号，用于登录设置页。 |
| `api.env` | `ORCHESTRATOR_SERVICE_API_KEY` | 长随机串。**必须与 `mcp.env` 的 `THINK_TANK_SERVICE_API_KEY` 完全一致。** |
| `mcp.env` | `THINK_TANK_SERVICE_API_KEY` | 同上，两处相等。 |
| `mcp.env` | `MCP_API_KEY` | 远程 Agent 连 MCP 用的密钥，长随机串。 |
| `mcp.env` | `MCP_PUBLIC_BASE_URL` | 改成 `http://<服务器公网IP或域名>:7169`（用 `MCP_PUBLIC_PORT` 的实际值）。 |
| `searxng.env` | `SEARXNG_SECRET` | 长随机串。 |
| `runtime.env` | `OPENAI_BASE_URL` / `OPENAI_API_KEY` | 大模型服务地址（OpenAI 兼容，通常以 `/v1` 结尾）和密钥。**从容器内可达**——若是内网网关，确认 Docker 网络能路由到该 IP。 |
| `runtime.env` | `AO_PLANNER_MODEL` / `AO_VERIFIER_MODEL` / `GPTR_FAST_LLM` / `GPTR_SMART_LLM` | 四个大模型角色的模型名（可以都填同一个）。`GPTR_SMART_LLM` 同时用作 deep 模式的 `STRATEGIC_LLM`。 |
| `runtime.env` | `GPTR_EMBEDDING_BASE_URL` / `GPTR_EMBEDDING_API_KEY` / `GPTR_EMBEDDING` | 向量模型服务。`GPTR_EMBEDDING` 形如 `custom:<模型名>` 或直接 `<模型名>`。**不要和大模型用同一个密钥**。 |

> 这些也可以先随便填能通的值，启动后用管理员账号登录设置页在线改（会写回 `runtime.env`，无需重启）。但 `runtime.env` 里的 LLM/向量配置是"冷启动兜底"，建议一开始就填对。

### 0.5 按环境调整（可选，但强烈建议先判断）

- **服务器在中国大陆**：`runtime.env` 保持默认 `GPTR_ENABLED_RETRIEVERS=searx,tavily`、`RETRIEVER=searx`。`searxng/settings.yml` 已配好境内可直连引擎（360search / quark / bing）。若 `api.tavily.com` 连不通，把 `tavily` 从 `GPTR_ENABLED_RETRIEVERS` 去掉。
- **服务器能出海**：可在 `GPTR_ENABLED_RETRIEVERS` 加回 `duckduckgo`，并给 `searxng/settings.yml` 换成 `google` / `duckduckgo` / `bing` 等引擎。
- **LLM 网关会缓冲整段响应再返回**（很多自建 new-api / one-api 网关如此）：编排提示词很大，首个 token 可能超过默认 90 秒的"流式停顿"看门狗，表现为任务在"匹配专家能力"阶段失败、诊断信息为 `stream stalled: provider 90s 内未返回任何内容`。此时在 `runtime.env` 设 `AO_STREAM_STALL_MS=240000`。
- **出站需要走代理**：`runtime.env` 设 `GPTR_SOURCE_HTTP_PROXY=http://host:port`（只作用于来源抓取与浏览器兜底，SSRF 预检仍生效）。

### 0.6 构建并启动

```bash
docker compose -f docker/docker-compose.yaml config          # 校验 compose + env，报错先解决
docker compose -f docker/docker-compose.yaml up -d --build    # 首次构建 10–25 分钟，取决于网络
```

### 0.7 等待就绪（不要只看 `Up`）

```bash
docker compose -f docker/docker-compose.yaml ps               # 等 api / researcher / postgres / web 都是 healthy
curl -fsS http://127.0.0.1:7168/health                        # API 进程起来了
curl -fsS http://127.0.0.1:7168/ready                         # researcher + DB + 运行配置都就绪
```

`/ready` 返回成功前不要进行下一步。卡住时看日志：

```bash
docker compose -f docker/docker-compose.yaml logs --tail=200 thinktank-api thinktank-researcher thinktank-web
```

### 0.8 验证 LLM 与向量服务连通（关键，最常见的失败点）

用管理员账号登录 `http://<服务器IP>:7168` → 系统设置页 → 点"检测主模型" / "检测向量模型"。或不登录直接调接口（需要先拿到会话 Cookie，用浏览器更简单）。四个模型角色都应显示 `passed`。若失败：

- `timeout` / 连不上 → 容器无法路由到 `OPENAI_BASE_URL`（内网 IP / 防火墙 / DNS）。
- `401` / `invalid api key` → 密钥错或额度耗尽。
- 检测通过但研究任务卡住 → 见 0.5 的 `AO_STREAM_STALL_MS`。

### 0.9 冒烟测试（跑一个真实任务）

浏览器打开 `http://<服务器IP>:7168`，登录，输入一个简单可检索的题目（例如"2026 年钠离子电池主要厂商量产进展"），点"开始研究"。预期：

- 编排出 3–5 个专家 + 1 个综合步骤；
- researcher 日志出现 `Added source url to research: ...`（真实相关的网页）和 `🧹 SOURCE RELEVANCE: kept N, dropped M`；
- 几分钟后生成报告，正文数据点带 `[n]` 内联引用，末尾有"参考来源"章节。

若报告没有引用、或来源全是无关页面 → SearXNG 引擎在该地域不可用，检查 `docker compose logs thinktank-searxng` 并调整 `searxng/settings.yml`。

### 0.10 MCP 连通（如需接入远程 Agent）

```bash
curl -fsS "http://127.0.0.1:7169/mcp?api_key=<mcp.env 里的 MCP_API_KEY>" -H 'Accept: text/event-stream'
```

确认防火墙放行 `MCP_PUBLIC_PORT`（默认 7169），且 `MCP_PUBLIC_BASE_URL` 是外部可达地址。

### 0.11 后续更新代码

```bash
git pull
docker compose -f docker/docker-compose.yaml up -d --build
docker compose -f docker/docker-compose.yaml ps
```

源码打进镜像，**改了源码 / Dockerfile / 依赖必须 `--build`**，`docker compose restart` 不生效。只改 `docker/data/config/*.env` 通常不用重建（设置页保存的参数即时生效；改 `runtime.env` 里非设置页管理的键需要 `docker compose up -d` 重建对应容器）。**永远不要 `docker compose down -v`**，会连数据库一起删。

---

## 1. 准备配置

以下步骤适用于新机器首次部署。代码仓库只提供配置模板；真实的密钥、管理员密码、数据库密码、研究历史和导出文件均不提交到 Git。

从其他机器迁移时，请先从代码仓库拉取最新代码，再按需迁移备份的 `docker/data`。如果不需要迁移历史任务，只需保留仓库中的 `.gitkeep` 文件并重新创建下面的配置文件即可。

在项目根目录执行：

```powershell
Copy-Item docker\data\config\runtime\runtime.env.example docker\data\config\runtime\runtime.env
Copy-Item docker\data\config\api\api.env.example docker\data\config\api\api.env
Copy-Item docker\data\config\mcp\mcp.env.example docker\data\config\mcp\mcp.env
Copy-Item docker\data\config\searxng\searxng.env.example docker\data\config\searxng\searxng.env
Copy-Item docker\data\config\postgres\postgres.env.example docker\data\config\postgres\postgres.env
```

Linux 服务器执行：

```bash
cp docker/data/config/runtime/runtime.env.example docker/data/config/runtime/runtime.env
cp docker/data/config/api/api.env.example docker/data/config/api/api.env
cp docker/data/config/mcp/mcp.env.example docker/data/config/mcp/mcp.env
cp docker/data/config/searxng/searxng.env.example docker/data/config/searxng/searxng.env
cp docker/data/config/postgres/postgres.env.example docker/data/config/postgres/postgres.env
```

编辑五个新文件并替换 `change-me` 占位值。必须保证：

```text
api.env:ORCHESTRATOR_SERVICE_API_KEY
    =
mcp.env:THINK_TANK_SERVICE_API_KEY
```

`MCP_PUBLIC_BASE_URL` 必须是远程 Agent 能访问的地址，并使用 MCP 的宿主机映射端口（默认 `7169`）；部署服务器地址变化时需要同步修改。

**检索器（中国大陆部署）**：DuckDuckGo 与 Google 在境内均不可直连。默认配置为
`GPTR_ENABLED_RETRIEVERS=searx,tavily`，`RETRIEVER=searx`：

- **本地 SearXNG**（主检索器）：`settings.yml` 已改为只启用境内可直连的引擎
  （`360search` 稳定，`quark` 次之，`bing` 保留但 HTML 解析偶发失败）。baidu /
  sogou 对 SearXNG 请求会返验证码，已剔除。
- **Tavily**（可选）：`api.tavily.com`（境外，AWS，非 GFW 黑名单），填写
  `TAVILY_API_KEY` 后加入 `GPTR_ENABLED_RETRIEVERS`；境内可达性视网络而定。
- `SEARX_URL` 必须保留为 `http://thinktank-searxng:8080`；SearXNG 默认映射宿主机
  端口 `7170`，应仅在可信网络中暴露。`searxng.env` 中的 `SEARXNG_SECRET` 应替换为
  随机长字符串。
- 可出海的环境可把 `duckduckgo` 加回 `GPTR_ENABLED_RETRIEVERS`。

检索回的来源会按与研究主题的向量相似度过滤（用已配置的向量模型），剔除搜索引擎返回
的无关页面——深度研究会大量递归检索，没有这一层容易混入垃圾来源。
`GPTR_SOURCE_RELEVANCE_FILTER=0` 关闭，`GPTR_SOURCE_RELEVANCE_MIN_COSINE` 调阈值。

首次启动后，请使用 `api.env` 中的管理员账号登录系统设置页，检查主模型、备用模型、向量模型、检索器和并发参数。四类大模型角色（AO 编排、AO 验证、GPTR 快速、GPTR 深度）分别在主模型和可选备用模型中配置；向量模型始终独立运行，不参与主备切换。

模型服务仅接受 OpenAI 兼容协议。主模型与可选备用模型各自配置 AO 编排、AO 验证、
GPTR 快速和 GPTR 深度四个模型；向量模型独立配置且不参与主备切换。管理员在系统设置页
保存运行参数后，API 会写回 `runtime.env` 并立即应用到后续任务，无需重启容器。

设置页的“检测主模型”默认等待 30 秒。需要调整时，在 `runtime.env` 中配置
`MODEL_PREFLIGHT_TIMEOUT_MS`（单位：毫秒），然后重新创建 API 容器；该参数只影响设置页
的连通性检测，不影响研究任务和 GPTR 请求的超时。

如果部署环境需要通过出口代理访问外网，在 `runtime.env` 中配置
`GPTR_SOURCE_HTTP_PROXY=http://host:port`（仅作用于“指定 URL”来源的抓取与浏览器兜底，
不影响平台内部流量）。启用代理后，主机名与解析地址的 SSRF 预检仍然生效，仅放宽对最终
socket 对端 IP 的校验——因为此时对端是代理。

“指定 URL”来源命中脚本渲染页面（静态 HTML 正文过少或是前端框架空壳）时，会用一次性无头
浏览器补抓。为了让单页应用真正渲染出内容，浏览器允许加载其自身及公网 CDN 上的子资源；
每个跨域子资源主机都会先经过 SSRF 预检，解析到环回、链路本地或内网地址的主机一律拒绝。
若部署策略要求浏览器兜底只访问目标域名本身，在 `runtime.env` 中设置
`GPTR_SOURCE_BROWSER_ISOLATION=strict`。

默认情况下 AO 规划器会为开放式、需要逐层追问的专家步骤选择 deep 研究模式，边界清晰的
任务仍用 standard。要强制验证或压测 deep，可在 `runtime.env` 设
`GPTR_RESEARCH_FORCE_DEEP=1`（或 `2x1x1` 指定 breadth×depth×concurrency）：此后所有
纯 Web 专家步骤都走 deep，breadth/depth 仍受 `GPTR_DEEP_MAX_*` 约束；URL、本地文档、
混合来源的步骤不受影响。

实际 `.env` 文件不会被 Git 跟踪。不要把模型密钥、登录密码或 MCP 密钥写进 Compose 和 Dockerfile。

五个配置目录相互隔离。API 容器只读入 `api.env`、`postgres.env`，并挂载可写的
`config/runtime`，因此可以保存设置页面提交的运行参数，但无法读取 `mcp.env` 或
`searxng.env`。

## 2. 运行项目测试

**部署时可跳过本节**——直接构建镜像即可。以下面向改代码的场景。

TypeScript（orchestrator + web，需要本机 Node 20 + 已 `npm ci`）：

```bash
npm run typecheck
npm test
npm run build
```

Researcher（Python）测试跑在容器里，无需本机 venv：

```bash
docker build -f docker/Dockerfile.researcher -t thinktank-researcher:local .
docker run --rm \
  -v "$PWD/services/researcher:/work/services/researcher" \
  -v "$PWD/contracts:/work/contracts" \
  -w /work/services/researcher thinktank-researcher:local \
  sh -c 'pip install -q pytest; python -m pytest test -q \
    --deselect test/test_research_executor.py::test_closing_executor_during_research_reaps_worker_cleanly \
    --deselect test/test_research_executor.py::test_cancelling_research_reaps_the_worker_process'
```

（被 deselect 的两个 executor 测试会 fork 子进程，在慢文件挂载下偶发 flake，与业务逻辑无关。）

## 3. 检查、构建和启动

以下命令均在项目根目录执行：

```powershell
docker compose -f docker\docker-compose.yaml config
docker compose -f docker\docker-compose.yaml build
docker compose -f docker\docker-compose.yaml up -d
docker compose -f docker\docker-compose.yaml ps
```

也可以使用一条命令完成构建和启动：

```powershell
docker compose -f docker\docker-compose.yaml up -d --build
```

首次构建会下载 Node、Python、Nginx、Playwright Chromium 以及项目依赖，Researcher 镜像会明显大于其他镜像。

在 Linux 上将命令中的反斜杠路径改为正斜杠，例如 `docker/docker-compose.yaml`。部署更新时不需要提交或复制本机的 `node_modules`、`.venv`、`dist`、测试缓存等目录，Compose 构建会在镜像内安装依赖。

默认使用阿里云 PyPI 镜像和 npmmirror；BuildKit 会缓存 pip、npm 下载内容。后续依赖清单不变时 Docker 会直接复用镜像层；依赖发生变化时也会优先复用已下载的软件包。不要在日常更新时使用 `docker builder prune`，否则这些构建缓存会被清除。只有在阿里云镜像缺少依赖时，才在构建前显式设置 `PIP_EXTRA_INDEX_URL=https://pypi.org/simple` 作为兜底。

如需临时切换为官方源，可在当前终端覆盖构建参数后再构建：

Linux：

```bash
export PIP_INDEX_URL=https://pypi.org/simple
export NPM_CONFIG_REGISTRY=https://registry.npmjs.org
docker compose -f docker/docker-compose.yaml build
```

PowerShell：

```powershell
$env:PIP_INDEX_URL = "https://pypi.org/simple"
$env:NPM_CONFIG_REGISTRY = "https://registry.npmjs.org"
docker compose -f docker\docker-compose.yaml build
```

以上优化只加速项目依赖。`node`、`python`、`nginx` 和 `mcr.microsoft.com/playwright` 等基础镜像仍由对应镜像仓库下载；若基础镜像本身很慢，需要为服务器 Docker daemon 配置可信的镜像加速器，或将这些基础镜像同步到私有仓库。

查看日志：

```powershell
docker compose -f docker\docker-compose.yaml logs -f
```

也可以只查看某个服务：

```powershell
docker compose -f docker\docker-compose.yaml logs -f thinktank-api
docker compose -f docker\docker-compose.yaml logs -f thinktank-researcher
docker compose -f docker\docker-compose.yaml logs -f thinktank-mcp
```

## 4. 验证

```powershell
Invoke-RestMethod http://127.0.0.1:7168/health
Invoke-RestMethod http://127.0.0.1:7168/ready
```

`/health` 表示 API 进程已启动，`/ready` 还会检查 Researcher、数据库和必要的运行配置；新部署时应以 `/ready` 返回成功作为可以登录使用的判断依据。若首次启动较慢，可使用以下命令观察服务状态：

```powershell
docker compose -f docker\docker-compose.yaml ps
docker compose -f docker\docker-compose.yaml logs --tail=100 thinktank-api thinktank-researcher thinktank-web
```

浏览器访问：

```text
http://部署服务器IP:7168
```

MCP 客户端连接：

```text
http://部署服务器IP:7169/mcp?api_key=<MCP_API_KEY>
```

## 5. 停止与更新

停止容器但保留所有绑定挂载数据：

```powershell
docker compose -f docker\docker-compose.yaml down
```

代码更新后重新构建并启动：

```powershell
docker compose -f docker\docker-compose.yaml build
docker compose -f docker\docker-compose.yaml up -d
```

清理镜像不会删除 `docker/data`。备份前建议先执行 `down`，再整体备份 `docker/data`。

更新部署建议按以下顺序执行：

```powershell
git pull
docker compose -f docker\docker-compose.yaml config
docker compose -f docker\docker-compose.yaml up -d --build
docker compose -f docker\docker-compose.yaml ps
```

不要执行 `docker compose down -v`，否则可能删除数据库卷或造成不必要的数据清理；当前项目的研究历史和配置主要位于 `docker/data`，更新代码时应保留该目录。

## 6. 常见问题排查

| 症状 | 原因 / 处理 |
|---|---|
| 研究任务在"匹配专家能力/编排"阶段失败，诊断为 `stream stalled: provider 90s 内未返回任何内容（0 token）` | LLM 网关会先缓冲整段响应再吐，大提示词首 token 超过 90 秒被误判。`runtime.env` 设 `AO_STREAM_STALL_MS=240000`，`docker compose -f docker/docker-compose.yaml up -d thinktank-api` 重建。模型本身是否正常用设置页"检测主模型"确认（它用小提示词，不受此影响）。 |
| 设置页"检测主模型"超时或连不上 | 容器路由不到 `OPENAI_BASE_URL`。内网网关要确认 Docker 网络能到该 IP（`docker exec thinktank-api curl -s -o /dev/null -w '%{http_code}' <OPENAI_BASE_URL>/models`）；确认防火墙、DNS。 |
| 检测通过但研究报告没有内联引用、来源全是无关页面（如百科、论坛、考试题） | 搜索引擎在该地域不可用或被限流，检索层在裸奔。`docker compose -f docker/docker-compose.yaml logs thinktank-searxng` 看 `unresponsive_engines`；按 0.5 调 `searxng/settings.yml` 的引擎；相关性过滤（`GPTR_SOURCE_RELEVANCE_FILTER`）是兜底但不能凭空造出好来源。 |
| SearXNG 日志里 `bing: 解析错误` 或某引擎 `验证码` | 该引擎对 SearXNG 的抓取做了反爬。剔除它，保留能用的（境内首选 `360search`）。 |
| OCR 或首个"指定 URL"任务很慢 | `thinktank-ocr` 首次会下载 PP-OCRv5 模型，浏览器兜底首次会初始化 Playwright。属正常，后续变快。跨机迁移 `docker/data/ocr-models` 可免重下。 |
| 构建卡在拉取 `mcr.microsoft.com/playwright` 或 `node` / `python` 基础镜像 | 给服务器 Docker daemon 配 registry 镜像加速器，或把基础镜像同步到私有仓库。pip/npm 依赖默认走阿里云/npmmirror，通常不是瓶颈。 |
| `docker compose config` 报 env 相关错误 | 五个 `.env` 没从 `.example` 复制，或路径不对（必须在仓库根目录执行）。 |
| 前端能开但登录失败 | `api.env` 的 `APP_AUTH_USERNAME/PASSWORD` 还是占位值，或 `APP_COOKIE_SECURE=true` 但通过 HTTP（非 HTTPS）访问——HTTP 部署保持 `APP_COOKIE_SECURE=false`。 |
| MCP `curl` 返回 401 | URL 里的 `api_key` 和 `mcp.env` 的 `MCP_API_KEY` 不一致。 |
| 深度研究跑很久 | 正常。deep 模式递归检索，breadth×depth 越大越慢；`GPTR_DEEP_MAX_*` 控上限，`GPTR_RESEARCH_FORCE_DEEP` 留空让规划器自己判断。 |

## 跨机器交接与编程代理须知

另一台机器接手本项目时，建议把下面的约束直接作为部署前检查清单：

1. **运行环境**：安装 Docker Desktop 或 Docker Engine，并确认支持 Docker Compose v2、BuildKit 和至少 8 GB 可用内存。Researcher 镜像包含 Playwright Chromium，首次构建和启动会明显慢于其他服务。
2. **工作目录**：所有命令都在仓库根目录执行，也就是包含 `docker/`、`apps/` 和 `services/` 的目录。不要只复制 `docker/` 子目录，镜像构建需要整个仓库作为上下文。
3. **配置初始化**：首次部署必须从五个 `.env.example` 复制出真实 `.env` 文件，并替换所有 `change-me`。这些真实配置不会随 Git 代码同步，换机器时需要通过安全渠道重新配置或迁移备份。
4. **数据迁移**：需要保留历史任务、报告版本、用户和运行设置时，迁移完整的 `docker/data`；只部署新环境时可以只保留仓库中的 `.gitkeep`，再重新创建配置文件。迁移前先停止服务并备份目录。
5. **MCP 地址**：如果另一台机器要接入编程代理，必须把 `docker/data/config/mcp/mcp.env` 中的 `MCP_PUBLIC_BASE_URL` 改成代理实际可访问的服务器 IP 或域名，并确认防火墙放行 `MCP_PUBLIC_PORT`（默认 `7169`）。代理使用 `MCP_API_KEY`，不要把它写入代码、提交记录或聊天内容。
6. **端口规划**：浏览器访问 `WEB_PORT`（默认 `7168`），MCP 使用 `MCP_PUBLIC_PORT`（默认 `7169`）。`SEARXNG_PUBLIC_PORT`（默认 `7170`）只用于可信网络调试，公网部署不应直接暴露。
7. **代码更新方式**：源码和前端资源都打包进镜像，不能只执行 `docker compose restart`。编程代理修改代码后必须执行：

   ```bash
   git diff --check
   docker compose -f docker/docker-compose.yaml config
   docker compose -f docker/docker-compose.yaml up -d --build
   docker compose -f docker/docker-compose.yaml ps
   ```

   Windows PowerShell 将路径写成 `docker\docker-compose.yaml` 即可。只修改 `docker/data/config` 中的运行配置时，通常不需要重建镜像；修改 Compose、Dockerfile、依赖清单或源码时必须重建。
8. **启动判定**：不能只看容器显示 `Up`。应等待 `thinktank-api`、`thinktank-researcher`、`thinktank-postgres` 和 `thinktank-web` 均为 `healthy`，并验证：

   ```bash
   curl http://127.0.0.1:7168/health
   curl http://127.0.0.1:7168/ready
   ```

   `/health` 只代表 API 进程已启动；`/ready` 成功后才适合登录和执行研究任务。启动失败时优先查看 `docker compose -f docker/docker-compose.yaml logs --tail=200 thinktank-api thinktank-researcher thinktank-web`。
9. **数据库安全**：不要执行 `docker compose down -v`，不要删除 `docker/data/postgres`。PostgreSQL 不映射宿主机端口，数据由绑定目录保存；更新代码时保留该目录即可。需要停机时使用 `docker compose -f docker/docker-compose.yaml down`，它不会删除绑定数据。
10. **提交边界**：不要提交 `.env`、`docker/data` 中的真实配置和运行数据、模型密钥、MCP 密钥、导出文件、日志、`node_modules`、`.venv`、`dist` 或测试缓存。编程代理提交前应检查 `git status --short` 和 `git diff --check`，确认只包含源码、测试、文档和必要的模板/静态资源。

交接给编程代理时，可以直接提供以下信息：仓库根目录、浏览器地址（例如 `http://127.0.0.1:7168`）、MCP 地址（例如 `http://服务器地址:7169/mcp?api_key=...`）以及是否需要迁移 `docker/data`。不要提供任何真实密钥；代理应从模板和本机安全配置中完成部署。

## SQLite 到 PostgreSQL 升级

升级时先保留原有 `docker/data/app/data/think-tank.sqlite`，停止旧 API 写入后执行一次导入；新 API 不会再读取该文件。

```powershell
docker compose -f docker\docker-compose.yaml up -d thinktank-postgres
docker compose -f docker\docker-compose.yaml run --rm --no-deps thinktank-api node apps/orchestrator/dist/src/migrate-sqlite-to-postgres.js /app/.think-tank/data/think-tank.sqlite
docker compose -f docker\docker-compose.yaml up -d --build
```

导入命令会输出任务、事件、报告和运行时设置的记录数。确认新 API 可用且数据完整后，再手工删除旧 SQLite 文件及其 `-wal`、`-shm` 文件；这些文件不会被新服务挂载或读取。
