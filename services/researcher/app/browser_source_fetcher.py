from __future__ import annotations

import asyncio
import os
from collections.abc import Sequence
from urllib.parse import urlsplit

from .source_access import SourceAccessError, SourceHttpResponse


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
                            if not request.is_navigation_request():
                                await route.abort()
                                return
                            target = urlsplit(request.url)
                            if target.scheme not in {"http", "https"} or target.hostname != host:
                                await route.abort()
                                return
                            await route.continue_()

                        await page.route("**/*", restrict)
                        response = await page.goto(
                            url,
                            wait_until="domcontentloaded",
                            timeout=timeout_seconds * 1000,
                        )
                        if response is None or not response.ok:
                            raise SourceAccessError("source_fallback_failed", url, "The rendered source could not be downloaded.")
                        final_url = urlsplit(page.url)
                        if final_url.hostname != host:
                            raise SourceAccessError("source_fallback_failed", url, "The rendered source redirected outside its verified host.")
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
