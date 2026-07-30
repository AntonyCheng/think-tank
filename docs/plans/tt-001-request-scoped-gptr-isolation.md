# TT-001 请求级 GPTR 配置隔离实施 Plan

状态：已完成（2026-07-29）  
优先级：P0  
上游版本：Agency Orchestrator `0.12.1`、GPT Researcher `0.16.0`

## 1. 目标

让每次 GPTR 研究运行拥有独立、不可变的模型、向量模型和检索配置，避免并发专家之间发生端点、密钥、模型或检索器串线，同时：

- 不修改或复制 AO、GPTR 源码。
- 保持 `/research`、`/research/stream` 及 Node 端契约不变。
- 保留 GPTR 实时事件流和 AO 并行专家执行。
- 为 TT-002～TT-004 的动态研究配置和深研模式提供稳定执行基础。

## 2. 已确认的现状

当前 `services/researcher/app/main.py` 的 `run_research()` 会直接写入：

- `RETRIEVER`
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `FAST_LLM`
- `SMART_LLM`
- `STRATEGIC_LLM`
- `EMBEDDING`

构造 GPTR 的 Memory 时还会暂时把 `OPENAI_BASE_URL` 切换为向量端点。并发协程共享同一个 `os.environ`，所以任意一次 `await` 都可能让另一项研究读到错误配置。

本地安装的 GPTR 0.16.0 还存在以下约束：

- `Config` 从环境读取模型和检索器。
- OpenAI LLM provider 会在运行期间读取 `OPENAI_BASE_URL`。
- embedding、部分 retriever、scraper 和未来 MCP 能力也会直接读取环境。
- `deep_research.py` 的部分模型调用没有传递 `cfg.llm_kwargs`。

因此，仅使用 `config_path` 或只锁住 GPTR 构造阶段都不能完整隔离当前及后续研究路径。

## 3. 技术决策

采用**每次研究运行一个独立子进程**，并在 Windows、Linux、macOS 上统一使用 Python `multiprocessing` 的 `spawn` 上下文。

```text
AO 专家步骤
    │ HTTP/NDJSON
    ▼
FastAPI 父进程 ── ResearchExecutor 接口
    │                    │
    │              ProcessResearchExecutor
    │                    │ spawn + 私有环境
    │                    ▼
    │              GPTR 子进程
    │                    │
    └──── 事件/结果队列 ◀─┘
```

父进程只负责请求校验、进程生命周期和事件转发，永不为单次请求修改环境。子进程可以继续按 GPTR 原生方式使用环境变量；进程退出后配置和密钥随之释放。

### 方案取舍

不采用以下方案：

- **整次研究加 `asyncio.Lock`：** 能保证安全，但会把所有专家研究串行化，失去 AO DAG 并发价值。
- **请求级 JSON `config_path`：** GPTR 并非所有路径都只读 Config，深研和插件仍可能运行时读取环境。
- **替换或代理 `os.environ/os.getenv`：** 属于脆弱的全局 monkey patch，第三方依赖未必遵守，升级风险高。
- **修改 GPTR 源码增加 Config 注入：** 不符合项目约束，也增加上游升级维护成本。

## 4. 模块与接口

新增一个深模块，外部 seam 保持最小：

```python
class ResearchExecutor(Protocol):
    async def execute(
        self,
        request: ResearchRequest,
        publish: EventPublisher | None = None,
    ) -> ResearchResponse: ...

    async def close(self) -> None: ...
```

调用者只需知道输入、事件回调、结果、取消和错误语义。环境构造、进程通信、清理、异常映射和并发限制都隐藏在实现内。

生产 adapter 为 `ProcessResearchExecutor`；测试使用内存 fake adapter。两个 adapter 通过同一接口验证路由行为，不把进程细节暴露给 FastAPI endpoint。

### 进程消息协议

父子进程只传递可序列化字典：

- `event`：单个 `ResearchEvent`
- `result`：完整 `ResearchResponse`
- `error`：稳定错误类型、脱敏后的消息

必须恰好出现一个终止消息。子进程无终止消息退出时，父进程返回明确的 `502`，而不是无限等待。

## 5. 配置快照规则

父进程根据请求和服务启动时的基线环境生成不可变快照：

1. 请求显式值优先。
2. 请求未提供时使用启动基线。
3. URL 统一去除末尾 `/`。
4. `SMART_LLM` 同时赋给 `STRATEGIC_LLM`，保持当前行为。
5. 向量端点仅在子进程构造 Memory 时临时生效，之后恢复该子进程自己的 LLM 端点。
6. 未设置的受管变量在子进程中显式删除，防止继承到意外旧值。

首批受管变量为当前实际使用的七项；`TAVILY_API_KEY` 等服务级提供商凭据仍从启动环境继承。后续 TT-002/TT-009 再把提供商能力纳入版本化配置。

快照不得被写入日志、事件、任务状态或临时文件。密钥通过进程启动管道传递，不放在命令行参数中。

## 6. 进程生命周期与资源策略

- 统一使用 `multiprocessing.get_context("spawn")`，不依赖 Unix `fork`。
- 子进程不能设为 daemon，避免阻断未来浏览器或 MCP 子进程。
- 通过 `GPTR_WORKER_CONCURRENCY` 控制同时运行的 GPTR 子进程，默认 `2`。
- 排队等待不占用子进程；开始运行后沿用现有 Node 端研究超时。
- 请求取消、流连接断开、服务关闭时，先发起取消，再终止并回收子进程。
- 所有路径关闭 Queue/Pipe 并 `join`，防止 Windows 句柄泄漏和 Linux 僵尸进程。
- 单次进程启动开销可接受：研究本身通常以分钟计，隔离正确性优先于秒级启动时间。

## 7. 预期文件改动

### 新增

- `services/researcher/app/research_executor.py`
  - `ResearchExecutor` 接口
  - `ProcessResearchExecutor`
  - 并发信号量、消息消费、取消、清理和错误映射
- `services/researcher/app/research_worker.py`
  - 子进程入口
  - 环境快照应用
  - GPTR 核心执行与消息发布
- `services/researcher/test/test_research_executor.py`
  - 进程隔离、并发、事件、崩溃和取消测试

### 修改

- `services/researcher/app/main.py`
  - endpoint 委托给 `ResearchExecutor`
  - 保留报告清理和引用规范化行为
  - 删除父进程中的请求级环境写入
- `services/researcher/test/test_research.py`
  - endpoint 契约使用 fake executor
  - 原有 GPTR 核心断言调整到子进程执行 seam
- `.env.example`
  - 增加 `GPTR_WORKER_CONCURRENCY=2` 及中文/英文用途说明
- `services/researcher/README.md`
  - 记录进程模型、资源需求和跨平台启动行为

Node 端 `ResearchRequest` 和 `GptrConnector` 本项不改字段，只补充兼容性回归测试。

## 8. 测试先行顺序

### 8.1 配置快照单元测试

- 请求值覆盖启动基线。
- 缺省值正确回落到启动基线。
- URL 规范化不改变路径含义。
- 未提供变量不会继承上一次请求值。
- 快照的 repr、错误和事件中不出现 API key。

### 8.2 并发进程隔离测试

同时启动 A/B 两个可控 fake worker：

- A 使用模型/端点/密钥 A。
- B 使用模型/端点/密钥 B。
- 两者执行窗口必须重叠。
- 各自返回的探针信息只能包含自己的非敏感配置指纹。
- 父进程的 `os.environ` 在执行前后完全一致。

### 8.3 事件与终止协议测试

- `event` 在 `result` 之前到达。
- 每个运行只产生一个终止消息。
- 子进程异常退出映射为 `502`。
- worker 返回业务错误时保留稳定状态码，但隐藏密钥。
- 非流式和流式 endpoint 得到相同最终结果。

### 8.4 取消与清理测试

- 取消等待队列中的运行不会启动子进程。
- 中止运行中的请求会回收 PID。
- 客户端关闭 NDJSON 流不会留下活动 worker。
- executor `close()` 后不再接受新任务。

### 8.5 回归测试

- 完整 `systemPrompt` 和 task 原样进入 GPTR。
- LLM 与 embedding 使用不同 base URL。
- DuckDuckGo 与 Tavily 校验行为不变。
- 报告去重、引用规范化、事件归并和导出不受影响。
- Node 的 `npm test`、`npm run typecheck` 和相关端到端契约继续通过。

## 9. 分步实施

1. **红灯测试：** 先补配置快照、双请求并发串线、取消和异常退出测试。
2. **提取核心执行：** 将 GPTR 调用整理为可在子进程内调用的函数，不改变报告逻辑。
3. **实现进程 adapter：** 完成 spawn、消息协议、并发限制和生命周期管理。
4. **接入 FastAPI：** 两个研究 endpoint 统一委托 executor，保持响应结构不变。
5. **安全加固：** 加入密钥脱敏、父环境不变断言、无终止消息保护和资源清理。
6. **回归验证：** 运行 Python、Node、类型检查和端到端测试。
7. **人工验收：** 用两个不同配置的并发探针任务确认不串线，再执行一个真实 DuckDuckGo 研究任务。
8. **更新清单：** 所有完成标准满足后勾选 TT-001，开始为 TT-002 制定 Plan。

## 10. 验证命令

```powershell
..\..\.venv\Scripts\python.exe -m pytest test\test_research_executor.py -q
..\..\.venv\Scripts\python.exe -m pytest test -q
npm run typecheck
npm test
npm run test:acceptance
```

Python 命令从 `services/researcher` 目录执行；Node 命令从仓库根目录执行。

## 11. 风险、缓解与回滚

| 风险 | 缓解 |
| --- | --- |
| Windows spawn 启动较慢 | 研究是长任务；限制并发并记录排队/启动耗时 |
| 多进程内存增加 | 默认并发 2；后续根据指标调整，不提前引入复杂进程池 |
| 子进程崩溃或失联 | 监控进程退出码；无终止消息立即失败；统一清理 |
| 客户端断流留下进程 | 在流生成器 `finally` 和 executor 取消路径回收 worker |
| 子进程错误包含密钥 | 发送前按本次快照脱敏；不记录请求体 |
| 未来 MCP/浏览器再创建进程 | worker 不设 daemon，并保留明确的资源上限 |

若跨平台 spawn 或事件转发在验收环境中出现不可修复问题，回滚到实施前版本；不以“保留并发但继续共享环境”作为降级。紧急单用户诊断可临时使用整次研究串行锁，但不作为正式运行模式。

## 12. 完成判定

TT-001 只有在以下条件全部满足后完成：

- 父进程不再执行任何请求级 `os.environ` 写入。
- 两个重叠研究运行使用不同配置时互不污染。
- 实时事件、最终报告和现有 HTTP 契约保持兼容。
- 取消、超时、异常退出和服务关闭均无残留子进程。
- 密钥未出现在响应、事件、日志和任务快照中。
- Python/Node/端到端测试通过，并完成真实研究人工验收。

## 13. 实施结果

- FastAPI 父进程不再包含请求级环境写入；所有 GPTR 环境配置位于独立 `spawn` worker。
- 双并发进程测试验证了 retriever、LLM/embedding 模型、base URL 和 API key 互不污染。
- worker 的事件、结果、HTTP 状态、崩溃、取消、shutdown 和密钥脱敏路径均有测试。
- Windows 子进程 stdout/stderr 强制使用 UTF-8，真实日志中的中文已验证无乱码。
- `GPTR_WORKER_CONCURRENCY` 默认值为 `2`，并已写入 `.env.example` 和服务 README。
- 自动验证通过：Python 28 项、Node 48 项、TypeScript 类型检查、构建和 V1 acceptance。
- 两次真实 DuckDuckGo 任务均完成；最终最小验收报告包含 1 条引用且无质量警告。
