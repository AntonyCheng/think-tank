"""Minimal client for the public Think Tank API."""

from typing import Any

import httpx


class ThinkTankApiError(RuntimeError):
    """The Think Tank API did not accept a request."""


class ThinkTankClient:
    def __init__(self, base_url: str) -> None:
        self._base_url = base_url.rstrip("/")

    async def submit_research_task(self, topic: str) -> dict[str, Any]:
        return await self._request("POST", "/api/tasks", json={"topic": topic})

    async def get_task(self, task_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/api/tasks/{task_id}")

    async def get_report_document(self, task_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/api/tasks/{task_id}/report-document")

    async def export_report(self, task_id: str, export_format: str) -> tuple[bytes, str]:
        async with httpx.AsyncClient(timeout=90.0) as client:
            response = await client.get(
                f"{self._base_url}/api/tasks/{task_id}/export/{export_format}"
            )
        if not response.is_success:
            try:
                payload = response.json()
            except ValueError:
                payload = {}
            message = payload.get("error") if isinstance(payload, dict) else None
            raise ThinkTankApiError(message or f"Think Tank export failed ({response.status_code})")
        return response.content, response.headers.get("content-type", "application/octet-stream")

    async def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.request(method, f"{self._base_url}{path}", **kwargs)
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if not response.is_success:
            message = payload.get("error") if isinstance(payload, dict) else None
            raise ThinkTankApiError(message or f"Think Tank API request failed ({response.status_code})")
        if not isinstance(payload, dict):
            raise ThinkTankApiError("Think Tank API returned an invalid response")
        return payload
