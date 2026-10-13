from __future__ import annotations

import hashlib


def song_asset_id(media_kind: str, source_id: str | None, source_url: str) -> str:
    """Return a stable ID shared by search and preparation for the same media kind."""
    cache_key = (source_id or source_url).strip()
    return hashlib.sha256(
        f"{media_kind}:{cache_key}".encode("utf-8")
    ).hexdigest()[:32]
