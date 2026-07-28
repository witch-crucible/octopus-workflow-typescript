from __future__ import annotations

from magento_security_watcher.sources import HtmlBulletinSource


SAMPLE_LISTING = """
<html><body>
<a href="/security/products/magento/apsb26-73.html">APSB26-73</a>
<a href="/security/products/magento/apsb24-40.html">APSB24-40</a>
<a href="/security/products/photoshop/apsb26-01.html">APSB26-01</a>
</body></html>
"""


class FakeClient:
    def __init__(self, mapping: dict[str, object]) -> None:
        self.mapping = mapping

    def get(self, url: str):
        for key, resp in self.mapping.items():
            if key in url:
                return resp
        raise AssertionError(f"unexpected url {url}")


class FakeResp:
    def __init__(self, text: str, status_code: int = 200, url: str = "https://example.com") -> None:
        self.text = text
        self.status_code = status_code
        self.url = url

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            import httpx

            req = httpx.Request("GET", self.url)
            raise httpx.HTTPStatusError(
                "err", request=req, response=httpx.Response(self.status_code, request=req)
            )


def test_parse_magento_listing_only():
    source = HtmlBulletinSource(
        list_url="https://example.com/security/products/magento.html",
        user_agent="test",
        client=FakeClient({"magento.html": FakeResp(SAMPLE_LISTING)}),
        detail_fetch_limit=0,
    )
    bulletins = source.list_bulletins()
    ids = {b.external_id for b in bulletins}
    assert "APSB26-73" in ids
    assert "APSB24-40" in ids
    assert "APSB26-01" not in ids  # photoshop filtered when magento hrefs exist
    magento = next(b for b in bulletins if b.external_id == "APSB26-73")
    assert magento.risk_seeds == []  # no list-page placeholder shells


def test_404_message():
    source = HtmlBulletinSource(
        list_url="https://example.com/missing",
        user_agent="test",
        client=FakeClient({"missing": FakeResp("nope", status_code=404)}),
        detail_fetch_limit=0,
    )
    try:
        source.list_bulletins()
        assert False, "expected error"
    except RuntimeError as exc:
        assert "404" in str(exc)
        assert "helpx.adobe.com/security/products/magento.html" in str(exc)
