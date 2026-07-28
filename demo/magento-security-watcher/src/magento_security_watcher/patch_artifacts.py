"""Download Magento isolated-patch ZIP artifacts and extract unified diffs."""

from __future__ import annotations

import hashlib
import logging
import zipfile
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)


def zip_cache_path(cache_dir: Path, url: str) -> Path:
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    name = Path(urlparse(url).path).name or "patch.zip"
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in name)[:80]
    return cache_dir / f"{digest}_{safe}"


def download_patch_zip(
    url: str,
    dest: Path,
    *,
    username: Optional[str] = None,
    password: Optional[str] = None,
    timeout: float = 120.0,
    client: Optional[httpx.Client] = None,
) -> Path:
    """Download a patch zip to dest (skipped if dest already exists and non-empty)."""
    if dest.is_file() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    auth = (username, password) if username and password else None
    own = client is None
    http = client or httpx.Client(timeout=timeout, follow_redirects=True, trust_env=True, http2=False)
    try:
        resp = http.get(url, auth=auth)
        resp.raise_for_status()
        dest.write_bytes(resp.content)
    finally:
        if own:
            http.close()
    return dest


def extract_patch_texts_from_zip(zip_path: Path) -> list[tuple[str, str]]:
    """Return (member_name, unified_diff_text) for .patch/.diff members."""
    out: list[tuple[str, str]] = []
    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = info.filename
            lower = name.lower()
            if not (lower.endswith(".patch") or lower.endswith(".diff")):
                continue
            raw = zf.read(info)
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("latin-1", errors="replace")
            if text.strip():
                out.append((name, text))
    return out


def prefer_zip_urls(urls: list[str], *, limit: int) -> list[str]:
    """Prefer public (non-/auth/) zips first, then cap count."""
    if limit <= 0 or not urls:
        return []
    public = [u for u in urls if "/auth/" not in u.lower()]
    authed = [u for u in urls if "/auth/" in u.lower()]
    ordered = public + authed
    return ordered[:limit]
