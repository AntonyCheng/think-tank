# Think Tank MCP Server

Python MCP server aligned with `bids-mcp`. It exposes five tools:

- `submit_research_task`: submit a topic and return `task_id`.
- `get_research_report`: return a friendly task status until a report is complete. The first completed response returns an outline; use `section` and `cursor` to read a bounded Markdown excerpt.
- `export_report_word`, `export_report_markdown`, `export_report_pdf`: generate a temporary file and return a short-lived download URL.

The server only calls `THINK_TANK_API_URL`; it never reads SQLite or contacts the researcher service directly.

## Setup

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The project setup creates `.env` with local `stdio` defaults. Keep it out of Git.

## Local stdio

Set `MCP_TRANSPORT=stdio`. The MCP client starts the server as a child process, with no API key.

```json
{
  "mcpServers": {
    "think-tank": {
      "command": "C:/projects/think-tank/mcp-server/.venv/Scripts/python.exe",
      "args": ["C:/projects/think-tank/mcp-server/server.py"]
    }
  }
}
```

## Remote Streamable HTTP

Set `MCP_TRANSPORT=streamable-http`, use a high-entropy `MCP_API_KEY`, and start:

```powershell
.venv\Scripts\python.exe server.py
```

Clients connect with:

```text
http://10.9.0.6:7010/mcp?api_key=<MCP_API_KEY>
```

Set `MCP_PUBLIC_BASE_URL` to the address reachable by the Agent. Export tools return
`<MCP_PUBLIC_BASE_URL>/downloads/<short-token>`; this temporary link does not include
the MCP API key and expires after `ARTIFACT_TTL_MINUTES`. An Agent with network tools
may retrieve it with `curl -L '<download_url>' -o '<filename>'`.

This configuration uses HTTP for a trusted internal network. Redact `api_key` from
any service or reverse-proxy logs.
