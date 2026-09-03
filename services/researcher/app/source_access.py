from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import socket
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Protocol
from urllib.parse import urljoin, urlsplit, urlunsplit

import aiohttp
import anydoc
from aiohttp.abc import AbstractResolver
from bs4 import BeautifulSoup, Comment


@dataclass(frozen=True)
class SourceHttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes
    peer_ip: str
    # True when the fetch was routed through an egress proxy. The proxy performs
    # its own DNS resolution and TCP connection, so the observed peer is the
    # proxy rather than the origin and cannot be pinned to the verified address
    # set. Hostname and pre-resolution address checks still apply.
    via_proxy: bool = False


@dataclass(frozen=True)
class SourceAccessLimits:
    max_response_bytes: int = 5 * 1024 * 1024
    max_total_bytes: int = 20 * 1024 * 1024
    max_redirects: int = 5
    timeout_seconds: int = 30
    fallback_max_attempts: int = 1
    fallback_minimum_text_characters: int = 200


@dataclass(frozen=True)
class MaterializedSource:
    requested_url: str
    canonical_url: str
    title: str
    media_type: str
    text: str
    byte_size: int
    redirect_chain: tuple[str, ...] = ()
    fetch_strategy: str = "static"
    fallback_reason: str | None = None


@dataclass(frozen=True)
class MaterializedSourceFailure:
    url: str
    code: str
    message: str


@dataclass(frozen=True)
class MaterializedSourceSet:
    sources: tuple[MaterializedSource, ...]
    total_bytes: int
    failures: tuple[MaterializedSourceFailure, ...] = ()


class SourceAccessError(Exception):
    def __init__(self, code: str, url: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.url = url


@dataclass(frozen=True)
class SourceFallbackDecision:
    reason: str | None = None

    @property
    def eligible(self) -> bool:
        return self.reason is not None


class SourceHttpTransport(Protocol):
    async def fetch(
        self,
        url: str,
        *,
        addresses: Sequence[str],
        max_bytes: int,
        timeout_seconds: int,
    ) -> SourceHttpResponse: ...


class SourceMaterializer:
    def __init__(
        self,
        resolver,
        transport,
        limits: SourceAccessLimits | None = None,
        fallback_transport: SourceHttpTransport | None = None,
        fallback_strategy: str = "fallback",
    ) -> None:
        self._resolver = resolver
        self._transport = transport
        self._limits = limits or SourceAccessLimits()
        self._fallback_transport = fallback_transport
        self._fallback_strategy = fallback_strategy

    async def materialize(
        self,
        urls: Sequence[str],
    ) -> MaterializedSourceSet:
        sources: list[MaterializedSource] = []
        failures: list[MaterializedSourceFailure] = []
        total_bytes = 0
        seen_urls: set[str] = set()
        for url in urls:
            normalized = _canonical_url(url)
            if normalized in seen_urls:
                continue
            seen_urls.add(normalized)
            try:
                source = await self._materialize_one(url)
            except SourceAccessError as exc:
                if exc.code not in {
                    "source_unavailable",
                    "source_media_type_unsupported",
                    "source_content_empty",
                }:
                    raise
                failures.append(
                    MaterializedSourceFailure(
                        url=exc.url,
                        code=exc.code,
                        message=str(exc),
                    )
                )
                continue
            if (
                total_bytes + source.byte_size
                > self._limits.max_total_bytes
            ):
                raise SourceAccessError(
                    "source_total_too_large",
                    url,
                    "The specified sources exceed the task download budget.",
                )
            sources.append(source)
            total_bytes += source.byte_size
        return MaterializedSourceSet(
            tuple(sources),
            total_bytes,
            tuple(failures),
        )

    async def _materialize_one(self, requested_url: str) -> MaterializedSource:
        current_url = _canonical_url(requested_url)
        redirect_chain: list[str] = []
        for _ in range(self._limits.max_redirects + 1):
            parsed = urlsplit(current_url)
            host = parsed.hostname or ""
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            if _hostname_forbidden(host):
                code = (
                    "source_redirect_forbidden"
                    if redirect_chain
                    else "source_address_forbidden"
                )
                raise SourceAccessError(
                    code,
                    requested_url,
                    "The source targets a forbidden network address.",
                )
            try:
                addresses = await self._resolver.resolve(host, port)
            except SourceAccessError:
                raise
            except Exception as exc:
                raise SourceAccessError(
                    "source_unavailable",
                    requested_url,
                    "The source host could not be resolved.",
                ) from exc
            if not addresses or any(
                not ipaddress.ip_address(address).is_global
                for address in addresses
            ):
                if redirect_chain:
                    raise SourceAccessError(
                        "source_redirect_forbidden",
                        requested_url,
                        "A source redirect targets a forbidden address.",
                    )
                raise SourceAccessError(
                    "source_address_forbidden",
                    requested_url,
                    "The source resolves to a non-public network address.",
                )
            try:
                response = await self._transport.fetch(
                    current_url,
                    addresses=addresses,
                    max_bytes=self._limits.max_response_bytes,
                    timeout_seconds=self._limits.timeout_seconds,
                )
            except SourceAccessError:
                raise
            except Exception as exc:
                raise SourceAccessError(
                    "source_unavailable",
                    requested_url,
                    "The source could not be downloaded.",
                ) from exc
            if not response.via_proxy:
                _assert_verified_peer(
                    response.peer_ip,
                    addresses,
                    requested_url,
                )
            if response.status in {301, 302, 303, 307, 308}:
                location = response.headers.get("location", "").strip()
                if not location:
                    raise SourceAccessError(
                        "source_redirect_invalid",
                        requested_url,
                        "The source returned a redirect without a location.",
                    )
                if len(redirect_chain) >= self._limits.max_redirects:
                    raise SourceAccessError(
                        "source_redirect_limit",
                        requested_url,
                        "The source exceeded the redirect limit.",
                    )
                try:
                    current_url = _canonical_url(
                        urljoin(current_url, location)
                    )
                except SourceAccessError as exc:
                    raise SourceAccessError(
                        "source_redirect_forbidden",
                        requested_url,
                        "A source redirect uses a forbidden target URL.",
                    ) from exc
                redirect_chain.append(current_url)
                continue
            if response.status < 200 or response.status >= 300:
                fallback = await self._fetch_fallback(
                    current_url,
                    addresses,
                    requested_url,
                )
                if fallback is None:
                    raise SourceAccessError(
                        "source_unavailable",
                        requested_url,
                        "The source returned an unsuccessful response.",
                    )
                response, media_type, title, text = fallback
                return MaterializedSource(
                    requested_url=requested_url,
                    canonical_url=current_url,
                    title=title,
                    media_type=media_type,
                    text=text,
                    byte_size=len(response.body),
                    redirect_chain=tuple(redirect_chain),
                    fetch_strategy=self._fallback_strategy,
                    fallback_reason="unsuccessful_response",
                )
            if len(response.body) > self._limits.max_response_bytes:
                raise SourceAccessError(
                    "source_response_too_large",
                    requested_url,
                    "The source response exceeds the allowed size.",
                )
            media_type, charset = _content_type(
                response.headers.get("content-type", "")
            )
            title, text = _extract_source_text(
                response.body,
                current_url,
                media_type,
                charset,
                requested_url,
            )
            strategy = "static"
            fallback_reason = None
            decision = source_fallback_decision(
                response.body,
                media_type,
                text,
                self._limits.fallback_minimum_text_characters,
            )
            if (
                decision.eligible
                and self._fallback_transport is not None
                and self._limits.fallback_max_attempts > 0
            ):
                fallback = await self._fetch_fallback(
                    current_url,
                    addresses,
                    requested_url,
                )
                if fallback is not None:
                    response, media_type, title, text = fallback
                    strategy = self._fallback_strategy
                    fallback_reason = decision.reason
            if not text.strip():
                raise SourceAccessError(
                    "source_content_empty",
                    requested_url,
                    "The source did not contain extractable text.",
                )
            return MaterializedSource(
                requested_url=requested_url,
                canonical_url=current_url,
                title=title,
                media_type=media_type,
                text=text,
                byte_size=len(response.body),
                redirect_chain=tuple(redirect_chain),
                fetch_strategy=strategy,
                fallback_reason=fallback_reason,
            )
        raise SourceAccessError(
            "source_redirect_limit",
            requested_url,
            "The source exceeded the redirect limit.",
        )

    async def _fetch_fallback(
        self,
        url: str,
        addresses: Sequence[str],
        requested_url: str,
    ) -> tuple[SourceHttpResponse, str, str, str] | None:
        if (
            self._fallback_transport is None
            or self._limits.fallback_max_attempts < 1
        ):
            return None
        try:
            response = await self._fallback_transport.fetch(
                url,
                addresses=addresses,
                max_bytes=self._limits.max_response_bytes,
                timeout_seconds=self._limits.timeout_seconds,
            )
            if not response.via_proxy:
                _assert_verified_peer(response.peer_ip, addresses, requested_url)
            if (
                response.status < 200
                or response.status >= 300
                or len(response.body) > self._limits.max_response_bytes
            ):
                return None
            media_type, charset = _content_type(
                response.headers.get("content-type", "")
            )
            title, text = _extract_source_text(
                response.body,
                url,
                media_type,
                charset,
                requested_url,
            )
            return (response, media_type, title, text) if text.strip() else None
        except (SourceAccessError, Exception):
            # A browser is only an evidence recovery path. A usable static
            # response remains valid when rendering is unavailable.
            return None


def _canonical_url(value: str) -> str:
    parsed = urlsplit(value)
    scheme = parsed.scheme.lower()
    if (
        scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise SourceAccessError(
            "source_url_invalid",
            value,
            "The source URL is not an allowed absolute HTTP(S) URL.",
        )
    try:
        port = parsed.port
        host = parsed.hostname.encode("idna").decode("ascii").lower()
    except (UnicodeError, ValueError) as exc:
        raise SourceAccessError(
            "source_url_invalid",
            value,
            "The source URL host or port is invalid.",
        ) from exc
    default_port = 443 if scheme == "https" else 80
    if port is not None and port != default_port:
        raise SourceAccessError(
            "source_url_invalid",
            value,
            "The source URL uses a port that is not allowed.",
        )
    netloc = host if port is None or port == default_port else f"{host}:{port}"
    return urlunsplit((scheme, netloc, parsed.path or "/", parsed.query, ""))


def _content_type(value: str) -> tuple[str, str]:
    parts = [part.strip() for part in value.split(";")]
    media_type = parts[0].lower()
    charset = "utf-8"
    for part in parts[1:]:
        key, separator, candidate = part.partition("=")
        if separator and key.strip().lower() == "charset":
            charset = candidate.strip().strip("\"'") or charset
    return media_type, charset


# HTML variants always go through the boilerplate-stripping text extractor.
_HTML_MEDIA_TYPES = {"text/html", "application/xhtml+xml"}

# Media types that carry no reliable binary signature. anydoc needs an explicit
# format hint for these; everything else is detected from the bytes themselves.
_ANYDOC_URL_FORMAT_HINT: dict[str, str] = {
    "application/pdf": "pdf",
    "text/csv": "csv",
    "application/csv": "csv",
}


def _is_plain_text_media_type(media_type: str) -> bool:
    """True for text payloads that are already readable without a doc engine."""
    if media_type in {"application/json", "application/xml"}:
        return True
    if media_type in _ANYDOC_URL_FORMAT_HINT:
        # CSV is rendered as a Markdown table by anydoc instead.
        return False
    return media_type.startswith("text/")


def _source_text(
    body: bytes,
    url: str,
    media_type: str,
    charset: str,
) -> tuple[str, str]:
    if media_type in _HTML_MEDIA_TYPES:
        return _html_text(body, charset)
    if _is_plain_text_media_type(media_type):
        return _url_title(url), body.decode(charset, errors="replace").strip()
    if not media_type or media_type == "application/octet-stream":
        # Servers frequently mislabel HTML as a generic byte stream (or send no
        # type at all). Sniff the body before handing it to the document engine.
        if _looks_like_html(body):
            return _html_text(body, charset)
    return _url_title(url), _anydoc_markdown(body, url, media_type)


def _looks_like_html(body: bytes) -> bool:
    head = body[:2048].lstrip().lower()
    return head.startswith((b"<!doctype html", b"<html")) or b"<html" in head


def _anydoc_markdown(body: bytes, url: str, media_type: str) -> str:
    """Convert a binary document body (PDF, Office, CSV, ...) to Markdown."""
    format_hint = _ANYDOC_URL_FORMAT_HINT.get(media_type)
    try:
        if format_hint is None:
            text = anydoc.to_markdown_bytes(body)
        else:
            text = anydoc.to_markdown_bytes(body, format_hint)
    except anydoc.NeedsOcrError as exc:
        raise SourceAccessError(
            "source_content_empty",
            url,
            "The source document is scanned and has no extractable text.",
        ) from exc
    except anydoc.EncryptedError as exc:
        raise SourceAccessError(
            "source_media_type_unsupported",
            url,
            "The source document is password protected.",
        ) from exc
    except anydoc.ConvertError as exc:
        raise SourceAccessError(
            "source_media_type_unsupported",
            url,
            "The source document could not be parsed.",
        ) from exc
    return text.strip()


def _extract_source_text(
    body: bytes,
    url: str,
    media_type: str,
    charset: str,
    requested_url: str,
) -> tuple[str, str]:
    try:
        return _source_text(body, url, media_type, charset)
    except SourceAccessError:
        raise
    except Exception as exc:
        raise SourceAccessError(
            "source_media_type_unsupported",
            requested_url,
            "The source content could not be safely extracted.",
        ) from exc


# Client-rendered application shells that ship almost no readable text before
# JavaScript runs. When the static body is thin and carries one of these
# markers, a one-shot browser render is worth attempting.
_CLIENT_RENDER_MARKERS: tuple[bytes, ...] = (
    b"__next_data__",
    b"window.__nuxt__",
    b'id="__nuxt"',
    b"window.__initial_state__",
    b"window.__apollo_state__",
    b"data-reactroot",
    b"data-server-rendered",
    b"ng-version",
    b'id="root"',
    b"id='root'",
    b'id="app"',
    b"id='app'",
    b'id="__next"',
)


def _looks_like_client_rendered(body: bytes) -> bool:
    sample = body[:200_000].lower()
    return any(marker in sample for marker in _CLIENT_RENDER_MARKERS)


def source_fallback_decision(
    body: bytes,
    media_type: str,
    text: str,
    minimum_text_characters: int = 200,
) -> SourceFallbackDecision:
    """Return a recovery decision for blocked or insufficient static HTML."""
    is_html = media_type in _HTML_MEDIA_TYPES or (
        (not media_type or media_type == "application/octet-stream")
        and _looks_like_html(body)
    )
    if not is_html:
        return SourceFallbackDecision()
    stripped = text.strip()
    if not stripped:
        return SourceFallbackDecision("empty_text")
    if len(stripped) < minimum_text_characters:
        return SourceFallbackDecision("short_text")
    # A large markup payload that renders to very little readable text is the
    # signature of a script-driven page whose content never made it into the
    # static HTML.
    if len(body) >= 60_000 and len(stripped) < len(body) * 0.06:
        return SourceFallbackDecision("low_text_ratio")
    if len(stripped) < 1_200 and _looks_like_client_rendered(body):
        return SourceFallbackDecision("client_rendered_shell")
    return SourceFallbackDecision()


def _url_title(url: str) -> str:
    path = urlsplit(url).path.rstrip("/")
    return path.rsplit("/", 1)[-1] or urlsplit(url).hostname or "Untitled source"


# Structural chrome that never carries the article body.
_ALWAYS_DROP_TAGS: tuple[str, ...] = (
    "script",
    "style",
    "noscript",
    "template",
    "iframe",
    "svg",
    "canvas",
    "form",
    "nav",
    "button",
    "select",
    "fieldset",
    "dialog",
)
# Page chrome unless it is nested inside the article/main region, where the same
# tags are used for the headline block or an end-of-piece note.
_CONTEXTUAL_DROP_TAGS: tuple[str, ...] = ("header", "footer", "aside")
_BOILERPLATE_ROLES = frozenset({
    "navigation",
    "banner",
    "contentinfo",
    "complementary",
    "search",
    "menu",
    "menubar",
    "dialog",
    "alertdialog",
    "tablist",
    "toolbar",
})
_BOILERPLATE_PATTERN = re.compile(
    r"(?:^|[-_ ])(?:nav|navbar|navigation|menu|sidebar|side-bar|footer|header"
    r"|masthead|comment|comments|share|sharing|social|related|recirc|recommend"
    r"|promo|promoted|advert|advertisement|sponsor|banner|popup|modal|overlay"
    r"|cookie|consent|gdpr|subscribe|subscription|newsletter|signup|paywall"
    r"|breadcrumb|breadcrumbs|pager|pagination|pagenav|toolbar|widget|utility"
    r"|skip-link|screen-reader|visually-hidden|sr-only)(?:[-_ ]|$)",
    re.IGNORECASE,
)


def _live(element) -> bool:
    """False once a prior pass decomposed the element.

    ``decompose()`` wipes the element's ``__dict__`` (dropping ``attrs``,
    ``parent`` and friends) and only restores ``_decomposed``/``name``, so any
    later ``.get()`` or ``.find_parent()`` on it would raise. Every pass filters
    through here before touching an element a previous pass may have removed.
    """
    return not getattr(element, "_decomposed", False)


def _drop(element) -> None:
    """decompose() an element unless a prior pass already removed it."""
    if _live(element):
        element.decompose()


def _html_text(body: bytes, charset: str = "utf-8") -> tuple[str, str]:
    markup = body.decode(charset, errors="replace")
    try:
        soup = BeautifulSoup(markup, "lxml")
    except Exception:  # pragma: no cover - parser availability fallback
        soup = BeautifulSoup(markup, "html.parser")

    title = _html_title(soup)

    for comment in soup.find_all(string=lambda value: isinstance(value, Comment)):
        comment.extract()
    for element in list(soup.find_all(_ALWAYS_DROP_TAGS)):
        _drop(element)
    for element in list(soup.find_all(_CONTEXTUAL_DROP_TAGS)):
        if _live(element) and not element.find_parent(["article", "main"]):
            _drop(element)
    for element in list(soup.find_all(attrs={"role": True})):
        if not _live(element):
            continue
        if str(element.get("role", "")).strip().lower() in _BOILERPLATE_ROLES:
            _drop(element)
    for element in list(soup.find_all(attrs={"aria-hidden": "true"})):
        _drop(element)
    # Class/id-flagged chrome is only removed when it is genuinely small and
    # carries no sub-article structure, so a mislabeled content wrapper is never
    # dropped with the real text inside it.
    flagged = list(soup.find_all(class_=_BOILERPLATE_PATTERN))
    flagged += list(soup.find_all(id=_BOILERPLATE_PATTERN))
    for element in flagged:
        if not _live(element) or element.name in (None, "html", "body"):
            continue
        if len(element.get_text(" ", strip=True)) <= 200 and not element.find(
            ["article", "p"]
        ):
            _drop(element)

    root = _main_content_root(soup)
    text = _collapse_text(root.get_text(" ")) if root is not None else ""

    fallback_root = soup.body or soup
    full_text = _collapse_text(fallback_root.get_text(" "))
    if len(text) < 160 and len(full_text) > len(text):
        # The heuristic narrowed too aggressively (or the readable body simply
        # lives outside a recognizable container); keep the fuller extraction.
        text = full_text

    return title, text


def _html_title(soup: BeautifulSoup) -> str:
    meta = soup.find("meta", attrs={"property": "og:title"})
    if meta is not None:
        content = str(meta.get("content", "")).strip()
        if content:
            return _collapse_text(content)
    if soup.title is not None and soup.title.string:
        collapsed = _collapse_text(soup.title.string)
        if collapsed:
            return collapsed
    heading = soup.find(["h1", "h2"])
    if heading is not None:
        collapsed = _collapse_text(heading.get_text(" "))
        if collapsed:
            return collapsed
    return "Untitled source"


def _main_content_root(soup: BeautifulSoup):
    for selector in ("main", "[role=main]", "article"):
        node = soup.select_one(selector)
        if node is not None and len(node.get_text(" ", strip=True)) >= 200:
            return node

    best = None
    best_score = 0.0
    for candidate in soup.find_all(["div", "section", "article"]):
        score = _candidate_score(candidate)
        if score > best_score:
            best_score = score
            best = candidate
    return best or soup.body or soup


def _candidate_score(node) -> float:
    paragraphs = node.find_all("p", recursive=True)
    if not paragraphs:
        return 0.0
    text = node.get_text(" ", strip=True)
    text_length = len(text)
    if text_length < 200:
        return 0.0
    link_length = sum(
        len(anchor.get_text(" ", strip=True))
        for anchor in node.find_all("a")
    )
    link_density = link_length / text_length if text_length else 1.0
    if link_density > 0.5:
        return 0.0
    return text_length * (1.0 - link_density) + 25.0 * len(paragraphs)


def _collapse_text(value: str) -> str:
    return " ".join(str(value).split()).strip()


def url_allowed_by_domains(
    url: str,
    include_domains: Sequence[str] = (),
    exclude_domains: Sequence[str] = (),
) -> bool:
    try:
        host = urlsplit(url).hostname
        if not host:
            return False
        normalized_host = host.encode("idna").decode("ascii").lower()
        includes = tuple(_normalized_domain(value) for value in include_domains)
        excludes = tuple(_normalized_domain(value) for value in exclude_domains)
    except (UnicodeError, ValueError):
        return False
    if any(_domain_matches(normalized_host, value) for value in excludes):
        return False
    return not includes or any(
        _domain_matches(normalized_host, value)
        for value in includes
    )


def _normalized_domain(value: str) -> str:
    return value.rstrip(".").encode("idna").decode("ascii").lower()


def _domain_matches(host: str, domain: str) -> bool:
    return host == domain or host.endswith(f".{domain}")


def _hostname_forbidden(host: str) -> bool:
    normalized = host.rstrip(".").lower()
    if (
        normalized == "localhost"
        or normalized.endswith(".localhost")
        or normalized.endswith(".local")
        or normalized.endswith(".home.arpa")
    ):
        return True
    try:
        return not ipaddress.ip_address(normalized).is_global
    except ValueError:
        return False


class SystemHostResolver:
    async def resolve(self, host: str, port: int) -> tuple[str, ...]:
        loop = asyncio.get_running_loop()
        records = await loop.getaddrinfo(
            host,
            port,
            family=socket.AF_UNSPEC,
            type=socket.SOCK_STREAM,
            proto=socket.IPPROTO_TCP,
        )
        return tuple(
            dict.fromkeys(
                str(ipaddress.ip_address(record[4][0]))
                for record in records
            )
        )


class AioHttpSourceTransport:
    def __init__(self, proxy: str | None = None) -> None:
        self._proxy = proxy or None

    async def fetch(
        self,
        url: str,
        *,
        addresses: Sequence[str],
        max_bytes: int,
        timeout_seconds: int,
    ) -> SourceHttpResponse:
        host = urlsplit(url).hostname or ""
        if self._proxy:
            # The proxy owns DNS resolution and the outbound connection, so the
            # address set cannot be pinned at the socket layer. The caller has
            # already rejected forbidden hostnames and non-global resolved
            # addresses before this fetch runs.
            connector = aiohttp.TCPConnector(use_dns_cache=False, limit=1)
        else:
            connector = aiohttp.TCPConnector(
                resolver=_PinnedResolver(host, addresses),
                use_dns_cache=False,
                limit=1,
            )
        timeout = aiohttp.ClientTimeout(total=timeout_seconds)
        try:
            async with aiohttp.ClientSession(
                connector=connector,
                timeout=timeout,
                trust_env=False,
                auto_decompress=True,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/131.0.0.0 Safari/537.36"
                    ),
                    "Accept": (
                        "text/html,application/xhtml+xml,text/plain,"
                        "application/pdf,"
                        "application/vnd.openxmlformats-officedocument"
                        ".wordprocessingml.document,"
                        "application/vnd.openxmlformats-officedocument"
                        ".spreadsheetml.sheet,"
                        "application/vnd.openxmlformats-officedocument"
                        ".presentationml.presentation;q=0.9,"
                        "*/*;q=0.1"
                    ),
                    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                    "Cache-Control": "no-cache",
                },
            ) as session:
                async with session.get(
                    url,
                    allow_redirects=False,
                    proxy=self._proxy,
                ) as response:
                    content_length = response.headers.get("Content-Length")
                    if (
                        content_length is not None
                        and content_length.isdigit()
                        and int(content_length) > max_bytes
                    ):
                        raise SourceAccessError(
                            "source_response_too_large",
                            url,
                            "The source response exceeds the allowed size.",
                        )
                    peer_ip = _response_peer_ip(response)
                    body = bytearray()
                    async for chunk in response.content.iter_chunked(64 * 1024):
                        body.extend(chunk)
                        if len(body) > max_bytes:
                            raise SourceAccessError(
                                "source_response_too_large",
                                url,
                                "The source response exceeds the allowed size.",
                            )
                    return SourceHttpResponse(
                        status=response.status,
                        headers={
                            key.lower(): value
                            for key, value in response.headers.items()
                        },
                        body=bytes(body),
                        peer_ip=peer_ip,
                        via_proxy=bool(self._proxy),
                    )
        except SourceAccessError:
            raise
        except (
            aiohttp.ClientError,
            asyncio.TimeoutError,
        ) as exc:
            raise SourceAccessError(
                "source_unavailable",
                url,
                "The source could not be downloaded.",
            ) from exc


class _PinnedResolver(AbstractResolver):
    def __init__(self, hostname: str, addresses: Sequence[str]) -> None:
        self._hostname = hostname
        self._addresses = tuple(addresses)

    async def resolve(
        self,
        host: str,
        port: int = 0,
        family: socket.AddressFamily = socket.AF_UNSPEC,
    ) -> list[dict[str, object]]:
        if host != self._hostname:
            return []
        results: list[dict[str, object]] = []
        for address in self._addresses:
            parsed = ipaddress.ip_address(address)
            address_family = (
                socket.AF_INET6 if parsed.version == 6 else socket.AF_INET
            )
            if family not in {socket.AF_UNSPEC, address_family}:
                continue
            results.append(
                {
                    "hostname": host,
                    "host": str(parsed),
                    "port": port,
                    "family": address_family,
                    "proto": socket.IPPROTO_TCP,
                    "flags": socket.AI_NUMERICHOST,
                }
            )
        return results

    async def close(self) -> None:
        return None


def _response_peer_ip(response: aiohttp.ClientResponse) -> str:
    connection = response.connection
    transport = connection.transport if connection is not None else None
    if transport is None:
        protocol = getattr(response, "_protocol", None)
        transport = getattr(protocol, "transport", None)
    peer = transport.get_extra_info("peername") if transport is not None else None
    if not peer:
        raise SourceAccessError(
            "source_peer_forbidden",
            str(response.url),
            "The source connection peer could not be verified.",
        )
    return str(peer[0])


def _assert_verified_peer(
    peer_ip: str,
    addresses: Sequence[str],
    requested_url: str,
) -> None:
    peer = ipaddress.ip_address(peer_ip)
    normalized_addresses = {
        str(ipaddress.ip_address(address))
        for address in addresses
    }
    if not peer.is_global or str(peer) not in normalized_addresses:
        raise SourceAccessError(
            "source_peer_forbidden",
            requested_url,
            "The source connection reached an unexpected address.",
        )


def default_source_materializer(
    limits: SourceAccessLimits | None = None,
) -> SourceMaterializer:
    resolved_limits = limits or SourceAccessLimits(
        timeout_seconds=max(
            1,
            _positive_environment("GPTR_SOURCE_FALLBACK_TIMEOUT_MS", 45_000) // 1000,
        ),
    )
    proxy = _source_http_proxy()
    fallback_transport = None
    fallback_strategy = "fallback"
    providers = tuple(
        value.strip().lower()
        for value in os.getenv("GPTR_SOURCE_FALLBACK_PROVIDERS", "").split(",")
        if value.strip()
    )
    if not providers:
        providers = ("browser",)
    if "browser" in providers:
        from .browser_source_fetcher import PlaywrightSourceTransport

        fallback_transport = PlaywrightSourceTransport(
            os.getenv("PLAYWRIGHT_BROWSERS_PATH")
            or str(Path(".think-tank") / "playwright-browsers"),
            proxy=proxy,
        )
        fallback_strategy = "browser"
    return SourceMaterializer(
        resolver=SystemHostResolver(),
        transport=AioHttpSourceTransport(proxy=proxy),
        limits=resolved_limits,
        fallback_transport=fallback_transport,
        fallback_strategy=fallback_strategy,
    )


def _source_http_proxy() -> str | None:
    """Egress proxy for outbound source fetches (``GPTR_SOURCE_HTTP_PROXY``).

    The proxy is opt-in and applies only to the specified-URL reader, never to
    platform-internal traffic. SSRF hostname and pre-resolution address checks
    stay in force; only the socket-level peer pin is relaxed, because the proxy
    is the peer.
    """
    for name in ("GPTR_SOURCE_HTTP_PROXY", "GPTR_SOURCE_HTTPS_PROXY"):
        raw = os.getenv(name, "").strip()
        if not raw:
            continue
        parsed = urlsplit(raw)
        if parsed.scheme in {"http", "https"} and parsed.hostname:
            return raw
    return None


def _positive_environment(name: str, fallback: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return fallback
    try:
        value = int(raw)
    except ValueError:
        return fallback
    return value if value > 0 else fallback
