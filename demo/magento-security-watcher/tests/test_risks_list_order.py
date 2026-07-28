from __future__ import annotations

from pathlib import Path

from magento_security_watcher.models import RiskItemAnalysis, RiskItemRecord, Severity
from magento_security_watcher.store import Store, _risk_official_sort_key
from magento_security_watcher.web.presenters import format_date_ymd


def test_format_date_ymd():
    assert format_date_ymd("2026-07-22T07:39:15.694189+00:00") == "2026-07-22"
    assert format_date_ymd("2026-07-22") == "2026-07-22"
    assert format_date_ymd(None) == "—"
    assert format_date_ymd("") == "—"


def _risk(risk_id: str, bulletin: str, title: str) -> RiskItemRecord:
    return RiskItemRecord(
        risk_id=risk_id,
        bulletin_external_id=bulletin,
        analysis=RiskItemAnalysis(title=title, severity=Severity.MEDIUM),
    )


def test_risk_list_sorts_by_apsb_official_order(tmp_path: Path):
    store = Store(tmp_path / "t.sqlite")
    store.upsert_bulletin("APSB26-05", "older", None, None, "")
    store.upsert_bulletin("APSB26-73", "newer", None, None, "")
    store.upsert_bulletin("APSB25-01", "older year", None, None, "")
    store.upsert_risk_item(_risk("APSB26-05:CVE-OLD", "APSB26-05", "old"))
    store.upsert_risk_item(_risk("APSB26-73:CVE-NEW", "APSB26-73", "new"))
    store.upsert_risk_item(_risk("APSB25-01:CVE-OLDER", "APSB25-01", "older year"))
    ids = [r["risk_id"] for r in store.list_risk_item_rows()]
    assert ids[0].startswith("APSB26-73")
    assert ids[1].startswith("APSB26-05")
    assert ids[2].startswith("APSB25-01")


def test_risk_official_sort_key_numeric_seq():
    a = _risk_official_sort_key({"bulletin_external_id": "APSB26-9", "risk_id": "a"})
    b = _risk_official_sort_key({"bulletin_external_id": "APSB26-73", "risk_id": "b"})
    assert b > a
