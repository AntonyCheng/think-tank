# Docker Compose 部署

该部署由六个容器组成：

- `thinktank-web`：Nginx 托管前端，并把 API 和流式请求反向代理到 API 容器。
- `thinktank-api`：任务编排、登录、设置和报告接口，仅在 Docker 内网开放。
- `thinktank-postgres`：平台唯一运行时数据库，仅在 Docker 内网开放，数据绑定挂载到 `docker/data/postgres`。
- `thinktank-researcher`：GPT Researcher 与文档导出，仅在 Docker 内网开放。
- `thinktank-searxng`：SearXNG 聚合搜索服务，向 Researcher 提供 JSON 搜索接口，并可选择映射宿主机端口供外部调试或检索使用。
- `thinktank-mcp`：远程 Streamable HTTP MCP，对外开放下载接口。

所有容器都加入 `thinktank_network`。宿主机映射前端（默认 `7168`）、MCP（默认 `7169`）和 SearXNG（默认 `7170`），不使用 Docker named volume，运行数据全部保存在 `docker/data`。

前端宿主机端口可通过 `WEB_PORT` 覆盖；例如 Windows 保留 `5173` 时，可使用 `WEB_PORT=5800`。
MCP 宿主机端口可通过 `MCP_PUBLIC_PORT` 覆盖；容器内部服务端口始终为 `7010`。
SearXNG 宿主机端口可通过 `SEARXNG_PUBLIC_PORT` 覆盖；容器内部服务端口始终为 `8080`。当前 SearXNG 未配置额外鉴权，应仅在可信网络中暴露该端口。

MCP 默认关闭 Uvicorn HTTP 访问日志，因为 MCP 鉴权密钥位于连接 URL 的查询参数中。应用自身的启动、错误和工具调用日志仍会正常输出。

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

`runtime.env` 默认启用 `duckduckgo`；如启用 `searxng`，其中 `SEARX_URL` 必须保留为
`http://thinktank-searxng:8080`。SearXNG 的 `settings.yml` 已启用 JSON
格式，供 GPT Researcher 调用；默认同时映射宿主机端口 `7170`，应仅在可信网络中暴露。
`searxng.env` 中的 `SEARXNG_SECRET` 是 SearXNG 的服务密钥，应替换为随机长字符串。

首次启动后，请使用 `api.env` 中的管理员账号登录系统设置页，检查主模型、备用模型、向量模型、检索器和并发参数。四类大模型角色（AO 编排、AO 验证、GPTR 快速、GPTR 深度）分别在主模型和可选备用模型中配置；向量模型始终独立运行，不参与主备切换。

模型服务仅接受 OpenAI 兼容协议。主模型与可选备用模型各自配置 AO 编排、AO 验证、
GPTR 快速和 GPTR 深度四个模型；向量模型独立配置且不参与主备切换。管理员在系统设置页
保存运行参数后，API 会写回 `runtime.env` 并立即应用到后续任务，无需重启容器。

设置页的“检测主模型”默认等待 30 秒。需要调整时，在 `runtime.env` 中配置
`MODEL_PREFLIGHT_TIMEOUT_MS`（单位：毫秒），然后重新创建 API 容器；该参数只影响设置页
的连通性检测，不影响研究任务和 GPTR 请求的超时。

实际 `.env` 文件不会被 Git 跟踪。不要把模型密钥、登录密码或 MCP 密钥写进 Compose 和 Dockerfile。

五个配置目录相互隔离。API 容器只读入 `api.env`、`postgres.env`，并挂载可写的
`config/runtime`，因此可以保存设置页面提交的运行参数，但无法读取 `mcp.env` 或
`searxng.env`。

## 2. 运行项目测试

以下命令不会启动 Docker，建议在构建镜像前执行：

```powershell
npm run typecheck
npm test
npm run build
Push-Location services\researcher
..\..\.venv\Scripts\python.exe -m pytest test -q
Pop-Location
```

需要完整验收时再执行：

```powershell
npm run test:acceptance
```

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
