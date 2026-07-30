from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse


MIN_DUPLICATE_BLOCK_CHARACTERS = 600
MIN_DUPLICATE_BLOCK_PARAGRAPHS = 2
MARKDOWN_LINK = re.compile(r"(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)")


def collapse_repeated_report_blocks(report: str) -> str:
    """Remove exact, large paragraph runs repeated by compatible LLM streams."""
    paragraphs = [
        paragraph.strip()
        for paragraph in re.split(r"\n\s*\n", report.strip())
        if paragraph.strip()
    ]

    changed = True
    while changed:
        changed = False
        for later in range(1, len(paragraphs)):
            for earlier in range(later):
                run_length = 0
                max_run = min(later - earlier, len(paragraphs) - later)
                while (
                    run_length < max_run
                    and paragraphs[earlier + run_length]
                    == paragraphs[later + run_length]
                ):
                    run_length += 1

                duplicate_size = sum(
                    len(paragraph)
                    for paragraph in paragraphs[later : later + run_length]
                )
                if (
                    run_length >= MIN_DUPLICATE_BLOCK_PARAGRAPHS
                    and duplicate_size >= MIN_DUPLICATE_BLOCK_CHARACTERS
                ):
                    del paragraphs[later : later + run_length]
                    changed = True
                    break
            if changed:
                break

    return "\n\n".join(paragraphs)


def sanitize_report(report: str) -> str:
    """Remove reasoning and duplicated continuation blocks from a deliverable."""
    closing_tag = "</think>"
    if closing_tag in report:
        report = report.rsplit(closing_tag, maxsplit=1)[1]
    return collapse_repeated_report_blocks(report)


def normalize_citation_links(
    report: str,
    source_urls: list[str],
    sources: list[Any],
) -> tuple[str, int]:
    """Replace citation-title link targets with verified HTTP source URLs."""
    indexed_urls = [
        url if _is_http_url(url) else None
        for url in source_urls
    ]
    titled_urls: list[tuple[str, str]] = []
    for source in sources:
        if not isinstance(source, dict):
            continue
        url = next(
            (
                str(source[key])
                for key in ("url", "href", "link")
                if source.get(key) and _is_http_url(str(source[key]))
            ),
            None,
        )
        title = next(
            (
                str(source[key])
                for key in ("title", "name")
                if source.get(key)
            ),
            None,
        )
        if url and title:
            titled_urls.append((_citation_key(title), url))

    replacements = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal replacements
        label, target = match.groups()
        clean_target = target.strip().strip("<>")
        if _is_http_url(clean_target):
            return match.group(0)

        target_key = _citation_key(clean_target)
        matching_url: str | None = None
        matching_length = 0
        for title_key, url in titled_urls:
            if (
                len(title_key) >= 6
                and (
                    title_key in target_key
                    or target_key in title_key
                )
                and len(title_key) > matching_length
            ):
                matching_url = url
                matching_length = len(title_key)

        if matching_url is None:
            number = re.search(r"\d+", label)
            if number:
                index = int(number.group(0)) - 1
                if 0 <= index < len(indexed_urls):
                    matching_url = indexed_urls[index]

        if matching_url is None:
            return match.group(0)

        replacements += 1
        return f"[{label}]({matching_url})"

    return MARKDOWN_LINK.sub(replace, report), replacements


def _citation_key(value: str) -> str:
    return re.sub(r"[\W_]+", "", value.casefold(), flags=re.UNICODE)


def _is_http_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)
