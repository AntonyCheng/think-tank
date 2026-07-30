from __future__ import annotations

import asyncio
import multiprocessing
import os
import sys
from collections.abc import Awaitable, Callable, Mapping
from multiprocessing.process import BaseProcess
from queue import Empty
from typing import Any, Protocol

from .contracts import ResearchEvent, ResearchRequest, ResearchResponse
from .research_policy import (
    research_profile_error_detail,
    resolve_request_research_profile,
)
from .research_profile import ResearchProfileError


EventPublisher = Callable[[ResearchEvent], Awaitable[None]]
ResearchEngine = Callable[
    [ResearchRequest, EventPublisher],
    Awaitable[ResearchResponse],
]

MANAGED_ENVIRONMENT = (
    "RETRIEVER",
    "GPTR_ENABLED_RETRIEVERS",
    "GPTR_MAX_RETRIEVERS",
    "GPTR_RETRIEVER_TIMEOUT_MS",
    "TAVILY_API_KEY",
    "OPENALEX_EMAIL",
    "OPENALEX_API_KEY",
    "NCBI_API_KEY",
    "PUBMED_DB",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "FAST_LLM",
    "SMART_LLM",
    "STRATEGIC_LLM",
    "EMBEDDING",
    "MAX_SEARCH_RESULTS_PER_QUERY",
    "MAX_ITERATIONS",
    "MAX_SUBTOPICS",
    "DEEP_RESEARCH_BREADTH",
    "DEEP_RESEARCH_DEPTH",
    "DEEP_RESEARCH_CONCURRENCY",
)


class ResearchExecutor(Protocol):
    async def execute(
        self,
        request: ResearchRequest,
        publish: EventPublisher | None = None,
    ) -> ResearchResponse: ...

    async def close(self) -> None: ...


class ResearchExecutionError(RuntimeError):
    def __init__(self, status_code: int, detail: Any) -> None:
        message = (
            detail.get("message", str(detail))
            if isinstance(detail, dict)
            else str(detail)
        )
        super().__init__(message)
        self.status_code = status_code
        self.detail = detail


class ProcessResearchExecutor:
    def __init__(
        self,
        *,
        engine: ResearchEngine,
        worker_concurrency: int = 2,
        base_environment: Mapping[str, str] | None = None,
    ) -> None:
        if worker_concurrency < 1:
            raise ValueError("worker_concurrency must be at least 1")
        self._engine = engine
        self._worker_concurrency = worker_concurrency
        self._base_environment = dict(
            os.environ if base_environment is None else base_environment
        )
        self._semaphore: asyncio.Semaphore | None = None
        self._closed = False
        self._active_processes: set[BaseProcess] = set()

    async def execute(
        self,
        request: ResearchRequest,
        publish: EventPublisher | None = None,
    ) -> ResearchResponse:
        if self._closed:
            raise RuntimeError("research executor is closed")

        try:
            profile = resolve_request_research_profile(
                request,
                self._base_environment,
            )
        except ResearchProfileError as exc:
            raise ResearchExecutionError(
                422,
                research_profile_error_detail(exc),
            ) from exc
        except ValueError as exc:
            raise ResearchExecutionError(
                503,
                {
                    "code": "retriever_configuration_unavailable",
                    "path": "$.researchProfile.source.retrievers",
                    "message": str(exc),
                },
            ) from exc
        request = request.model_copy(
            update={
                "research_profile": profile.model_dump(
                    mode="json",
                    by_alias=True,
                    exclude_none=True,
                )
            }
        )

        semaphore = self._get_semaphore()
        async with semaphore:
            if self._closed:
                raise RuntimeError("research executor is closed")
            return await self._execute_in_process(request, publish)

    async def close(self) -> None:
        self._closed = True
        processes = list(self._active_processes)
        if processes:
            await asyncio.gather(
                *(
                    asyncio.to_thread(
                        _stop_process,
                        process,
                        close_handle=False,
                    )
                    for process in processes
                )
            )

    def _get_semaphore(self) -> asyncio.Semaphore:
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(self._worker_concurrency)
        return self._semaphore

    async def _execute_in_process(
        self,
        request: ResearchRequest,
        publish: EventPublisher | None,
    ) -> ResearchResponse:
        context = multiprocessing.get_context("spawn")
        messages = context.Queue()
        environment = _resolve_managed_environment(
            request,
            self._base_environment,
        )
        process = context.Process(
            target=_run_engine_process,
            args=(
                request.model_dump(by_alias=True),
                environment,
                messages,
                self._engine,
            ),
        )
        process.start()
        self._active_processes.add(process)

        try:
            while True:
                message = await asyncio.to_thread(
                    _receive_message,
                    messages,
                    process,
                )
                message_type = message.get("type")
                if message_type == "event":
                    event = ResearchEvent.model_validate(message["event"])
                    if publish:
                        await publish(event)
                    continue
                if message_type == "result":
                    return ResearchResponse.model_validate(message["result"])
                if message_type == "error":
                    raise ResearchExecutionError(
                        int(message.get("status") or 502),
                        message.get("detail") or "unknown error",
                    )
                raise ResearchExecutionError(
                    502,
                    "research process exited without a terminal message "
                    f"(exit code {message.get('exitCode')})",
                )
        finally:
            self._active_processes.discard(process)
            await asyncio.to_thread(_stop_process, process)
            messages.close()
            messages.join_thread()


def _resolve_managed_environment(
    request: ResearchRequest,
    base_environment: Mapping[str, str],
) -> dict[str, str | None]:
    profile = resolve_request_research_profile(
        request,
        base_environment,
    )
    values: dict[str, str | None] = {
        name: base_environment.get(name)
        for name in MANAGED_ENVIRONMENT
    }
    values.update(
        {
            "RETRIEVER": ",".join(
                _profile_retrievers(profile, request.retriever)
            ),
            "OPENAI_BASE_URL": _normalized_url(request.base_url)
            or values["OPENAI_BASE_URL"],
            "OPENAI_API_KEY": request.api_key or values["OPENAI_API_KEY"],
            "FAST_LLM": request.fast_llm or values["FAST_LLM"],
            "SMART_LLM": request.smart_llm or values["SMART_LLM"],
            "STRATEGIC_LLM": request.smart_llm
            or values["STRATEGIC_LLM"]
            or values["SMART_LLM"],
            "EMBEDDING": request.embedding or values["EMBEDDING"],
            "MAX_SEARCH_RESULTS_PER_QUERY": str(
                profile.limits.max_search_results_per_query
            ),
            "MAX_ITERATIONS": str(profile.limits.max_iterations),
            "MAX_SUBTOPICS": str(profile.limits.max_subtopics),
            "DEEP_RESEARCH_BREADTH": (
                str(profile.deep.breadth)
                if profile.deep is not None
                else None
            ),
            "DEEP_RESEARCH_DEPTH": (
                str(profile.deep.depth)
                if profile.deep is not None
                else None
            ),
            "DEEP_RESEARCH_CONCURRENCY": (
                str(profile.deep.concurrency)
                if profile.deep is not None
                else None
            ),
        }
    )
    return values


def _profile_retrievers(profile, fallback: str) -> tuple[str, ...]:
    source = profile.source
    web_policy = (
        source
        if source.mode == "web"
        else getattr(source, "web", None)
    )
    retrievers = tuple(
        getattr(web_policy, "retrievers", ()) or ()
    )
    return retrievers or (fallback,)


def _normalized_url(value: str | None) -> str | None:
    return value.rstrip("/") if value else None


def _run_engine_process(
    request_data: dict[str, Any],
    environment: dict[str, str | None],
    messages,
    engine: ResearchEngine,
) -> None:
    _configure_worker_streams()
    for name in MANAGED_ENVIRONMENT:
        os.environ.pop(name, None)
    for name, value in environment.items():
        if value is not None:
            os.environ[name] = value

    async def execute() -> None:
        request = ResearchRequest.model_validate(request_data)

        async def publish(event: ResearchEvent) -> None:
            messages.put({
                "type": "event",
                "event": event.model_dump(),
            })

        try:
            result = await engine(request, publish)
        except Exception as exc:
            status_code = getattr(exc, "status_code", 502)
            detail = getattr(exc, "detail", None) or str(exc)
            secrets = [
                value
                for name, value in environment.items()
                if value and name.endswith(("_API_KEY", "_TOKEN", "_SECRET"))
            ]
            messages.put({
                "type": "error",
                "status": status_code,
                "detail": _redact_detail(detail, secrets),
            })
            return
        messages.put({
            "type": "result",
            "result": result.model_dump(by_alias=True),
        })

    asyncio.run(execute())


def _configure_worker_streams() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(
                encoding="utf-8",
                errors="backslashreplace",
            )


def _redact(value: str, secrets: list[str]) -> str:
    for secret in secrets:
        value = value.replace(secret, "[REDACTED]")
    return value


def _redact_detail(value: Any, secrets: list[str]) -> Any:
    if isinstance(value, str):
        return _redact(value, secrets)
    if isinstance(value, dict):
        return {
            str(key): _redact_detail(candidate, secrets)
            for key, candidate in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [
            _redact_detail(candidate, secrets)
            for candidate in value
        ]
    return value


def _receive_message(messages, process: BaseProcess) -> dict[str, Any]:
    while True:
        try:
            return messages.get(timeout=0.1)
        except Empty:
            if process.is_alive():
                continue
            try:
                return messages.get_nowait()
            except Empty:
                return {
                    "type": "process_exit",
                    "exitCode": process.exitcode,
                }


def _stop_process(
    process: BaseProcess,
    *,
    close_handle: bool = True,
) -> None:
    if process.is_alive():
        process.terminate()
    process.join(timeout=5)
    if process.is_alive() and hasattr(process, "kill"):
        process.kill()
        process.join(timeout=5)
    if close_handle:
        process.close()
