from __future__ import annotations

import builtins
from typing import Any, List


def load_gpt_researcher():
    """Import GPT Researcher 0.16.0 without modifying the installed package.

    The 0.16.0 wheel defines ``_normalize_sub_queries`` before importing the
    ``Any`` and ``List`` names used by its runtime-evaluated annotations. Python
    falls back to builtins for global name resolution, so exposing those names
    only for the duration of the first import safely bridges the packaging bug.
    """

    sentinel = object()
    previous_any = getattr(builtins, "Any", sentinel)
    previous_list = getattr(builtins, "List", sentinel)
    builtins.Any = Any
    builtins.List = List

    try:
        from gpt_researcher import GPTResearcher
    finally:
        if previous_any is sentinel:
            del builtins.Any
        else:
            builtins.Any = previous_any

        if previous_list is sentinel:
            del builtins.List
        else:
            builtins.List = previous_list

    return GPTResearcher
