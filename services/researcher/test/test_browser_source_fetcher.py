import asyncio

import pytest

from app import browser_source_fetcher
from app.browser_source_fetcher import PlaywrightSourceTransport


def _allowed(host: str, document_host: str = "example.com") -> bool:
    return asyncio.run(
        PlaywrightSourceTransport._subresource_allowed(host, document_host, {document_host: True})
    )


def test_same_origin_subresource_is_always_allowed() -> None:
    assert _allowed("example.com", "example.com") is True


def test_loopback_and_private_subresource_hosts_are_blocked() -> None:
    assert _allowed("localhost") is False
    assert _allowed("127.0.0.1") is False
    assert _allowed("10.0.0.5") is False
    assert _allowed("169.254.169.254") is False
    assert _allowed("metadata.internal.local") is False


def test_public_cross_origin_subresource_host_is_allowed(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_getaddrinfo(host, *args, **kwargs):
        return [(None, None, None, None, ("93.184.216.34", 0))]

    loop = asyncio.new_event_loop()
    monkeypatch.setattr(loop, "getaddrinfo", fake_getaddrinfo, raising=False)
    monkeypatch.setattr(asyncio, "get_running_loop", lambda: loop)
    try:
        assert loop.run_until_complete(
            PlaywrightSourceTransport._subresource_allowed("cdn.example.net", "example.com", {})
        ) is True
    finally:
        loop.close()


def test_cross_origin_host_resolving_to_a_private_address_is_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_getaddrinfo(host, *args, **kwargs):
        return [(None, None, None, None, ("10.1.2.3", 0))]

    loop = asyncio.new_event_loop()
    monkeypatch.setattr(loop, "getaddrinfo", fake_getaddrinfo, raising=False)
    monkeypatch.setattr(asyncio, "get_running_loop", lambda: loop)
    try:
        assert loop.run_until_complete(
            PlaywrightSourceTransport._subresource_allowed("rebind.example.net", "example.com", {})
        ) is False
    finally:
        loop.close()


def test_strict_isolation_blocks_every_cross_origin_subresource(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(browser_source_fetcher, "_STRICT_ISOLATION", True)
    assert _allowed("cdn.jsdelivr.net") is False
    assert _allowed("example.com", "example.com") is True
