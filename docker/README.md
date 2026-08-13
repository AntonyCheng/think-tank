# Docker Compose 部署

该部署由四个容器组成：

- `thinktank-web`：Nginx 托管前端，并把 API 和流式请求反向代理到 API 容器。
- `thinktank-api`：任务编排、登录、设置、SQLite 和报告接口，仅在 Docker 内网开放。
- `thinktank-researcher`：GPT Researcher 与文档导出，仅在 Docker 内网开放。
- `thinktank-mcp`：远程 Streamable HTTP MCP，对外开放下载接口。

所有容器都加入 `thinktank_network`。宿主机仅映射前端 `5173` 和 MCP `7010`，不使用 Docker named volume，运行数据全部保存在 `docker/data`。

MCP 默认关闭 Uvicorn HTTP 访问日志，因为 MCP 鉴权密钥位于连接 URL 的查询参数中。应用自身的启动、错误和工具调用日志仍会正常输出。

## 1. 准备配置

在项目根目录执行：

```powershell
Copy-Item docker\data\config\runtime\runtime.env.example docker\data\config\runtime\runtime.env
Copy-Item docker\data\config\api\api.env.example docker\data\config\api\api.env
Copy-Item docker\data\config\mcp\mcp.env.example docker\data\config\mcp\mcp.env
```

Linux 服务器执行：

```bash
cp docker/data/config/runtime/runtime.env.example docker/data/config/runtime/runtime.env
cp docker/data/config/api/api.env.example docker/data/config/api/api.env
cp docker/data/config/mcp/mcp.env.example docker/data/config/mcp/mcp.env
```

编辑三个新文件并替换 `change-me` 占位值。必须保证：

```text
api.env:ORCHESTRATOR_SERVICE_API_KEY
    =
mcp.env:THINK_TANK_SERVICE_API_KEY
```

`MCP_PUBLIC_BASE_URL` 必须是远程 Agent 能访问的地址。默认保留为 `http://10.9.0.106:7010`，部署服务器地址变化时需要同步修改。

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
docker compose -f docker\docker-compose.yaml build
docker compose -f docker\docker-compose.yaml up -d
docker compose -f docker\docker-compose.yaml ps
```

也可以使用一条命令完成构建和启动：

```powershell
docker compose -f docker\docker-compose.yaml up -d --build
```

首次构建会下载 Node、Python、Nginx、Playwright Chromium 以及项目依赖，Researcher 镜像会明显大于其他镜像。

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
