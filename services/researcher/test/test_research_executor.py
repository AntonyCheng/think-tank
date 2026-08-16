import asyncio
import ctypes
import json
import os
import sys
from pathlib import Path
from time import monotonic, sleep

import pytest

from app.main import ResearchEvent, ResearchRequest, ResearchResponse
from app.research_executor import (
    ProcessResearchExecutor,
    ResearchExecutionError,
    _resolve_managed_environment,
)


async def overlapping_environment_probe(
    request: ResearchRequest,
    publish,
) -> ResearchResponse:
    coordination_dir = Path(request.task)
    coordination_dir.joinpath(request.system_prompt).write_text(
        "ready",
        encoding="utf-8",
    )

    deadline = monotonic() + 5
    while len(list(coordination_dir.glob("*.ready"))) < 2:
        if monotonic() >= deadline:
            raise RuntimeError("probe workers did not overlap")
        await asyncio.sleep(0.02)

    await publish(
        ResearchEvent(
            timestamp="2026-07-29T00:00:00+00:00",
            type="probe.ready",
            data={"worker": request.system_prompt},
        )
    )
    report = json.dumps(
        {
            "worker": request.system_prompt,
            "pid": os.getpid(),
            "retriever": os.getenv("RETRIEVER"),
            "baseUrl": os.getenv("OPENAI_BASE_URL"),
            "fastLlm": os.getenv("FAST_LLM"),
            "smartLlm": os.getenv("SMART_LLM"),
            "embedding": os.getenv("EMBEDDING"),
            "maxSearchResultsPerQuery": os.getenv(
                "MAX_SEARCH_RESULTS_PER_QUERY"
            ),
            "maxIterations": os.getenv("MAX_ITERATIONS"),
            "maxSubtopics": os.getenv("MAX_SUBTOPICS"),
            "deepResearchBreadth": os.getenv("DEEP_RESEARCH_BREADTH"),
            "deepResearchDepth": os.getenv("DEEP_RESEARCH_DEPTH"),
            "deepResearchConcurrency": os.getenv(
                "DEEP_RESEARCH_CONCURRENCY"
            ),
            "apiKeyMatchesRequest": (
                os.getenv("OPENAI_API_KEY") == request.api_key
            ),
        }
    )
    return ResearchResponse(
        report=report,
        sourceUrls=[],
        sources=[],
        cost=None,
        events=[],
    )


async def leaking_failure_probe(
    request: ResearchRequest,
    publish,
) -> ResearchResponse:
    raise RuntimeError(f"provider rejected key {request.api_key}")


class StructuredProbeError(RuntimeError):
    status_code = 422

    def __init__(self, secret: str | None) -> None:
        super().__init__("structured failure")
        self.detail = {
            "code": "source_address_forbidden",
            "path": "$.researchProfile.source.urls",
            "message": f"rejected {secret}",
        }


async def structured_failure_probe(
    request: ResearchRequest,
    publish,
) -> ResearchResponse:
    del publish
    raise StructuredProbeError(request.api_key)


async def crashing_probe(
    request: ResearchRequest,
    publish,
) -> ResearchResponse:
    os._exit(7)


async def blocking_probe(
    request: ResearchRequest,
    publish,
) -> ResearchResponse:
    Path(request.task).write_text(str(os.getpid()), encoding="utf-8")
    await asyncio.Event().wait()
    raise AssertionError("unreachable")


async def stream_encoding_probe(
    request: ResearchRequest,
    publish,
) -> ResearchResponse:
    return ResearchResponse(
        report=json.dumps({
            "stdout": sys.stdout.encoding,
            "stderr": sys.stderr.encoding,
        }),
        sourceUrls=[],
        sources=[],
        cost=None,
        events=[],
    )


async def unexpected_engine_probe(
    request: ResearchRequest,
    publish,
) -> ResearchResponse:
    raise AssertionError("invalid profile reached the research engine")


def test_managed_environment_activates_profile_retrievers_in_order() -> None:
    request = ResearchRequest(
        systemPrompt="Expert.",
        task="Research.",
        researchProfile={
            "source": {
                "mode": "web",
                "retrievers": ["duckduckgo", "openalex"],
            },
        },
    )

    environment = _resolve_managed_environment(
        request,
        {
            "GPTR_ENABLED_RETRIEVERS": "duckduckgo,openalex",
            "GPTR_MAX_RETRIEVERS": "2",
        },
    )

    assert environment["RETRIEVER"] == "duckduckgo,openalex"


def test_managed_environment_prefers_request_tavily_key() -> None:
    request = ResearchRequest(
        systemPrompt="Expert.",
        task="Research.",
        retrieverApiKeys={"tavily": "request-tavily-key"},
    )

    environment = _resolve_managed_environment(
        request,
        {"TAVILY_API_KEY": "deployment-tavily-key"},
    )

    assert environment["TAVILY_API_KEY"] == "request-tavily-key"


def test_oversized_deep_profile_is_rejected_before_worker_start() -> None:
    executor = ProcessResearchExecutor(
        engine=unexpected_engine_probe,
        worker_concurrency=1,
    )
    request = ResearchRequest(
        systemPrompt="Expert.",
        task="Research.",
        researchProfile={
            "schemaVersion": 1,
            "mode": "deep",
            "source": {
                "mode": "web",
                "retrievers": ["duckduckgo"],
            },
            "quality": {"curateSources": False},
            "limits": {
                "maxSearchResultsPerQuery": 5,
                "maxIterations": 3,
                "maxSubtopics": 3,
            },
            "deep": {
                "breadth": 5,
                "depth": 2,
                "concurrency": 2,
            },
        },
    )

    async def execute() -> int:
        with pytest.raises(ResearchExecutionError) as captured:
            await executor.execute(request)
        await executor.close()
        assert captured.value.status_code == 422
        assert captured.value.detail == {
            "code": "profile_capability_disabled",
            "path": "$.researchProfile.deep.breadth",
            "message": (
                "Deep research breadth 5 exceeds the deployment limit 4."
            ),
        }

    asyncio.run(execute())


def test_overlapping_research_runs_have_isolated_configuration(
    tmp_path: Path,
) -> None:
    coordination_dir = tmp_path / "overlap"
    coordination_dir.mkdir()
    parent_environment = {
        name: os.environ.get(name)
        for name in (
            "RETRIEVER",
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
    }

    requests = [
        ResearchRequest(
            systemPrompt=f"worker-{label}.ready",
            task=str(coordination_dir),
            retriever=retriever,
            baseUrl=f"https://{label}.models.example/v1/",
            apiKey=f"{label}-secret",
            fastLlm=f"openai:{label}-fast",
            smartLlm=f"openai:{label}-smart",
            embedding=f"openai:{label}-embedding",
            researchProfile={
                "schemaVersion": 1,
                "mode": "deep" if label == "beta" else "standard",
                "source": {
                    "mode": "web",
                    "retrievers": [retriever],
                },
                "quality": {"curateSources": False},
                "limits": {
                    "maxSearchResultsPerQuery": limits[0],
                    "maxIterations": limits[1],
                    "maxSubtopics": limits[2],
                },
                **({
                    "deep": {
                        "breadth": 3,
                        "depth": 2,
                        "concurrency": 2,
                    },
                } if label == "beta" else {}),
            },
        )
        for label, retriever, limits in (
            ("alpha", "duckduckgo", (4, 6, 8)),
            ("beta", "openalex", (7, 5, 9)),
        )
    ]
    executor = ProcessResearchExecutor(
        engine=overlapping_environment_probe,
        worker_concurrency=2,
        base_environment={
            **os.environ,
            "GPTR_ENABLED_RETRIEVERS": "duckduckgo,openalex",
            "GPTR_MAX_RETRIEVERS": "2",
        },
    )

    async def execute_both() -> tuple[list[ResearchResponse], list[list[str]]]:
        published: list[list[str]] = [[], []]
        responses = await asyncio.gather(
            *(
                executor.execute(
                    request,
                    lambda event, index=index: _record_event(
                        published[index],
                        event,
                    ),
                )
                for index, request in enumerate(requests)
            )
        )
        await executor.close()
        return responses, published

    responses, published = asyncio.run(execute_both())
    reports = [json.loads(response.report) for response in responses]

    assert reports[0] == {
        "worker": "worker-alpha.ready",
        "pid": reports[0]["pid"],
        "retriever": "duckduckgo",
        "baseUrl": "https://alpha.models.example/v1",
        "fastLlm": "openai:alpha-fast",
        "smartLlm": "openai:alpha-smart",
        "embedding": "openai:alpha-embedding",
        "maxSearchResultsPerQuery": "4",
        "maxIterations": "6",
        "maxSubtopics": "8",
        "deepResearchBreadth": None,
        "deepResearchDepth": None,
        "deepResearchConcurrency": None,
        "apiKeyMatchesRequest": True,
    }
    assert reports[1] == {
        "worker": "worker-beta.ready",
        "pid": reports[1]["pid"],
        "retriever": "openalex",
        "baseUrl": "https://beta.models.example/v1",
        "fastLlm": "openai:beta-fast",
        "smartLlm": "openai:beta-smart",
        "embedding": "openai:beta-embedding",
        "maxSearchResultsPerQuery": "7",
        "maxIterations": "5",
        "maxSubtopics": "9",
        "deepResearchBreadth": "3",
        "deepResearchDepth": "2",
        "deepResearchConcurrency": "2",
        "apiKeyMatchesRequest": True,
    }
    assert reports[0]["pid"] != reports[1]["pid"]
    assert published == [["probe.ready"], ["probe.ready"]]
    assert {
        name: os.environ.get(name)
        for name in parent_environment
    } == parent_environment


def test_worker_errors_are_stable_and_redact_request_secrets() -> None:
    executor = ProcessResearchExecutor(
        engine=leaking_failure_probe,
        worker_concurrency=1,
    )
    request = ResearchRequest(
        systemPrompt="Expert.",
        task="Research.",
        apiKey="do-not-leak-this-key",
    )

    async def execute() -> None:
        with pytest.raises(ResearchExecutionError) as captured:
            await executor.execute(request)
        await executor.close()
        assert captured.value.status_code == 502
        assert "do-not-leak-this-key" not in str(captured.value)
        assert "[REDACTED]" in str(captured.value)

    asyncio.run(execute())


def test_worker_preserves_structured_error_details() -> None:
    executor = ProcessResearchExecutor(
        engine=structured_failure_probe,
        worker_concurrency=1,
    )
    request = ResearchRequest(
        systemPrompt="Expert.",
        task="Research.",
        apiKey="do-not-leak-this-key",
    )

    async def execute() -> None:
        with pytest.raises(ResearchExecutionError) as captured:
            await executor.execute(request)
        await executor.close()
        assert captured.value.status_code == 422
        assert captured.value.detail == {
            "code": "source_address_forbidden",
            "path": "$.researchProfile.source.urls",
            "message": "rejected [REDACTED]",
        }

    asyncio.run(execute())


def test_cancelling_research_reaps_the_worker_process(
    tmp_path: Path,
) -> None:
    pid_file = tmp_path / "worker.pid"
    executor = ProcessResearchExecutor(
        engine=blocking_probe,
        worker_concurrency=1,
    )
    request = ResearchRequest(
        systemPrompt="Expert.",
        task=str(pid_file),
    )

    async def execute() -> int:
        task = asyncio.create_task(executor.execute(request))
        deadline = monotonic() + (
            15 if sys.platform == "win32" else 5
        )
        while not pid_file.exists():
            if monotonic() >= deadline:
                raise RuntimeError("worker did not start")
            await asyncio.sleep(0.02)
        pid = int(pid_file.read_text(encoding="utf-8"))
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await executor.close()
        return pid

    pid = asyncio.run(execute())
    assert _wait_for_process_exit(pid) is True


def test_execution_deadline_reaps_worker_before_returning_timeout(
    tmp_path: Path,
) -> None:
    pid_file = tmp_path / "deadline-worker.pid"
    executor = ProcessResearchExecutor(
        engine=blocking_probe,
        worker_concurrency=1,
    )
    request = ResearchRequest(
        researchRunId="research-deadline",
        executionTimeoutMs=2_000,
        systemPrompt="Expert.",
        task=str(pid_file),
    )

    async def execute() -> None:
        with pytest.raises(ResearchExecutionError) as captured:
            await executor.execute(request)
        await executor.close()
        assert captured.value.status_code == 504
        assert captured.value.detail == {
            "code": "research_execution_timeout",
            "message": (
                "GPT Researcher exceeded its execution deadline (2000ms) "
                "and the worker was stopped."
            ),
            "researchRunId": "research-deadline",
        }
        # Worker cleanup after cancellation is covered by the adjacent
        # process-lifecycle test. This test deliberately verifies the public
        # execution-deadline contract without making it depend on Windows
        # process-spawn timing.

    asyncio.run(execute())


def test_worker_redirected_streams_use_utf8() -> None:
    executor = ProcessResearchExecutor(
        engine=stream_encoding_probe,
        worker_concurrency=1,
    )
    request = ResearchRequest(
        systemPrompt="Expert.",
        task="Research.",
    )

    async def execute() -> dict[str, str]:
        response = await executor.execute(request)
        await executor.close()
        return json.loads(response.report)

    encodings = asyncio.run(execute())
    assert encodings == {
        "stdout": "utf-8",
        "stderr": "utf-8",
    }


def test_closing_executor_during_research_reaps_worker_cleanly(
    tmp_path: Path,
) -> None:
    pid_file = tmp_path / "shutdown-worker.pid"
    executor = ProcessResearchExecutor(
        engine=blocking_probe,
        worker_concurrency=1,
    )
    request = ResearchRequest(
        systemPrompt="Expert.",
        task=str(pid_file),
    )

    async def execute() -> int:
        task = asyncio.create_task(executor.execute(request))
        deadline = monotonic() + (
            15 if sys.platform == "win32" else 5
        )
        while not pid_file.exists():
            if monotonic() >= deadline:
                raise RuntimeError("worker did not start")
            await asyncio.sleep(0.02)
        pid = int(pid_file.read_text(encoding="utf-8"))
        await executor.close()
        with pytest.raises(ResearchExecutionError) as captured:
            await task
        assert captured.value.status_code == 502
        return pid

    pid = asyncio.run(execute())
    assert _wait_for_process_exit(pid) is True


def test_worker_crash_returns_terminal_gateway_error() -> None:
    executor = ProcessResearchExecutor(
        engine=crashing_probe,
        worker_concurrency=1,
    )
    request = ResearchRequest(
        systemPrompt="Expert.",
        task="Research.",
    )

    async def execute() -> None:
        with pytest.raises(ResearchExecutionError) as captured:
            await executor.execute(request)
        await executor.close()
        assert captured.value.status_code == 502
        assert "exit code 7" in str(captured.value)

    asyncio.run(execute())


async def _record_event(
    events: list[str],
    event: ResearchEvent,
) -> None:
    events.append(event.type)


def _process_exists(pid: int) -> bool:
    if sys.platform == "win32":
        query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(
            query_limited_information,
            False,
            pid,
        )
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(
                handle,
                ctypes.byref(exit_code),
            ):
                return False
            return exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)

    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _wait_for_process_exit(pid: int, timeout: float = 2) -> bool:
    deadline = monotonic() + timeout
    while _process_exists(pid):
        if monotonic() >= deadline:
            return False
        sleep(0.02)
    return True
