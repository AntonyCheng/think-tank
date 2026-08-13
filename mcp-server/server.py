"""Think Tank MCP server with safe report reads and temporary file delivery."""

from __future__ import annotations

import hmac
import logging
from pathlib import Path
from typing import Any
from uuid import UUID

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

import config
from artifact_store import ArtifactStore
from think_tank_client import ThinkTankApiError, ThinkTankClient


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
log = logging.getLogger("think-tank-mcp")

client = ThinkTankClient(config.THINK_TANK_API_URL, config.THINK_TANK_SERVICE_API_KEY)
artifacts = ArtifactStore(Path(__file__).with_name("artifacts"), config.ARTIFACT_TTL_MINUTES)
mcp = FastMCP(
    "think-tank-mcp",
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)

EXPORTS = {
    "word": ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "markdown": ("markdown", "text/markdown; charset=utf-8"),
    "pdf": ("pdf", "application/pdf"),
}


def _task_id(value: str) -> str:
    try:
        return str(UUID(value))
    except ValueError as error:
        raise ValueError("task_id must be a valid UUID") from error


def _pending_message(status: str) -> str:
    return {
        "queued": "研究任务已进入队列，尚未形成报告，请稍后使用同一 task_id 查询。",
        "running": "研究任务正在执行，尚未形成报告，请稍后使用同一 task_id 查询。",
        "canceling": "研究任务正在停止，当前不会生成报告。",
        "needs_input": "研究任务正在等待平台侧人工输入；当前 MCP 无法代为继续该任务。",
        "canceled": "研究任务已取消，未形成可读取报告。",
        "failed": "研究任务执行失败，未形成可读取报告。",
    }.get(status, "研究任务尚未形成可读取报告，请稍后使用同一 task_id 查询。")


def _safe_task_status(task: dict[str, Any]) -> dict[str, Any]:
    status = str(task.get("status", "unknown"))
    report_ready = task.get("reportReady")
    return {
        "task_id": task.get("id"),
        "topic": task.get("topic"),
        "status": status,
        "report_ready": bool(report_ready) if isinstance(report_ready, bool) else (
            status in {"completed", "completed_with_warnings"} and bool(task.get("output"))
        ),
    }


def _report_sections(markdown: str) -> list[dict[str, str]]:
    sections: list[dict[str, str]] = []
    current_title = "报告开篇"
    current_lines: list[str] = []
    for line in markdown.splitlines(keepends=True):
        if line.startswith("#") and line.lstrip("#").startswith(" "):
            if current_lines:
                sections.append({"title": current_title, "markdown": "".join(current_lines)})
            current_title = line.lstrip("#").strip()
            current_lines = [line]
        else:
            current_lines.append(line)
    if current_lines:
        sections.append({"title": current_title, "markdown": "".join(current_lines)})
    return sections or [{"title": "报告正文", "markdown": markdown}]


@mcp.tool()
async def submit_research_task(topic: str) -> dict[str, Any]:
    """提交研究主题，返回 task_id；后续使用 get_research_report 查询进度或读取完成报告。"""
    cleaned = topic.strip()
    if not cleaned:
        return {"error": "研究主题不能为空"}
    if len(cleaned) > 4000:
        return {"error": "研究主题不能超过 4000 个字符"}
    try:
        task = await client.submit_research_task(cleaned)
    except ThinkTankApiError:
        return {"error": "任务提交失败，请稍后重试。"}
    return {
        "task_id": task.get("id"),
        "topic": task.get("topic"),
        "status": task.get("status"),
        "message": "研究任务已提交。请使用 get_research_report 并传入 task_id 查询进度或获取完成报告。",
    }


@mcp.tool()
async def get_research_report(task_id: str, section: int | None = None, cursor: int = 0) -> dict[str, Any]:
    """安全读取研究报告。首次调用仅返回目录；指定 section 后分段返回对应 Markdown 正文。"""
    try:
        task = await client.get_task(_task_id(task_id))
    except (ThinkTankApiError, ValueError):
        return {"error": "未找到该研究任务或 task_id 格式无效。"}
    status = _safe_task_status(task)
    if not status["report_ready"]:
        return {**status, "message": _pending_message(str(status["status"]))}
    try:
        document = await client.get_report_document(str(status["task_id"]))
    except ThinkTankApiError:
        return {"error": "报告当前不可读取，请稍后重试。"}
    markdown = document.get("currentMarkdown")
    if not isinstance(markdown, str) or not markdown:
        return {"error": "报告内容为空，请稍后重试。"}
    sections = _report_sections(markdown)
    outline = [{"section": index + 1, "title": item["title"], "characters": len(item["markdown"])} for index, item in enumerate(sections)]
    if section is None:
        return {
            **status,
            "document_version": document.get("version"),
            "outline": outline,
            "message": "报告已完成。请根据目录选择 section 读取正文；长章节可使用 next_cursor 继续读取。",
        }
    if section < 1 or section > len(sections):
        return {"error": f"section 必须在 1 到 {len(sections)} 之间。", "outline": outline}
    if cursor < 0:
        return {"error": "cursor 不能小于 0"}
    selected = sections[section - 1]
    content = selected["markdown"][cursor:cursor + config.REPORT_PAGE_CHARACTERS]
    next_cursor = cursor + len(content)
    return {
        **status,
        "document_version": document.get("version"),
        "section": section,
        "section_title": selected["title"],
        "content": content,
        "cursor": cursor,
        "has_more": next_cursor < len(selected["markdown"]),
        **({"next_cursor": next_cursor} if next_cursor < len(selected["markdown"]) else {}),
    }


async def _export(task_id: str, kind: str) -> dict[str, Any]:
    try:
        task = await client.get_task(_task_id(task_id))
    except (ThinkTankApiError, ValueError):
        return {"error": "未找到该研究任务或 task_id 格式无效。"}
    status = _safe_task_status(task)
    if not status["report_ready"]:
        return {**status, "message": _pending_message(str(status["status"]))}
    export_format, fallback_media_type = EXPORTS[kind]
    try:
        content, media_type = await client.export_report(str(status["task_id"]), export_format)
    except ThinkTankApiError:
        return {"error": "报告导出失败，请稍后重试。"}
    extension = "md" if export_format == "markdown" else export_format
    artifact = artifacts.create(
        f"研究报告_{status['task_id']}.{extension}",
        content,
        media_type or fallback_media_type,
    )
    download_url = f"{config.MCP_PUBLIC_BASE_URL}/downloads/{artifact.token}"
    return {
        **status,
        "format": kind,
        "filename": artifact.filename,
        "download_url": download_url,
        "expires_at": artifact.expires_at.isoformat(),
        "next_step": "如当前环境具备网络或终端工具，可使用下载链接获取文件，例如 curl -L '<download_url>' -o '<filename>'；否则请将下载链接提供给用户。",
    }


@mcp.tool()
async def export_report_word(task_id: str) -> dict[str, Any]:
    """导出已完成报告的 Word 文件，返回短时下载链接。"""
    return await _export(task_id, "word")


@mcp.tool()
async def export_report_markdown(task_id: str) -> dict[str, Any]:
    """导出已完成报告的 Markdown 文件，返回短时下载链接。"""
    return await _export(task_id, "markdown")


@mcp.tool()
async def export_report_pdf(task_id: str) -> dict[str, Any]:
    """导出已完成报告的 PDF 文件，返回短时下载链接。"""
    return await _export(task_id, "pdf")


def _run_http() -> None:
    import uvicorn
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.requests import Request
    from starlette.responses import FileResponse, JSONResponse

    mcp.settings.host = config.MCP_HOST
    mcp.settings.port = config.MCP_PORT
    app = mcp.streamable_http_app()

    class ApiKeyMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next: Any):
            if request.url.path.startswith("/downloads/"):
                return await call_next(request)
            provided = request.query_params.get("api_key", "")
            if not hmac.compare_digest(provided, config.MCP_API_KEY):
                return JSONResponse({"error": "invalid api_key"}, status_code=401)
            return await call_next(request)

    async def download(request: Request):
        artifact = artifacts.get(request.path_params["token"])
        if not artifact:
            return JSONResponse({"error": "download link is invalid or expired"}, status_code=404)
        return FileResponse(
            artifact.file_path,
            media_type=artifact.media_type,
            filename=artifact.filename,
        )

    app.add_route("/downloads/{token}", download, methods=["GET"])
    app.add_middleware(ApiKeyMiddleware)
    log.info("MCP HTTP listening at %s/mcp?api_key=***", config.MCP_PUBLIC_BASE_URL)
    # The MCP key is carried in the query string, so the default access log
    # must stay disabled to keep credentials out of container logs.
    uvicorn.run(
        app,
        host=config.MCP_HOST,
        port=config.MCP_PORT,
        access_log=False,
    )


def main() -> None:
    if config.MCP_TRANSPORT == "stdio":
        log.info("MCP started with stdio transport")
        mcp.run(transport="stdio")
    elif config.MCP_TRANSPORT == "streamable-http":
        _run_http()
    else:
        raise ValueError(f"Unsupported MCP_TRANSPORT: {config.MCP_TRANSPORT}")


if __name__ == "__main__":
    main()
