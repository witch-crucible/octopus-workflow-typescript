from pathlib import Path

from magento_security_watcher.config import AppSettings, ensure_data_dirs
from magento_security_watcher.models import RiskItemAnalysis, RiskItemRecord, Severity
from magento_security_watcher.store import Store


def _store(tmp_path: Path) -> Store:
    settings = AppSettings(
        data_dir=str(tmp_path / "data"),
        db_path=str(tmp_path / "data" / "db" / "watcher.sqlite"),
    )
    ensure_data_dirs(settings)
    return Store(settings.db_path)


def test_delete_risk_and_year_mismatch(tmp_path: Path):
    store = _store(tmp_path)
    store.upsert_bulletin("APSB20-02", "old", None, "https://example.com/apsb20-02", "body")
    store.upsert_bulletin("APSB24-61", "ok", None, "https://example.com/apsb24-61", "body")
    store.upsert_risk_item(
        RiskItemRecord(
            risk_id="APSB20-02:CVE-2024-39397",
            bulletin_external_id="APSB20-02",
            analysis=RiskItemAnalysis(
                title="bad",
                cve_ids=["CVE-2024-39397"],
                severity=Severity.CRITICAL,
            ),
        )
    )
    store.upsert_risk_item(
        RiskItemRecord(
            risk_id="APSB24-61:CVE-2024-39397",
            bulletin_external_id="APSB24-61",
            analysis=RiskItemAnalysis(
                title="good",
                cve_ids=["CVE-2024-39397"],
                severity=Severity.CRITICAL,
            ),
        )
    )

    bad = store.list_year_mismatched_risk_ids()
    assert bad == ["APSB20-02:CVE-2024-39397"]

    removed = store.delete_risk_items(bad)
    assert removed == ["APSB20-02:CVE-2024-39397"]
    left = [r.risk_id for r in store.list_risk_items()]
    assert left == ["APSB24-61:CVE-2024-39397"]
