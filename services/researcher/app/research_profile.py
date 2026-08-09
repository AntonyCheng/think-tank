from __future__ import annotations

import re
from typing import Any, Literal, Mapping
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field


ResearchMode = Literal["standard", "deep", "synthesis"]
ResearchSourceMode = Literal["web", "urls", "local", "hybrid"]
ResearchRetriever = Literal[
    "duckduckgo",
    "tavily",
    "arxiv",
    "openalex",
    "semantic_scholar",
    "pubmed_central",
]
RESEARCH_RETRIEVERS: tuple[ResearchRetriever, ...] = (
    "duckduckgo",
    "tavily",
    "arxiv",
    "openalex",
    "semantic_scholar",
    "pubmed_central",
)
_MISSING = object()


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class _FrozenModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )


class ResearchProfileDefaults(_FrozenModel):
    default_retriever: ResearchRetriever
    default_retrievers: tuple[ResearchRetriever, ...] | None = None


class DeepResearchCapabilityLimits(_FrozenModel):
    max_breadth: int
    max_depth: int
    max_research_calls: int


class ResearchCapabilities(_FrozenModel):
    modes: tuple[ResearchMode, ...]
    source_modes: tuple[ResearchSourceMode, ...]
    url_source_modes: tuple[ResearchMode, ...] | None = None
    domain_filter_modes: tuple[ResearchMode, ...] | None = None
    retrievers: tuple[ResearchRetriever, ...]
    max_retrievers: int
    source_curation: bool
    domain_filters: bool
    deep_research: DeepResearchCapabilityLimits | None = None


class WebSearchPolicy(_FrozenModel):
    retrievers: tuple[ResearchRetriever, ...]
    include_domains: tuple[str, ...] | None = None
    exclude_domains: tuple[str, ...] | None = None


class WebSourcePolicy(WebSearchPolicy):
    mode: Literal["web"] = "web"


class UrlSourcePolicy(_FrozenModel):
    mode: Literal["urls"] = "urls"
    urls: tuple[str, ...]
    web: WebSearchPolicy | None = None


class LocalSourcePolicy(_FrozenModel):
    mode: Literal["local"] = "local"
    document_ids: tuple[str, ...]


class HybridSourcePolicy(_FrozenModel):
    mode: Literal["hybrid"] = "hybrid"
    document_ids: tuple[str, ...]
    urls: tuple[str, ...] | None = None
    web: WebSearchPolicy | None = None


ResearchSourcePolicy = (
    WebSourcePolicy
    | UrlSourcePolicy
    | LocalSourcePolicy
    | HybridSourcePolicy
)


class ResearchQualityPolicy(_FrozenModel):
    curate_sources: bool


class ResearchLimits(_FrozenModel):
    max_search_results_per_query: int
    max_iterations: int
    max_subtopics: int


class DeepResearchParameters(_FrozenModel):
    breadth: int
    depth: int
    concurrency: int


class WebSearchPolicyOverride(_FrozenModel):
    mode: Literal["web"] | None = None
    retrievers: tuple[ResearchRetriever, ...] | None = None
    include_domains: tuple[str, ...] | None = None
    exclude_domains: tuple[str, ...] | None = None


class UrlSourcePolicyOverride(_FrozenModel):
    mode: Literal["urls"]
    urls: tuple[str, ...]
    web: WebSearchPolicyOverride | None = None


class LocalSourcePolicyOverride(_FrozenModel):
    mode: Literal["local"]
    document_ids: tuple[str, ...]


class HybridSourcePolicyOverride(_FrozenModel):
    mode: Literal["hybrid"]
    document_ids: tuple[str, ...]
    urls: tuple[str, ...] | None = None
    web: WebSearchPolicyOverride | None = None


ResearchSourcePolicyOverride = (
    WebSearchPolicyOverride
    | UrlSourcePolicyOverride
    | LocalSourcePolicyOverride
    | HybridSourcePolicyOverride
)


class ResearchQualityPolicyOverride(_FrozenModel):
    curate_sources: bool | None = None


class ResearchLimitsOverride(_FrozenModel):
    max_search_results_per_query: int | None = None
    max_iterations: int | None = None
    max_subtopics: int | None = None


class ResearchProfileOverride(_FrozenModel):
    schema_version: Literal[1] | None = None
    mode: ResearchMode | None = None
    source: ResearchSourcePolicyOverride | None = None
    quality: ResearchQualityPolicyOverride | None = None
    limits: ResearchLimitsOverride | None = None
    deep: DeepResearchParameters | None = None


class ResearchProfile(_FrozenModel):
    schema_version: Literal[1]
    mode: ResearchMode
    source: ResearchSourcePolicy = Field(discriminator="mode")
    quality: ResearchQualityPolicy
    limits: ResearchLimits
    deep: DeepResearchParameters | None = None


ResearchProfileErrorCode = Literal[
    "profile_version_unsupported",
    "profile_unknown_field",
    "profile_invalid_type",
    "profile_invalid_value",
    "profile_invariant_violation",
    "profile_capability_disabled",
]


class ResearchProfileError(ValueError):
    def __init__(
        self,
        code: ResearchProfileErrorCode,
        path: str,
        message: str,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.path = path


def resolve_research_profile(
    value: Any,
    defaults: ResearchProfileDefaults,
    capabilities: ResearchCapabilities,
) -> ResearchProfile:
    profile = {} if value is None else _object_value(value, "$")
    _assert_known_fields(
        profile,
        {"schemaVersion", "mode", "source", "quality", "limits", "deep"},
        "$",
    )

    schema_version = (
        1
        if "schemaVersion" not in profile
        else _integer_value(profile["schemaVersion"], "$.schemaVersion")
    )
    if schema_version != 1:
        raise ResearchProfileError(
            "profile_version_unsupported",
            "$.schemaVersion",
            f"Research Profile schema version {schema_version} is not supported.",
        )

    mode: ResearchMode = (
        "standard"
        if "mode" not in profile
        else _enum_value(
            profile["mode"],
            ("standard", "deep", "synthesis"),
            "$.mode",
        )
    )
    source = _parse_source(profile.get("source", _MISSING), defaults)
    quality = _parse_quality(
        profile.get("quality", _MISSING),
        mode,
        capabilities.source_curation,
    )
    limits = _parse_limits(profile.get("limits", _MISSING))
    deep = _parse_deep(profile.get("deep", _MISSING), mode)

    result = ResearchProfile(
        schema_version=1,
        mode=mode,
        source=source,
        quality=quality,
        limits=limits,
        deep=deep,
    )
    _assert_capabilities(result, capabilities)
    return result


def _parse_source(
    value: Any,
    defaults: ResearchProfileDefaults,
) -> ResearchSourcePolicy:
    if value is _MISSING:
        return WebSourcePolicy(
            retrievers=_default_retriever_set(defaults),
        )

    source = _object_value(value, "$.source")
    mode: ResearchSourceMode = (
        "web"
        if "mode" not in source
        else _enum_value(
            source["mode"],
            ("web", "urls", "local", "hybrid"),
            "$.source.mode",
        )
    )

    if mode == "web":
        web = _parse_web_policy(source, "$.source", defaults, include_mode=True)
        return WebSourcePolicy(**web.model_dump())

    if mode == "urls":
        _assert_known_fields(source, {"mode", "urls", "web"}, "$.source")
        return UrlSourcePolicy(
            urls=_parse_urls(source.get("urls"), "$.source.urls"),
            web=(
                None
                if "web" not in source
                else _parse_nested_web(source["web"], "$.source.web", defaults)
            ),
        )

    if mode == "local":
        _assert_known_fields(source, {"mode", "documentIds"}, "$.source")
        return LocalSourcePolicy(
            document_ids=_parse_identifiers(
                source.get("documentIds"),
                "$.source.documentIds",
                20,
            )
        )

    if mode == "hybrid":
        _assert_known_fields(
            source,
            {"mode", "documentIds", "urls", "web"},
            "$.source",
        )
        urls = (
            None
            if "urls" not in source
            else _parse_urls(source["urls"], "$.source.urls")
        )
        web = (
            None
            if "web" not in source
            else _parse_nested_web(source["web"], "$.source.web", defaults)
        )
        if urls is None and web is None:
            raise ResearchProfileError(
                "profile_invariant_violation",
                "$.source",
                "Hybrid sources require URL or web evidence alongside documents.",
            )
        return HybridSourcePolicy(
            document_ids=_parse_identifiers(
                source.get("documentIds"),
                "$.source.documentIds",
                20,
            ),
            urls=urls,
            web=web,
        )

    raise ResearchProfileError(
        "profile_invalid_value",
        "$.source.mode",
        f"Unsupported source mode '{mode}'.",
    )


def _parse_nested_web(
    value: Any,
    path: str,
    defaults: ResearchProfileDefaults,
) -> WebSearchPolicy:
    return _parse_web_policy(
        _object_value(value, path),
        path,
        defaults,
        include_mode=False,
    )


def _parse_web_policy(
    value: Mapping[str, Any],
    path: str,
    defaults: ResearchProfileDefaults,
    *,
    include_mode: bool,
) -> WebSearchPolicy:
    allowed = {"retrievers", "includeDomains", "excludeDomains"}
    if include_mode:
        allowed.add("mode")
    _assert_known_fields(value, allowed, path)

    retrievers = (
        _default_retriever_set(defaults)
        if "retrievers" not in value
        else _parse_retrievers(value["retrievers"], f"{path}.retrievers")
    )
    include_domains = _parse_domains(
        value.get("includeDomains", _MISSING),
        f"{path}.includeDomains",
    )
    exclude_domains = _parse_domains(
        value.get("excludeDomains", _MISSING),
        f"{path}.excludeDomains",
    )
    if (
        include_domains is not None
        and exclude_domains is not None
        and set(include_domains).intersection(exclude_domains)
    ):
        raise ResearchProfileError(
            "profile_invariant_violation",
            path,
            "includeDomains and excludeDomains must not overlap.",
        )
    return WebSearchPolicy(
        retrievers=retrievers,
        include_domains=include_domains,
        exclude_domains=exclude_domains,
    )


def _default_retriever_set(
    defaults: ResearchProfileDefaults,
) -> tuple[ResearchRetriever, ...]:
    return (
        defaults.default_retrievers
        if defaults.default_retrievers
        else (defaults.default_retriever,)
    )


def _parse_retrievers(value: Any, path: str) -> tuple[ResearchRetriever, ...]:
    items = _array_value(value, path)
    if not 1 <= len(items) <= 5:
        raise ResearchProfileError(
            "profile_invalid_value",
            path,
            f"{path} must contain between 1 and 5 retrievers.",
        )
    retrievers = tuple(
        _enum_value(
            item,
            RESEARCH_RETRIEVERS,
            f"{path}[{index}]",
        )
        for index, item in enumerate(items)
    )
    _assert_unique(retrievers, path, "retrievers")
    return retrievers


def _parse_domains(value: Any, path: str) -> tuple[str, ...] | None:
    if value is _MISSING:
        return None
    items = _array_value(value, path)
    if not 1 <= len(items) <= 20:
        raise ResearchProfileError(
            "profile_invalid_value",
            path,
            f"{path} must contain between 1 and 20 domains.",
        )
    domains: list[str] = []
    for index, item in enumerate(items):
        item_path = f"{path}[{index}]"
        if not isinstance(item, str):
            raise ResearchProfileError(
                "profile_invalid_type",
                item_path,
                f"{item_path} must be a string.",
            )
        domain = item.lower()
        if not _is_hostname(domain):
            raise ResearchProfileError(
                "profile_invalid_value",
                item_path,
                f"{item_path} must be a hostname without a URL scheme or path.",
            )
        domains.append(domain)
    result = tuple(domains)
    _assert_unique(result, path, "domains")
    return result


def _is_hostname(value: str) -> bool:
    if not 1 <= len(value) <= 253:
        return False
    return all(
        1 <= len(label) <= 63
        and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", label)
        is not None
        for label in value.split(".")
    )


def _parse_urls(value: Any, path: str) -> tuple[str, ...]:
    items = _array_value(value, path)
    if not 1 <= len(items) <= 50:
        raise ResearchProfileError(
            "profile_invalid_value",
            path,
            f"{path} must contain between 1 and 50 URLs.",
        )
    urls: list[str] = []
    for index, item in enumerate(items):
        item_path = f"{path}[{index}]"
        if not isinstance(item, str):
            raise ResearchProfileError(
                "profile_invalid_type",
                item_path,
                f"{item_path} must be a string.",
            )
        parsed = urlparse(item)
        if (
            len(item) > 2048
            or parsed.scheme not in {"http", "https"}
            or not parsed.hostname
        ):
            raise ResearchProfileError(
                "profile_invalid_value",
                item_path,
                f"{item_path} must be an absolute HTTP(S) URL.",
            )
        urls.append(item)
    result = tuple(urls)
    _assert_unique(result, path, "URLs")
    return result


def _parse_identifiers(
    value: Any,
    path: str,
    maximum: int,
) -> tuple[str, ...]:
    items = _array_value(value, path)
    if not 1 <= len(items) <= maximum:
        raise ResearchProfileError(
            "profile_invalid_value",
            path,
            f"{path} must contain between 1 and {maximum} identifiers.",
        )
    identifiers: list[str] = []
    for index, item in enumerate(items):
        item_path = f"{path}[{index}]"
        if not isinstance(item, str):
            raise ResearchProfileError(
                "profile_invalid_type",
                item_path,
                f"{item_path} must be a string.",
            )
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", item) is None:
            raise ResearchProfileError(
                "profile_invalid_value",
                item_path,
                f"{item_path} must be a platform-managed identifier.",
            )
        identifiers.append(item)
    result = tuple(identifiers)
    _assert_unique(result, path, "identifiers")
    return result


def _parse_quality(
    value: Any,
    mode: ResearchMode,
    source_curation_available: bool,
) -> ResearchQualityPolicy:
    default_value = mode != "synthesis" and source_curation_available
    if value is _MISSING:
        return ResearchQualityPolicy(curate_sources=default_value)
    quality = _object_value(value, "$.quality")
    _assert_known_fields(quality, {"curateSources"}, "$.quality")
    result = ResearchQualityPolicy(
        curate_sources=_boolean_value(
            quality.get("curateSources", _MISSING),
            "$.quality.curateSources",
            default_value,
        )
    )
    if mode == "synthesis" and result.curate_sources:
        raise ResearchProfileError(
            "profile_invariant_violation",
            "$.quality.curateSources",
            "Synthesis mode cannot curate sources because it does not search.",
        )
    return result


def _parse_limits(value: Any) -> ResearchLimits:
    if value is _MISSING:
        return ResearchLimits(
            max_search_results_per_query=5,
            max_iterations=3,
            max_subtopics=3,
        )
    limits = _object_value(value, "$.limits")
    _assert_known_fields(
        limits,
        {"maxSearchResultsPerQuery", "maxIterations", "maxSubtopics"},
        "$.limits",
    )
    return ResearchLimits(
        max_search_results_per_query=_bounded_integer(
            limits.get("maxSearchResultsPerQuery", _MISSING),
            "$.limits.maxSearchResultsPerQuery",
            1,
            20,
            5,
        ),
        max_iterations=_bounded_integer(
            limits.get("maxIterations", _MISSING),
            "$.limits.maxIterations",
            1,
            10,
            3,
        ),
        max_subtopics=_bounded_integer(
            limits.get("maxSubtopics", _MISSING),
            "$.limits.maxSubtopics",
            1,
            20,
            3,
        ),
    )


def _parse_deep(
    value: Any,
    mode: ResearchMode,
) -> DeepResearchParameters | None:
    if mode == "deep" and value is _MISSING:
        raise ResearchProfileError(
            "profile_invariant_violation",
            "$.deep",
            "Deep mode requires explicit deep parameters.",
        )
    if mode != "deep" and value is not _MISSING:
        raise ResearchProfileError(
            "profile_invariant_violation",
            "$.deep",
            "Deep parameters are only valid in deep mode.",
        )
    if value is _MISSING:
        return None

    deep = _object_value(value, "$.deep")
    _assert_known_fields(deep, {"breadth", "depth", "concurrency"}, "$.deep")
    return DeepResearchParameters(
        breadth=_required_bounded_integer(
            deep.get("breadth", _MISSING),
            "$.deep.breadth",
            1,
            10,
        ),
        depth=_required_bounded_integer(
            deep.get("depth", _MISSING),
            "$.deep.depth",
            1,
            5,
        ),
        concurrency=_required_bounded_integer(
            deep.get("concurrency", _MISSING),
            "$.deep.concurrency",
            1,
            16,
        ),
    )


def _assert_capabilities(
    profile: ResearchProfile,
    capabilities: ResearchCapabilities,
) -> None:
    if profile.mode not in capabilities.modes:
        raise ResearchProfileError(
            "profile_capability_disabled",
            "$.mode",
            f"Mode '{profile.mode}' is not enabled.",
        )
    if profile.mode == "deep" and profile.deep is not None:
        limits = capabilities.deep_research
        if limits is not None:
            if profile.deep.breadth > limits.max_breadth:
                raise ResearchProfileError(
                    "profile_capability_disabled",
                    "$.deep.breadth",
                    "Deep research breadth "
                    f"{profile.deep.breadth} exceeds the deployment limit "
                    f"{limits.max_breadth}.",
                )
            if profile.deep.depth > limits.max_depth:
                raise ResearchProfileError(
                    "profile_capability_disabled",
                    "$.deep.depth",
                    "Deep research depth "
                    f"{profile.deep.depth} exceeds the deployment limit "
                    f"{limits.max_depth}.",
                )
            estimated_calls = estimate_deep_research_calls(
                profile.deep.breadth,
                profile.deep.depth,
            )
            if estimated_calls > limits.max_research_calls:
                raise ResearchProfileError(
                    "profile_capability_disabled",
                    "$.deep",
                    "Deep research is estimated to require "
                    f"{estimated_calls} research calls, exceeding the "
                    f"deployment limit {limits.max_research_calls}.",
                )
    _assert_source_capabilities(profile, capabilities)
    if profile.quality.curate_sources and not capabilities.source_curation:
        raise ResearchProfileError(
            "profile_capability_disabled",
            "$.quality.curateSources",
            "Source curation is not enabled.",
        )


def _assert_source_capabilities(
    profile: ResearchProfile,
    capabilities: ResearchCapabilities,
) -> None:
    if profile.mode == "synthesis":
        return
    if profile.source.mode not in capabilities.source_modes:
        raise ResearchProfileError(
            "profile_capability_disabled",
            "$.source.mode",
            f"Source mode '{profile.source.mode}' is not enabled.",
        )
    if (
        isinstance(profile.source, UrlSourcePolicy)
        and capabilities.url_source_modes is not None
        and profile.mode not in capabilities.url_source_modes
    ):
        raise ResearchProfileError(
            "profile_capability_disabled",
            "$.source.mode",
            f"URL sources are not enabled for mode '{profile.mode}'.",
        )

    if isinstance(profile.source, WebSourcePolicy):
        _assert_web_capabilities(
            profile.source,
            "$.source",
            profile.mode,
            capabilities,
        )
    elif (
        isinstance(
            profile.source,
            (UrlSourcePolicy, HybridSourcePolicy),
        )
        and profile.source.web is not None
    ):
        _assert_web_capabilities(
            profile.source.web,
            "$.source.web",
            profile.mode,
            capabilities,
        )


def estimate_deep_research_calls(breadth: int, depth: int) -> int:
    if depth <= 1:
        return breadth
    next_breadth = max(2, breadth // 2)
    return breadth * (
        1 + estimate_deep_research_calls(next_breadth, depth - 1)
    )


def _assert_web_capabilities(
    policy: WebSearchPolicy,
    path: str,
    mode: ResearchMode,
    capabilities: ResearchCapabilities,
) -> None:
    for index, retriever in enumerate(policy.retrievers):
        if retriever not in capabilities.retrievers:
            raise ResearchProfileError(
                "profile_capability_disabled",
                f"{path}.retrievers[{index}]",
                f"Retriever '{retriever}' is not enabled.",
            )
    if len(policy.retrievers) > capabilities.max_retrievers:
        raise ResearchProfileError(
            "profile_capability_disabled",
            f"{path}.retrievers",
            f"At most {capabilities.max_retrievers} retrievers are enabled.",
        )
    if policy.include_domains is not None and not capabilities.domain_filters:
        raise ResearchProfileError(
            "profile_capability_disabled",
            f"{path}.includeDomains",
            "Domain filters are not enabled.",
        )
    if policy.exclude_domains is not None and not capabilities.domain_filters:
        raise ResearchProfileError(
            "profile_capability_disabled",
            f"{path}.excludeDomains",
            "Domain filters are not enabled.",
        )
    domain_path = (
        f"{path}.includeDomains"
        if policy.include_domains is not None
        else f"{path}.excludeDomains"
    )
    if (
        (
            policy.include_domains is not None
            or policy.exclude_domains is not None
        )
        and capabilities.domain_filter_modes is not None
        and mode not in capabilities.domain_filter_modes
    ):
        raise ResearchProfileError(
            "profile_capability_disabled",
            domain_path,
            f"Domain filters are not enabled for mode '{mode}'.",
        )


def _object_value(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise ResearchProfileError(
            "profile_invalid_type",
            path,
            f"{path} must be an object.",
        )
    return value


def _array_value(value: Any, path: str) -> list[Any]:
    if not isinstance(value, list):
        raise ResearchProfileError(
            "profile_invalid_type",
            path,
            f"{path} must be an array.",
        )
    return value


def _assert_known_fields(
    value: Mapping[str, Any],
    allowed: set[str],
    path: str,
) -> None:
    unknown = sorted(set(value).difference(allowed))
    if unknown:
        unknown_path = f"{path}.{unknown[0]}"
        raise ResearchProfileError(
            "profile_unknown_field",
            unknown_path,
            f"{unknown_path} is not a recognized Research Profile field.",
        )


def _integer_value(value: Any, path: str) -> int:
    if type(value) is not int:
        raise ResearchProfileError(
            "profile_invalid_type",
            path,
            f"{path} must be an integer.",
        )
    return value


def _boolean_value(value: Any, path: str, fallback: bool) -> bool:
    if value is _MISSING:
        return fallback
    if type(value) is not bool:
        raise ResearchProfileError(
            "profile_invalid_type",
            path,
            f"{path} must be a boolean.",
        )
    return value


def _bounded_integer(
    value: Any,
    path: str,
    minimum: int,
    maximum: int,
    fallback: int,
) -> int:
    if value is _MISSING:
        return fallback
    result = _integer_value(value, path)
    if not minimum <= result <= maximum:
        raise ResearchProfileError(
            "profile_invalid_value",
            path,
            f"{path} must be between {minimum} and {maximum}.",
        )
    return result


def _required_bounded_integer(
    value: Any,
    path: str,
    minimum: int,
    maximum: int,
) -> int:
    if value is _MISSING:
        raise ResearchProfileError(
            "profile_invalid_type",
            path,
            f"{path} is required and must be an integer.",
        )
    return _bounded_integer(value, path, minimum, maximum, minimum)


def _enum_value(
    value: Any,
    allowed: tuple[str, ...],
    path: str,
) -> Any:
    if not isinstance(value, str):
        raise ResearchProfileError(
            "profile_invalid_type",
            path,
            f"{path} must be a string.",
        )
    if value not in allowed:
        raise ResearchProfileError(
            "profile_invalid_value",
            path,
            f"{path} must be one of: {', '.join(allowed)}.",
        )
    return value


def _assert_unique(values: tuple[str, ...], path: str, label: str) -> None:
    if len(set(values)) != len(values):
        raise ResearchProfileError(
            "profile_invalid_value",
            path,
            f"{path} must not contain duplicate {label}.",
        )
