# Docker Compose 部署

该部署由四个容器组成：

- `thinktank-web`：Nginx 托管前端，并把 API 和流式请求反向代理到 API 容器。
- `thinktank-api`：任务编排、登录、设置、SQLite 和报告接口，仅在 Docker 内网开放。
- `thinktank-researcher`：GPT Researcher 与文档导出，仅在 Docker 内网开放。
- `thinktank-searxng`：SearXNG 聚合搜索服务，仅在 Docker 内网开放，向 Researcher 提供 JSON 搜索接口。
- `thinktank-mcp`：远程 Streamable HTTP MCP，对外开放下载接口。

所有容器都加入 `thinktank_network`。宿主机仅映射前端 `5173` 和 MCP `7010`，不使用 Docker named volume，运行数据全部保存在 `docker/data`。

前端宿主机端口可通过 `WEB_PORT` 覆盖；例如 Windows 保留 `5173` 时，可使用 `WEB_PORT=5800`。

MCP 默认关闭 Uvicorn HTTP 访问日志，因为 MCP 鉴权密钥位于连接 URL 的查询参数中。应用自身的启动、错误和工具调用日志仍会正常输出。

## 1. 准备配置

在项目根目录执行：

```powershell
Copy-Item docker\data\config\runtime\runtime.env.example docker\data\config\runtime\runtime.env
Copy-Item docker\data\config\api\api.env.example docker\data\config\api\api.env
Copy-Item docker\data\config\mcp\mcp.env.example docker\data\config\mcp\mcp.env
Copy-Item docker\data\config\searxng\searxng.env.example docker\data\config\searxng\searxng.env
```

Linux 服务器执行：

```bash
cp docker/data/config/runtime/runtime.env.example docker/data/config/runtime/runtime.env
cp docker/data/config/api/api.env.example docker/data/config/api/api.env
cp docker/data/config/mcp/mcp.env.example docker/data/config/mcp/mcp.env
cp docker/data/config/searxng/searxng.env.example docker/data/config/searxng/searxng.env
```

编辑四个新文件并替换 `change-me` 占位值。必须保证：

```text
api.env:ORCHESTRATOR_SERVICE_API_KEY
    =
mcp.env:THINK_TANK_SERVICE_API_KEY
```

`MCP_PUBLIC_BASE_URL` 必须是远程 Agent 能访问的地址。默认保留为 `http://10.9.0.106:7010`，部署服务器地址变化时需要同步修改。

`runtime.env` 默认启用 `searx,duckduckgo`，其中 `SEARX_URL` 必须保留为
`http://thinktank-searxng:8080`。SearXNG 的 `settings.yml` 已启用 JSON
格式，供 GPT Researcher 调用；该容器没有宿主机端口映射，不能从外网直接访问。
`searxng.env` 中的 `SEARXNG_SECRET` 是 SearXNG 的服务密钥，应替换为随机长字符串。

实际 `.env` 文件不会被 Git 跟踪。不要把模型密钥、登录密码或 MCP 密钥写进 Compose 和 Dockerfile。

三个配置目录相互隔离。API 容器只挂载 `config/runtime`，因此可以保存设置页面提交的模型密钥，但无法读取 `mcp.env`。

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
docker pull docker.io/searxng/searxng:2026.8.14-094c33d40
docker compose -f docker\docker-compose.yaml build
docker compose -f docker\docker-compose.yaml up -d
docker compose -f docker\docker-compose.yaml ps
```

也可以使用一条命令完成构建和启动：

```powershell
docker compose -f docker\docker-compose.yaml up -d --build
```

首次构建会下载 Node、Python、Nginx、Playwright Chromium 以及项目依赖，Researcher 镜像会明显大于其他镜像。

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
Invoke-RestMethod http://127.0.0.1:5173/health
Invoke-RestMethod http://127.0.0.1:5173/ready
```

浏览器访问：

```text
http://部署服务器IP:5173
```

MCP 客户端连接：

```text
http://部署服务器IP:7010/mcp?api_key=<MCP_API_KEY>
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

清理镜像不会删除 `docker/data`。备份前建议先执行 `down`，再整体备份 `docker/data`。SQLite 文件位于 `docker/data/app/data/think-tank.sqlite`，不要在 API 运行时复制或由其他容器直接访问。
