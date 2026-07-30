from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Sequence
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Mapping
from urllib.parse import urljoin, urlsplit, urlunsplit

import aiohttp
import fitz
from aiohttp.abc import AbstractResolver


@dataclass(frozen=True)
class SourceHttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes
    peer_ip: str


@dataclass(frozen=True)
class SourceAccessLimits:
    max_response_bytes: int = 5 * 1024 * 1024
    max_total_bytes: int = 20 * 1024 * 1024
    max_redirects: int = 5
    timeout_seconds: int = 30
    max_text_characters: int = 200_000


@dataclass(frozen=True)
class MaterializedSource:
    requested_url: str
    canonical_url: str
    title: str
    media_type: str
    text: str
    byte_size: int
    redirect_chain: tuple[str, ...] = ()


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


class SourceMaterializer:
    def __init__(
        self,
        resolver,
        transport,
        limits: SourceAccessLimits | None = None,
    ) -> None:
        self._resolver = resolver
        self._transport = transport
        self._limits = limits or SourceAccessLimits()

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
            peer = ipaddress.ip_address(response.peer_ip)
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
                raise SourceAccessError(
                    "source_unavailable",
                    requested_url,
                    "The source returned an unsuccessful response.",
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
            try:
                title, text = _source_text(
                    response.body,
                    current_url,
                    media_type,
                    charset,
                )
            except SourceAccessError:
                raise
            except Exception as exc:
                raise SourceAccessError(
                    "source_media_type_unsupported",
                    requested_url,
                    "The source content could not be safely extracted.",
                ) from exc
            text = text[:self._limits.max_text_characters]
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
            )
        raise SourceAccessError(
            "source_redirect_limit",
            requested_url,
            "The source exceeded the redirect limit.",
        )


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


def _source_text(
    body: bytes,
    url: str,
    media_type: str,
    charset: str,
) -> tuple[str, str]:
    if media_type == "text/html":
        return _html_text(body, charset)
    if media_type == "text/plain":
        return _url_title(url), body.decode(charset, errors="replace").strip()
    if media_type == "application/pdf":
        document = fitz.open(stream=body, filetype="pdf")
        try:
            metadata = document.metadata or {}
            title = str(metadata.get("title") or "").strip() or _url_title(url)
            text = "\n\n".join(
                page.get_text("text").strip()
                for page in document
                if page.get_text("text").strip()
            )
            return title, text
        finally:
            document.close()
    raise SourceAccessError(
        "source_media_type_unsupported",
        url,
        "The source content type is not supported.",
    )


def _url_title(url: str) -> str:
    path = urlsplit(url).path.rstrip("/")
    return path.rsplit("/", 1)[-1] or urlsplit(url).hostname or "Untitled source"


def _html_text(body: bytes, charset: str = "utf-8") -> tuple[str, str]:
    parser = _HtmlTextExtractor()
    parser.feed(body.decode(charset, errors="replace"))
    return parser.title, " ".join(parser.parts).strip()


class _HtmlTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self._ignored_depth = 0
        self._in_title = False
        self._title_parts: list[str] = []

    @property
    def title(self) -> str:
        return " ".join(self._title_parts).strip() or "Untitled source"

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        del attrs
        if tag in {"script", "style", "noscript"}:
            self._ignored_depth += 1
        if tag == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self._ignored_depth > 0:
            self._ignored_depth -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._ignored_depth > 0:
            return
        text = " ".join(data.split())
        if not text:
            return
        self.parts.append(text)
        if self._in_title:
            self._title_parts.append(text)


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
    async def fetch(
        self,
        url: str,
        *,
        addresses: Sequence[str],
        max_bytes: int,
        timeout_seconds: int,
    ) -> SourceHttpResponse:
        host = urlsplit(url).hostname or ""
        resolver = _PinnedResolver(host, addresses)
        connector = aiohttp.TCPConnector(
            resolver=resolver,
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
                    "User-Agent": "Think-Tank-Source-Reader/1.0",
                    "Accept": (
                        "text/html,text/plain,application/pdf;q=0.9,"
                        "*/*;q=0.1"
                    ),
                },
            ) as session:
                async with session.get(
                    url,
                    allow_redirects=False,
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


def default_source_materializer(
    limits: SourceAccessLimits | None = None,
) -> SourceMaterializer:
    return SourceMaterializer(
        resolver=SystemHostResolver(),
        transport=AioHttpSourceTransport(),
        limits=limits,
    )
