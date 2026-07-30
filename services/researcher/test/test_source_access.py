from __future__ import annotations

import asyncio

import fitz
import pytest

from app.source_access import (
    SourceAccessError,
    SourceAccessLimits,
    SourceHttpResponse,
    SourceMaterializer,
    url_allowed_by_domains,
)


class StubResolver:
    def __init__(self, *addresses: str) -> None:
        self.addresses = addresses

    async def resolve(self, host: str, port: int) -> tuple[str, ...]:
        return self.addresses


class MappingResolver:
    def __init__(self, addresses: dict[str, tuple[str, ...]]) -> None:
        self.addresses = addresses

    async def resolve(self, host: str, port: int) -> tuple[str, ...]:
        del port
        return self.addresses[host]


class UnexpectedResolver:
    async def resolve(self, host: str, port: int) -> tuple[str, ...]:
        raise AssertionError("forbidden hostnames must not reach DNS")


class UnexpectedTransport:
    async def fetch(self, *args, **kwargs):
        raise AssertionError("unsafe addresses must not reach HTTP transport")


class StubTransport:
    def __init__(self, response: SourceHttpResponse) -> None:
        self.response = response

    async def fetch(self, *args, **kwargs) -> SourceHttpResponse:
        return self.response


class SequenceTransport:
    def __init__(self, *responses: SourceHttpResponse) -> None:
        self.responses = list(responses)
        self.calls = 0

    async def fetch(self, *args, **kwargs) -> SourceHttpResponse:
        response = self.responses[self.calls]
        self.calls += 1
        return response


def test_private_dns_result_is_rejected_before_http_access() -> None:
    materializer = SourceMaterializer(
        resolver=StubResolver("127.0.0.1"),
        transport=UnexpectedTransport(),
    )

    with pytest.raises(SourceAccessError) as captured:
        asyncio.run(materializer.materialize(["https://public.example/report"]))

    assert captured.value.code == "source_address_forbidden"
    assert captured.value.url == "https://public.example/report"


def test_public_html_is_materialized_as_canonical_text_evidence() -> None:
    materializer = SourceMaterializer(
        resolver=StubResolver("93.184.216.34"),
        transport=StubTransport(
            SourceHttpResponse(
                status=200,
                headers={"content-type": "text/html; charset=utf-8"},
                body=(
                    b"<html><head><title>Annual Report</title></head>"
                    b"<body><main>Revenue grew by 12 percent.</main>"
                    b"<script>secret()</script></body></html>"
                ),
                peer_ip="93.184.216.34",
            )
        ),
    )

    result = asyncio.run(
        materializer.materialize(["HTTPS://Public.Example:443/report"])
    )

    assert result.total_bytes == 132
    assert len(result.sources) == 1
    assert result.sources[0].canonical_url == "https://public.example/report"
    assert result.sources[0].title == "Annual Report"
    assert result.sources[0].text == "Annual Report Revenue grew by 12 percent."


def test_plain_text_respects_declared_charset_and_text_budget() -> None:
    body = "季度报告：收入增长百分之十二。".encode("gb18030")
    materializer = SourceMaterializer(
        resolver=StubResolver("93.184.216.34"),
        transport=StubTransport(
            SourceHttpResponse(
                status=200,
                headers={"content-type": "text/plain; charset=gb18030"},
                body=body,
                peer_ip="93.184.216.34",
            )
        ),
        limits=SourceAccessLimits(max_text_characters=8),
    )

    result = asyncio.run(
        materializer.materialize(["https://public.example/report.txt"])
    )

    assert result.sources[0].media_type == "text/plain"
    assert result.sources[0].title == "report.txt"
    assert result.sources[0].text == "季度报告：收入增"


def test_pdf_text_is_extracted_without_a_second_network_request() -> None:
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), "Verified annual revenue: 42 million.")
    body = document.tobytes()
    document.close()
    materializer = SourceMaterializer(
        resolver=StubResolver("93.184.216.34"),
        transport=StubTransport(
            SourceHttpResponse(
                status=200,
                headers={"content-type": "application/pdf"},
                body=body,
                peer_ip="93.184.216.34",
            )
        ),
    )

    result = asyncio.run(
        materializer.materialize(["https://public.example/annual.pdf"])
    )

    assert result.sources[0].media_type == "application/pdf"
    assert result.sources[0].title == "annual.pdf"
    assert "Verified annual revenue: 42 million." in result.sources[0].text


def test_url_credentials_are_rejected_before_dns_resolution() -> None:
    materializer = SourceMaterializer(
        resolver=StubResolver("93.184.216.34"),
        transport=UnexpectedTransport(),
    )

    with pytest.raises(SourceAccessError) as captured:
        asyncio.run(
            materializer.materialize(
                ["https://user:password@public.example/report"]
            )
        )

    assert captured.value.code == "source_url_invalid"


def test_redirect_to_private_address_is_rejected_before_second_request() -> None:
    transport = SequenceTransport(
        SourceHttpResponse(
            status=302,
            headers={"location": "http://internal.example/admin"},
            body=b"",
            peer_ip="93.184.216.34",
        )
    )
    materializer = SourceMaterializer(
        resolver=MappingResolver(
            {
                "public.example": ("93.184.216.34",),
                "internal.example": ("127.0.0.1",),
            }
        ),
        transport=transport,
    )

    with pytest.raises(SourceAccessError) as captured:
        asyncio.run(
            materializer.materialize(["https://public.example/report"])
        )

    assert captured.value.code == "source_redirect_forbidden"
    assert transport.calls == 1


def test_redirect_to_a_disallowed_url_form_is_a_redirect_failure() -> None:
    materializer = SourceMaterializer(
        resolver=StubResolver("93.184.216.34"),
        transport=StubTransport(
            SourceHttpResponse(
                status=302,
                headers={"location": "file:///server/private"},
                body=b"",
                peer_ip="93.184.216.34",
            )
        ),
    )

    with pytest.raises(SourceAccessError) as captured:
        asyncio.run(
            materializer.materialize(["https://public.example/report"])
        )

    assert captured.value.code == "source_redirect_forbidden"


def test_response_body_cannot_exceed_per_source_limit() -> None:
    materializer = SourceMaterializer(
        resolver=StubResolver("93.184.216.34"),
        transport=StubTransport(
            SourceHttpResponse(
                status=200,
                headers={"content-type": "text/html"},
                body=b"x" * (5 * 1024 * 1024 + 1),
                peer_ip="93.184.216.34",
            )
        ),
    )

    with pytest.raises(SourceAccessError) as captured:
        asyncio.run(
            materializer.materialize(["https://public.example/large"])
        )

    assert captured.value.code == "source_response_too_large"


def test_materialized_sources_share_one_total_download_budget() -> None:
    response = SourceHttpResponse(
        status=200,
        headers={"content-type": "text/html"},
        body=b"<p>1234</p>",
        peer_ip="93.184.216.34",
    )
    materializer = SourceMaterializer(
        resolver=StubResolver("93.184.216.34"),
        transport=SequenceTransport(response, response),
        limits=SourceAccessLimits(
            max_response_bytes=20,
            max_total_bytes=20,
        ),
    )

    with pytest.raises(SourceAccessError) as captured:
        asyncio.run(
            materializer.materialize(
                [
                    "https://public.example/one",
                    "https://public.example/two",
                ]
            )
        )

    assert captured.value.code == "source_total_too_large"


def test_equivalent_urls_are_fetched_once_after_normalization() -> None:
    transport = SequenceTransport(
        SourceHttpResponse(
            status=200,
            headers={"content-type": "text/html"},
            body=b"<p>Evidence</p>",
            peer_ip="93.184.216.34",
        )
    )
    materializer = SourceMaterializer(
        resolver=StubResolver("93.184.216.34"),
        transport=transport,
    )

    result = asyncio.run(
        materializer.materialize(
            [
                "HTTPS://Public.Example:443/report",
                "https://public.example/report",
            ]
        )
    )

    assert len(result.sources) == 1
    assert transport.calls == 1


def test_domain_allowlist_does_not_accept_a_lookalike_suffix() -> None:
    assert url_allowed_by_domains(
        "https://news.example.com/article",
        include_domains=("example.com",),
    )
    assert not url_allowed_by_domains(
        "https://example.com.evil.test/article",
        include_domains=("example.com",),
    )


def test_localhost_is_rejected_before_dns_resolution() -> None:
    materializer = SourceMaterializer(
        resolver=UnexpectedResolver(),
        transport=UnexpectedTransport(),
    )

    with pytest.raises(SourceAccessError) as captured:
        asyncio.run(materializer.materialize(["http://localhost/admin"]))

    assert captured.value.code == "source_address_forbidden"


def test_dns_transport_errors_use_a_stable_public_failure() -> None:
    class FailingResolver:
        async def resolve(self, host: str, port: int) -> tuple[str, ...]:
            del host, port
            raise OSError("private resolver detail")

    materializer = SourceMaterializer(
        resolver=FailingResolver(),
        transport=UnexpectedTransport(),
    )

    result = asyncio.run(
        materializer.materialize(["https://public.example/report"])
    )

    assert result.sources == ()
    assert result.failures[0].code == "source_unavailable"
    assert "private resolver detail" not in result.failures[0].message


def test_ordinary_unavailable_source_is_recorded_while_others_continue() -> None:
    resolver = MappingResolver({
        "missing.example": ("93.184.216.34",),
        "public.example": ("93.184.216.35",),
    })
    transport = SequenceTransport(
        SourceHttpResponse(
            status=503,
            headers={"content-type": "text/plain"},
            body=b"unavailable",
            peer_ip="93.184.216.34",
        ),
        SourceHttpResponse(
            status=200,
            headers={"content-type": "text/plain"},
            body=b"verified evidence",
            peer_ip="93.184.216.35",
        ),
    )
    materializer = SourceMaterializer(
        resolver=resolver,
        transport=transport,
    )

    result = asyncio.run(
        materializer.materialize([
            "https://missing.example/report",
            "https://public.example/report",
        ])
    )

    assert [source.canonical_url for source in result.sources] == [
        "https://public.example/report"
    ]
    assert [failure.code for failure in result.failures] == [
        "source_unavailable"
    ]
    assert result.failures[0].url == "https://missing.example/report"
