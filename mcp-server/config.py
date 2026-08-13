"""Configuration for the Think Tank MCP server."""

import os
from pathlib import Path

from dotenv import load_dotenv


load_dotenv(Path(__file__).with_name(".env"))

MCP_TRANSPORT = os.getenv("MCP_TRANSPORT", "stdio").strip()
MCP_HOST = os.getenv("MCP_HOST", "127.0.0.1").strip()
MCP_PORT = int(os.getenv("MCP_PORT", "7010"))
MCP_API_KEY = os.getenv("MCP_API_KEY", "").strip()
MCP_PUBLIC_BASE_URL = os.getenv(
    "MCP_PUBLIC_BASE_URL", f"http://{MCP_HOST}:{MCP_PORT}"
).rstrip("/")
THINK_TANK_API_URL = os.getenv("THINK_TANK_API_URL", "http://127.0.0.1:3000").rstrip("/")
REPORT_PAGE_CHARACTERS = int(os.getenv("REPORT_PAGE_CHARACTERS", "6000"))
ARTIFACT_TTL_MINUTES = int(os.getenv("ARTIFACT_TTL_MINUTES", "15"))

if MCP_TRANSPORT not in {"stdio", "streamable-http"}:
    raise ValueError("MCP_TRANSPORT must be stdio or streamable-http")
if not THINK_TANK_API_URL.startswith(("http://", "https://")):
    raise ValueError("THINK_TANK_API_URL must use HTTP or HTTPS")
if not MCP_PUBLIC_BASE_URL.startswith(("http://", "https://")):
    raise ValueError("MCP_PUBLIC_BASE_URL must use HTTP or HTTPS")
if not 1 <= MCP_PORT <= 65535:
    raise ValueError("MCP_PORT must be between 1 and 65535")
if not 1000 <= REPORT_PAGE_CHARACTERS <= 30000:
    raise ValueError("REPORT_PAGE_CHARACTERS must be between 1000 and 30000")
if not 1 <= ARTIFACT_TTL_MINUTES <= 1440:
    raise ValueError("ARTIFACT_TTL_MINUTES must be between 1 and 1440")
if MCP_TRANSPORT == "streamable-http" and (
    not MCP_API_KEY or MCP_API_KEY.startswith("change-me")
):
    raise ValueError("MCP_API_KEY must be a non-placeholder secret for streamable-http mode")
