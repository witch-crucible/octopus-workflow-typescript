from __future__ import annotations

import json
from pathlib import Path

import httpx

from magento_security_watcher.sources import NvdClient


class CountingClient:
    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.calls = 0

    def get(self, url: str, params=None, headers=None):
        self.calls += 1
        cve_id = (params or {}).get("cveId", "CVE-1")
        req = httpx.Request("GET", url)
        body = {
            "vulnerabilities": [
                {"cve": {"id": cve_id, **self.payload}},
            ]
        }
        return httpx.Response(200, json=body, request=req)


class RateLimitedThenOkClient:
    def __init__(self) -> None:
        self.calls = 0

    def get(self, url: str, params=None, headers=None):
        self.calls += 1
        req = httpx.Request("GET", url)
        if self.calls == 1:
            return httpx.Response(429, text="slow down", request=req)
        body = {"vulnerabilities": [{"cve": {"id": params["cveId"], "descriptions": []}}]}
        return httpx.Response(200, json=body, request=req)


def test_nvd_memory_and_disk_cache(tmp_path: Path):
    http = CountingClient({"descriptions": [{"lang": "en", "value": "desc"}]})
    client = NvdClient(
        api_base="https://example.com/nvd",
        delay=0,
        client=http,  # type: ignore[arg-type]
        cache_dir=tmp_path / "nvd",
        cache_ttl_days=30,
    )
    a = client.fetch_cve("CVE-2026-1")
    b = client.fetch_cve("CVE-2026-1")
    assert a and a["id"] == "CVE-2026-1"
    assert b == a
    assert http.calls == 1
    assert (tmp_path / "nvd" / "CVE-2026-1.json").is_file()

    # New client instance still hits disk, not network
    http2 = CountingClient({"descriptions": [{"lang": "en", "value": "desc"}]})
    client2 = NvdClient(
        api_base="https://example.com/nvd",
        delay=0,
        client=http2,  # type: ignore[arg-type]
        cache_dir=tmp_path / "nvd",
        cache_ttl_days=30,
    )
    c = client2.fetch_cve("CVE-2026-1")
    assert c and c["id"] == "CVE-2026-1"
    assert http2.calls == 0


def test_nvd_429_uses_stale_cache(tmp_path: Path):
    cache = tmp_path / "nvd"
    cache.mkdir()
    (cache / "CVE-2026-9.json").write_text(
        json.dumps(
            {
                "cve_id": "CVE-2026-9",
                "fetched_at": 0,
                "cve": {"id": "CVE-2026-9", "descriptions": [{"lang": "en", "value": "old"}]},
            }
        ),
        encoding="utf-8",
    )
    # Force expired by ttl 0 and allow_stale path via 429
    http = RateLimitedThenOkClient()
    # First: cache expired (ttl=0) so would fetch → 429 → stale
    client = NvdClient(
        api_base="https://example.com/nvd",
        delay=0,
        client=http,  # type: ignore[arg-type]
        cache_dir=cache,
        cache_ttl_days=0,
        use_stale_on_rate_limit=True,
    )
    cve = client.fetch_cve("CVE-2026-9")
    assert cve and cve["id"] == "CVE-2026-9"
    assert http.calls == 1
