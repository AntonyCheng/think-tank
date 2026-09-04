from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .gptr_compat import load_gpt_researcher
from .source_access import url_allowed_by_domains


RetrieverId = Literal[
    "duckduckgo",
    "searx",
    "tavily",
    "bocha",
    "arxiv",
    "openalex",
    "semantic_scholar",
    "pubmed_central",
]
RetrieverCategory = Literal["web", "academic"]


@dataclass(frozen=True)
class RetrieverCapability:
    id: RetrieverId
    label: str
    category: RetrieverCategory
    credential_required: bool
    timeout_ms: int


@dataclass(frozen=True)
class RetrieverCatalog:
    retrievers: tuple[RetrieverCapability, ...]
    max_retrievers: int


@dataclass(frozen=True)
class _RetrieverSpec:
    id: RetrieverId
    label: str
    category: RetrieverCategory
    required_environment: tuple[str, ...] = ()
    credential_required: bool = False


_RETRIEVERS = (
    _RetrieverSpec("duckduckgo", "DuckDuckGo", "web"),
    _RetrieverSpec(
        "searx",
        "SearXNG",
        "web",
        required_environment=("SEARX_URL",),
    ),
    _RetrieverSpec(
        "tavily",
        "Tavily",
        "web",
        required_environment=("TAVILY_API_KEY",),
        credential_required=True,
    ),
    _RetrieverSpec(
        "bocha",
        "博查",
        "web",
        required_environment=("BOCHA_API_KEY",),
        credential_required=True,
    ),
    _RetrieverSpec("arxiv", "arXiv", "academic"),
    _RetrieverSpec("openalex", "OpenAlex", "academic"),
    _RetrieverSpec(
        "semantic_scholar",
        "Semantic Scholar",
        "academic",
    ),
    _RetrieverSpec(
        "pubmed_central",
        "PubMed Central",
        "academic",
    ),
)
_RETRIEVER_BY_ID = {item.id: item for item in _RETRIEVERS}
_TRACKING_QUERY_PARAMETERS = {
    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid",
}


@dataclass
class _ProviderStats:
    id: RetrieverId
    attempts: int = 0
    returned: int = 0
    accepted: int = 0
    duplicates: int = 0
    domain_rejected: int = 0
    errors: int = 0
    timeouts: int = 0
    last_error: str | None = None


class RetrieverRuntime:
    def __init__(
        self,
        retrievers: tuple[RetrieverId, ...],
        *,
        installed: bool,
    ) -> None:
        self._retrievers = retrievers
        self._installed = installed
        self._stats = {
            provider_id: _ProviderStats(provider_id)
            for provider_id in retrievers
        }
        self._seen_by_query: dict[str, dict[str, RetrieverId]] = {}
        self._lock = threading.Lock()

    @property
    def installed(self) -> bool:
        return self._installed

    def summary(self) -> dict[str, Any]:
        with self._lock:
            providers = [
                self._provider_summary(self._stats[provider_id])
                for provider_id in self._retrievers
            ]
        attempts = sum(item["attempts"] for item in providers)
        terminal_failures = {"failed", "timed_out"}
        attempted_providers = [
            item for item in providers if item["attempts"] > 0
        ]
        return {
            "configured": list(self._retrievers),
            "installed": self._installed,
            "attempts": attempts,
            "returned": sum(item["returned"] for item in providers),
            "accepted": sum(item["accepted"] for item in providers),
            "duplicates": sum(item["duplicates"] for item in providers),
            "domainRejected": sum(
                item["domainRejected"] for item in providers
            ),
            "allFailed": (
                bool(attempted_providers)
                and all(
                    item["status"] in terminal_failures
                    for item in attempted_providers
                )
            ),
            "providers": providers,
        }

    def record_attempt(self, provider_id: RetrieverId) -> int:
        with self._lock:
            stats = self._stats[provider_id]
            stats.attempts += 1
            return stats.attempts

    def record_error(
        self,
        provider_id: RetrieverId,
        error_name: str,
        *,
        timed_out: bool = False,
    ) -> None:
        with self._lock:
            stats = self._stats[provider_id]
            if timed_out:
                stats.timeouts += 1
            else:
                stats.errors += 1
            stats.last_error = error_name

    def filter_results(
        self,
        provider_id: RetrieverId,
        query_text: str,
        results: list[Any],
        include_domains: tuple[str, ...],
        exclude_domains: tuple[str, ...],
    ) -> list[dict[str, Any]]:
        accepted: list[dict[str, Any]] = []
        query_key = " ".join(query_text.casefold().split())
        with self._lock:
            stats = self._stats[provider_id]
            stats.returned += len(results)
            seen = self._seen_by_query.setdefault(query_key, {})
            for result in results:
                url = _result_url(result)
                if (
                    url is None
                    or not url_allowed_by_domains(
                        url,
                        include_domains,
                        exclude_domains,
                    )
                ):
                    stats.domain_rejected += 1
                    continue
                canonical = _canonical_result_url(url)
                owner = seen.get(canonical)
                if owner is not None and owner != provider_id:
                    stats.duplicates += 1
                    continue
                seen[canonical] = provider_id
                accepted.append(result)
                stats.accepted += 1
        return accepted

    @staticmethod
    def _provider_summary(stats: _ProviderStats) -> dict[str, Any]:
        if stats.accepted > 0:
            status = "succeeded"
        elif stats.timeouts > 0:
            status = "timed_out"
        elif stats.errors > 0:
            status = "failed"
        elif stats.attempts > 0:
            status = "empty"
        else:
            status = "idle"
        return {
            "id": stats.id,
            "status": status,
            "attempts": stats.attempts,
            "returned": stats.returned,
            "accepted": stats.accepted,
            "duplicates": stats.duplicates,
            "domainRejected": stats.domain_rejected,
            "errors": stats.errors,
            "timeouts": stats.timeouts,
            "lastError": stats.last_error,
        }


def install_retriever_runtime(
    researcher: Any,
    retrievers: tuple[RetrieverId, ...],
    *,
    include_domains: tuple[str, ...] = (),
    exclude_domains: tuple[str, ...] = (),
    timeout_ms: int = 20_000,
    observer: Callable[[str, dict[str, Any]], None] | None = None,
) -> RetrieverRuntime:
    if not retrievers:
        raise ValueError("At least one retriever must be selected.")
    if timeout_ms < 1:
        raise ValueError("Retriever timeout must be positive.")

    retriever_classes = list(getattr(researcher, "retrievers", ()) or ())
    runtime = RetrieverRuntime(
        retrievers,
        installed=bool(retriever_classes),
    )
    if not retriever_classes:
        return runtime
    if len(retriever_classes) != len(retrievers):
        raise ValueError(
            "GPTR retriever configuration does not match the selected "
            "research profile."
        )

    researcher.retrievers = [
        _observed_retriever(
            retriever_class,
            provider_id,
            provider_index=provider_index,
            provider_count=len(retrievers),
            timeout_ms=timeout_ms,
            include_domains=include_domains,
            exclude_domains=exclude_domains,
            runtime=runtime,
            observer=observer,
        )
        for provider_index, (
            provider_id,
            retriever_class,
        ) in enumerate(zip(
            retrievers,
            retriever_classes,
            strict=True,
        ))
    ]
    return runtime


def _observed_retriever(
    retriever_class,
    provider_id: RetrieverId,
    *,
    provider_index: int,
    provider_count: int,
    timeout_ms: int,
    include_domains: tuple[str, ...],
    exclude_domains: tuple[str, ...],
    runtime: RetrieverRuntime,
    observer: Callable[[str, dict[str, Any]], None] | None,
):
    class ObservedRetriever:
        def __init__(self, *args, **kwargs) -> None:
            self._query_text = _retriever_query(args, kwargs)
            self._delegate = retriever_class(*args, **kwargs)

        def search(self, *args, **kwargs):
            call_args, call_kwargs, has_budget = _fair_search_budget(
                args,
                kwargs,
                provider_count,
                provider_index,
            )
            if not has_budget:
                return []
            attempt = runtime.record_attempt(provider_id)
            started_at = time.monotonic()
            if observer:
                observer(
                    "retriever.query_started",
                    {
                        "retriever": provider_id,
                        "attempt": attempt,
                    },
                )
            try:
                results = _call_with_timeout(
                    lambda: self._delegate.search(
                        *call_args,
                        **call_kwargs,
                    ),
                    timeout_ms,
                )
            except TimeoutError:
                runtime.record_error(
                    provider_id,
                    "timeout",
                    timed_out=True,
                )
                if observer:
                    observer(
                        "retriever.query_finished",
                        {
                            "retriever": provider_id,
                            "attempt": attempt,
                            "status": "timed_out",
                            "durationMs": _elapsed_ms(started_at),
                            "returned": 0,
                            "accepted": 0,
                        },
                    )
                return []
            except Exception as exc:
                runtime.record_error(
                    provider_id,
                    type(exc).__name__,
                )
                if observer:
                    observer(
                        "retriever.query_finished",
                        {
                            "retriever": provider_id,
                            "attempt": attempt,
                            "status": "failed",
                            "durationMs": _elapsed_ms(started_at),
                            "returned": 0,
                            "accepted": 0,
                            "errorCode": type(exc).__name__,
                        },
                    )
                return []
            raw_results = list(results or ())
            accepted = runtime.filter_results(
                provider_id,
                self._query_text,
                raw_results,
                include_domains,
                exclude_domains,
            )
            if observer:
                observer(
                    "retriever.query_finished",
                    {
                        "retriever": provider_id,
                        "attempt": attempt,
                        "status": "succeeded" if accepted else "empty",
                        "durationMs": _elapsed_ms(started_at),
                        "returned": len(raw_results),
                        "accepted": len(accepted),
                    },
                )
            return accepted

        def __getattr__(self, name: str):
            return getattr(self._delegate, name)

    ObservedRetriever.__name__ = (
        f"Observed{provider_id.replace('_', ' ').title().replace(' ', '')}"
        f"{retriever_class.__name__}"
    )
    return ObservedRetriever


def _retriever_query(
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> str:
    query_value = kwargs.get("query")
    if query_value is None and args:
        query_value = args[0]
    return str(query_value or "")


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((time.monotonic() - started_at) * 1_000))


def _fair_search_budget(
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
    provider_count: int,
    provider_index: int,
) -> tuple[tuple[Any, ...], dict[str, Any], bool]:
    call_args = list(args)
    call_kwargs = dict(kwargs)
    requested = call_kwargs.get("max_results")
    if requested is None and call_args:
        requested = call_args[0]
    if (
        not isinstance(requested, int)
        or isinstance(requested, bool)
        or requested < 1
    ):
        return tuple(call_args), call_kwargs, True
    base_share, remainder = divmod(requested, provider_count)
    fair_share = base_share + (
        1 if provider_index < remainder else 0
    )
    if fair_share == 0:
        return tuple(call_args), call_kwargs, False
    if "max_results" in call_kwargs:
        call_kwargs["max_results"] = fair_share
    elif call_args:
        call_args[0] = fair_share
    return tuple(call_args), call_kwargs, True


def _call_with_timeout(
    operation: Callable[[], Any],
    timeout_ms: int,
) -> Any:
    outcomes: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=1)

    def run() -> None:
        try:
            outcomes.put(("result", operation()))
        except BaseException as exc:
            outcomes.put(("error", exc))

    thread = threading.Thread(
        target=run,
        name="retriever-call",
        daemon=True,
    )
    thread.start()
    try:
        outcome, value = outcomes.get(timeout=timeout_ms / 1_000)
    except queue.Empty as exc:
        raise TimeoutError("Retriever call timed out.") from exc
    if outcome == "error":
        raise value
    return value


def _result_url(result: Any) -> str | None:
    if not isinstance(result, dict):
        return None
    value = result.get("href") or result.get("url")
    return value if isinstance(value, str) and value.strip() else None


def _canonical_result_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    scheme = parsed.scheme.casefold()
    host = (parsed.hostname or "").casefold()
    port = parsed.port
    if port is not None and not (
        (scheme == "http" and port == 80)
        or (scheme == "https" and port == 443)
    ):
        host = f"{host}:{port}"
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/")
    query = urlencode(
        sorted(
            (name, candidate)
            for name, candidate in parse_qsl(
                parsed.query,
                keep_blank_values=True,
            )
            if (
                not name.casefold().startswith("utm_")
                and name.casefold() not in _TRACKING_QUERY_PARAMETERS
            )
        ),
        doseq=True,
    )
    return urlunsplit((scheme, host, path, query, ""))


def build_retriever_catalog(
    environment: Mapping[str, str] | None = None,
    *,
    adapter_loader: Callable[[str], object | None] | None = None,
) -> RetrieverCatalog:
    values = environment or {}
    enabled = _parse_enabled_retrievers(values)
    timeout_ms = _positive_integer(
        values,
        "GPTR_RETRIEVER_TIMEOUT_MS",
        20_000,
    )
    configured_max = _positive_integer(
        values,
        "GPTR_MAX_RETRIEVERS",
        3,
        maximum=5,
    )
    load_adapter = adapter_loader or _load_gptr_adapter

    ready = []
    for provider_id in enabled:
        spec = _RETRIEVER_BY_ID[provider_id]
        if (
            any(
                not values.get(name, "").strip()
                for name in spec.required_environment
            )
            and not spec.credential_required
        ):
            continue
        try:
            adapter = load_adapter(provider_id)
        except (ImportError, NameError):
            adapter = None
        if adapter is None:
            continue
        ready.append(
            RetrieverCapability(
                id=spec.id,
                label=spec.label,
                category=spec.category,
                credential_required=spec.credential_required,
                timeout_ms=timeout_ms,
            )
        )

    return RetrieverCatalog(
        retrievers=tuple(ready),
        max_retrievers=min(configured_max, len(ready)),
    )


def _parse_enabled_retrievers(
    environment: Mapping[str, str],
) -> tuple[RetrieverId, ...]:
    raw_value = (
        environment.get("GPTR_ENABLED_RETRIEVERS")
        or environment.get("RETRIEVER")
        or "duckduckgo"
    )
    values = tuple(
        value.strip()
        for value in raw_value.split(",")
        if value.strip()
    )
    if not values:
        raise ValueError("At least one retriever must be enabled.")
    unknown = [value for value in values if value not in _RETRIEVER_BY_ID]
    if unknown:
        raise ValueError(
            f"Unsupported retriever(s): {', '.join(unknown)}."
        )
    if len(set(values)) != len(values):
        raise ValueError("Enabled retrievers must not contain duplicates.")
    return values  # type: ignore[return-value]


def _positive_integer(
    environment: Mapping[str, str],
    name: str,
    fallback: int,
    *,
    maximum: int | None = None,
) -> int:
    raw_value = environment.get(name)
    try:
        value = fallback if raw_value is None else int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a positive integer.") from exc
    if value < 1 or (maximum is not None and value > maximum):
        suffix = (
            f" no greater than {maximum}"
            if maximum is not None
            else ""
        )
        raise ValueError(
            f"{name} must be a positive integer{suffix}."
        )
    return value


def _load_gptr_adapter(provider_id: str) -> object | None:
    load_gpt_researcher()
    from gpt_researcher.actions.retriever import get_retriever

    return get_retriever(provider_id)
