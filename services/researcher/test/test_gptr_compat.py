import builtins
from importlib.metadata import version

from app.gptr_compat import load_gpt_researcher


def test_loads_pinned_gptr_without_leaking_builtins() -> None:
    had_any = hasattr(builtins, "Any")
    had_list = hasattr(builtins, "List")

    researcher = load_gpt_researcher()

    assert researcher.__name__ == "GPTResearcher"
    assert version("gpt-researcher") == "0.16.0"
    assert hasattr(builtins, "Any") is had_any
    assert hasattr(builtins, "List") is had_list


def test_gptr_mcp_retriever_dependencies_are_available() -> None:
    load_gpt_researcher()

    from gpt_researcher.retrievers.mcp import MCPRetriever

    assert MCPRetriever is not None
    assert version("langchain-mcp-adapters") == "0.3.0"
