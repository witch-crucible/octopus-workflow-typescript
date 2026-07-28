from __future__ import annotations

from pathlib import Path

from magento_security_watcher.sources import LocalHtmlIndexSource

SAMPLE = """
<html><body>
<a href="/security/products/magento/apsb26-73.html">APSB26-73</a>
<a href="/security/products/magento/apsb24-40.html">APSB24-40</a>
</body></html>
"""


def test_local_html_index(tmp_path: Path):
    path = tmp_path / "magento.html"
    path.write_text(SAMPLE, encoding="utf-8")
    source = LocalHtmlIndexSource(path, detail_fetch_limit=0)
    bulletins = source.list_bulletins()
    assert {b.external_id for b in bulletins} == {"APSB26-73", "APSB24-40"}
