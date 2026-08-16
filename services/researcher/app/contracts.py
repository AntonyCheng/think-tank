from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .research_profile import ResearchRetriever


class TaskTemporalContext(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    started_at: str = Field(alias="startedAt", min_length=1)
    time_zone: str = Field(alias="timeZone", min_length=1)
    local_date: str = Field(alias="localDate", min_length=1)
    local_time: str = Field(alias="localTime", min_length=1)
    weekday: str = Field(min_length=1)


class ResearchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    task_id: str | None = Field(alias="taskId", default=None)
    research_run_id: str | None = Field(alias="researchRunId", default=None)
    execution_timeout_ms: int | None = Field(
        alias="executionTimeoutMs",
        default=None,
        ge=1,
    )
    system_prompt: str = Field(alias="systemPrompt", min_length=1)
    task: str = Field(min_length=1)
    report_source: Literal["web"] = Field(alias="reportSource", default="web")
    retriever: ResearchRetriever = "duckduckgo"
    research_profile: dict[str, Any] | None = Field(
        alias="researchProfile",
        default=None,
    )
    upstream_evidence: list[dict[str, Any]] | None = Field(
        alias="upstreamEvidence",
        default=None,
    )
    runtime_context: TaskTemporalContext | None = Field(
        alias="runtimeContext",
        default=None,
    )
    base_url: str | None = Field(alias="baseUrl", default=None)
    api_key: str | None = Field(alias="apiKey", default=None)
    fast_llm: str | None = Field(alias="fastLlm", default=None)
    smart_llm: str | None = Field(alias="smartLlm", default=None)
    embedding: str | None = None
    embedding_base_url: str | None = Field(
        alias="embeddingBaseUrl",
        default=None,
    )
    embedding_api_key: str | None = Field(
        alias="embeddingApiKey",
        default=None,
    )
    retriever_api_keys: dict[ResearchRetriever, str] = Field(
        alias="retrieverApiKeys",
        default_factory=dict,
    )


class ResearchEvent(BaseModel):
    timestamp: str
    type: str
    data: dict[str, Any]


class EvidenceQueryCapture(BaseModel):
    kind: Literal["subquery", "deep"]
    text: str = Field(min_length=1)


class PublicEvidenceSourceCapture(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    visibility: Literal["public"] = "public"
    url: str = Field(min_length=1)
    title: str = Field(min_length=1)
    source_type: Literal["web", "specified_url"] = Field(
        alias="sourceType",
        default="web",
    )
    summary: str | None = None


class PrivateEvidenceSourceCapture(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    visibility: Literal["private"] = "private"
    locator: str = Field(min_length=1)
    title: str = Field(min_length=1)
    source_type: Literal["document"] | None = Field(
        alias="sourceType",
        default=None,
    )
    summary: str | None = None


class ResearchEvidenceContext(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    content: str
    original_characters: int = Field(
        alias="originalCharacters",
        ge=0,
    )
    truncated: bool


class ResearchEvidenceCapture(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    queries: list[EvidenceQueryCapture]
    sources: list[PublicEvidenceSourceCapture | PrivateEvidenceSourceCapture]
    research_context: ResearchEvidenceContext = Field(
        alias="researchContext",
    )
    scraper: str | None = None


class ResearchResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    report: str
    source_urls: list[str] = Field(alias="sourceUrls")
    sources: list[Any]
    research_evidence: ResearchEvidenceCapture | None = Field(
        alias="researchEvidence",
        default=None,
    )
    cost: float | dict[str, Any] | None
    events: list[ResearchEvent]


class EditorSearchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    query: str = Field(min_length=1, max_length=4_000)
    retrievers: list[ResearchRetriever] = Field(min_length=1, max_length=5)
    limit: int = Field(default=8, ge=1, le=20)
    retriever_api_keys: dict[ResearchRetriever, str] = Field(
        alias="retrieverApiKeys",
        default_factory=dict,
    )


class EditorSearchResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    provider: ResearchRetriever
    title: str = Field(min_length=1)
    url: str = Field(min_length=1)
    snippet: str | None = None


class EditorSearchResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    results: list[EditorSearchResult]
    summary: dict[str, Any]


class EditorResearchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    query: str | None = Field(default=None, max_length=4_000)
    urls: list[str] = Field(default_factory=list, max_length=8)
    retrievers: list[ResearchRetriever] = Field(min_length=1, max_length=5)
    limit: int = Field(default=5, ge=1, le=8)
    retriever_api_keys: dict[ResearchRetriever, str] = Field(
        alias="retrieverApiKeys",
        default_factory=dict,
    )


class EditorResearchSource(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    provider: str
    title: str = Field(min_length=1)
    url: str = Field(min_length=1)
    snippet: str | None = None
    content: str | None = None
    fetch_status: Literal["fetched", "failed"] = Field(alias="fetchStatus")
    fetch_error: str | None = Field(alias="fetchError", default=None)


class EditorResearchResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    query: str | None = None
    sources: list[EditorResearchSource]
    summary: dict[str, Any]
