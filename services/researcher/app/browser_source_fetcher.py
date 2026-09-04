from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from collections.abc import Sequence
from urllib.parse import urlsplit

from .source_access import (
    SourceAccessError,
    SourceHttpResponse,
    _hostname_forbidden,
)

# Rendering an SPA means letting its own bundle load. The document host is pinned
# to a verified address; a cross-origin subresource (a CDN, a font host) is only
# allowed after it resolves entirely to global addresses, so the browser still
# cannot be steered at link-local, loopback, or private infrastructure. Set
# GPTR_SOURCE_BROWSER_ISOLATION=strict to keep the old same-host-only behavior.
_STRICT_ISOLATION = os.getenv("GPTR_SOURCE_BROWSER_ISOLATION", "").strip().lower() == "strict"
_RENDER_SETTLE_MS = 3000


class PlaywrightSourceTransport:
    """A one-page, no-storage renderer used only after static extraction fails."""

    def __init__(
        self,
        browsers_path: str | None = None,
        *,
        proxy: str | None = None,
    ) -> None:
        self._browsers_path = browsers_path
        self._proxy = proxy or None

    async def fetch(
        self,
        url: str,
        *,
        addresses: Sequence[str],
        max_bytes: int,
        timeout_seconds: int,
    ) -> SourceHttpResponse:
        if not addresses:
            raise SourceAccessError("source_fallback_failed", url, "No verified address is available for rendering.")
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise SourceAccessError("source_fallback_failed", url, "The browser fallback is not installed.") from exc
        host = urlsplit(url).hostname or ""
        subresource_hosts: dict[str, bool] = {host: True}
        browser_path = self._browsers_path
        old_path = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
        if browser_path:
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = browser_path
        try:
            async with async_playwright() as playwright:
                launch_kwargs: dict[str, object] = {"headless": True}
                if self._proxy:
                    # The proxy resolves and connects; Chrome's host-resolver
                    # rules do not apply to proxied requests. The navigation
                    # allowlist below and the caller's pre-resolution address
                    # check remain the SSRF guardrails.
                    launch_kwargs["proxy"] = {"server": self._proxy}
                else:
                    launch_kwargs["args"] = [
                        f"--host-resolver-rules=MAP {host} {addresses[0]},"
                        "EXCLUDE localhost"
                    ]
                browser = await playwright.chromium.launch(**launch_kwargs)
                try:
                    context = await browser.new_context(
                        accept_downloads=False,
                        service_workers="block",
                    )
                    try:
                        page = await context.new_page()

                        async def restrict(route) -> None:
                            request = route.request
                            target = urlsplit(request.url)
                            if target.scheme not in {"http", "https"}:
                                await route.abort()
                                return
                            request_host = target.hostname or ""
                            if request.is_navigation_request():
                                # Navigation may never leave the verified host.
                                if request_host == host:
                                    await route.continue_()
                                else:
                                    await route.abort()
                                return
                            if await self._subresource_allowed(
                                request_host, host, subresource_hosts
                            ):
                                await route.continue_()
                            else:
                                await route.abort()

                        await page.route("**/*", restrict)
                        response = await page.goto(
                            url,
                            wait_until="load",
                            timeout=timeout_seconds * 1000,
                        )
                        if response is None or not response.ok:
                            raise SourceAccessError("source_fallback_failed", url, "The rendered source could not be downloaded.")
                        final_url = urlsplit(page.url)
                        if final_url.hostname != host:
                            raise SourceAccessError("source_fallback_failed", url, "The rendered source redirected outside its verified host.")
                        await self._settle(page, timeout_seconds)
                        content = (await page.content()).encode("utf-8")
                        if len(content) > max_bytes:
                            raise SourceAccessError("source_response_too_large", url, "The rendered source exceeds the allowed size.")
                        return SourceHttpResponse(
                            status=response.status,
                            headers={"content-type": response.headers.get("content-type", "text/html; charset=utf-8")},
                            body=content,
                            peer_ip=addresses[0],
                            via_proxy=bool(self._proxy),
                        )
                    finally:
                        await context.close()
                finally:
                    await browser.close()
        except SourceAccessError:
            raise
        except (asyncio.TimeoutError, Exception) as exc:
            raise SourceAccessError("source_fallback_failed", url, "The rendered source could not be read.") from exc
        finally:
            if browser_path:
                if old_path is None:
                    os.environ.pop("PLAYWRIGHT_BROWSERS_PATH", None)
                else:
                    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = old_path

    @staticmethod
    async def _settle(page, timeout_seconds: int) -> None:
        """Give a client-rendered page a bounded window to paint its content."""
        budget = min(_RENDER_SETTLE_MS, max(0, timeout_seconds * 1000))
        if budget <= 0:
            return
        try:
            await page.wait_for_load_state("networkidle", timeout=budget)
        except Exception:
            await page.wait_for_timeout(budget)

    @staticmethod
    async def _subresource_allowed(
        request_host: str,
        document_host: str,
        decided: dict[str, bool],
    ) -> bool:
        if not request_host:
            return False
        if request_host in decided:
            return decided[request_host]
        if _STRICT_ISOLATION or _hostname_forbidden(request_host):
            decided[request_host] = False
            return False
        try:
            loop = asyncio.get_running_loop()
            records = await loop.getaddrinfo(
                request_host,
                None,
                family=socket.AF_UNSPEC,
                type=socket.SOCK_STREAM,
                proto=socket.IPPROTO_TCP,
            )
        except OSError:
            decided[request_host] = False
            return False
        allowed = bool(records) and all(
            ipaddress.ip_address(record[4][0]).is_global
            and not ipaddress.ip_address(record[4][0]).is_multicast
            for record in records
        )
        decided[request_host] = allowed
        return allowed
