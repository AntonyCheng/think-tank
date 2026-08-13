"""Ephemeral export storage for MCP file downloads."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from secrets import token_urlsafe


@dataclass(frozen=True)
class Artifact:
    token: str
    file_path: Path
    filename: str
    media_type: str
    expires_at: datetime


class ArtifactStore:
    def __init__(self, root: Path, ttl_minutes: int) -> None:
        self._root = root
        self._ttl = timedelta(minutes=ttl_minutes)
        self._artifacts: dict[str, Artifact] = {}

    def create(self, filename: str, content: bytes, media_type: str) -> Artifact:
        self.cleanup()
        self._root.mkdir(parents=True, exist_ok=True)
        token = token_urlsafe(32)
        artifact = Artifact(
            token=token,
            file_path=self._root / token,
            filename=filename,
            media_type=media_type,
            expires_at=datetime.now(UTC) + self._ttl,
        )
        artifact.file_path.write_bytes(content)
        self._artifacts[token] = artifact
        return artifact

    def get(self, token: str) -> Artifact | None:
        self.cleanup()
        artifact = self._artifacts.get(token)
        if not artifact or not artifact.file_path.is_file():
            return None
        return artifact

    def cleanup(self) -> None:
        now = datetime.now(UTC)
        for token, artifact in list(self._artifacts.items()):
            if artifact.expires_at <= now:
                artifact.file_path.unlink(missing_ok=True)
                del self._artifacts[token]
