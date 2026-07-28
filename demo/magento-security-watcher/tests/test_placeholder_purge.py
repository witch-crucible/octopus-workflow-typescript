from __future__ import annotations

from pathlib import Path

from magento_security_watcher.config import AppSettings, ensure_data_dirs
from magento_security_watcher.ingest import IngestService
from magento_security_watcher.models import RiskItemAnalysis, RiskItemRecord, Severity
from magento_security_watcher.store import Store, _is_placeholder_analysis


def test_placeholder_detection():
    shell = RiskItemAnalysis(title="APSB20-47 security update", severity=Severity.UNKNOWN)
    assert _is_placeholder_analysis("APSB20-47:apsb20-47-security-update", shell)
    real = RiskItemAnalysis(title="x", cve_ids=["CVE-2023-1"], severity=Severity.HIGH)
    assert not _is_placeholder_analysis("APSB20-47:CVE-2023-1", real)


def test_ingest_purges_placeholder_shells(tmp_path: Path):
    settings = AppSettings(
        data_dir=str(tmp_path / "data"),
        db_path=str(tmp_path / "data" / "db" / "w.sqlite"),
    )
    settings.advisory.fixture_dir = str(Path(__file__).parent / "fixtures" / "advisories")
    settings.nvd.enabled = False
    settings.llm.enabled = False
    settings.git.mirrors_dir = str(tmp_path / "data" / "mirrors")
    paths = ensure_data_dirs(settings)
    store = Store(settings.db_path)

    store.upsert_bulletin("APSB20-47", "old", None, None, None)
    store.upsert_risk_item(
        RiskItemRecord(
            risk_id="APSB20-47:apsb20-47-security-update",
            bulletin_external_id="APSB20-47",
            analysis=RiskItemAnalysis(title="APSB20-47 security update"),
        )
    )
    store.upsert_risk_item(
        RiskItemRecord(
            risk_id="APSB20-47:CVE-2023-29296",
            bulletin_external_id="APSB20-47",
            analysis=RiskItemAnalysis(title="CVE", cve_ids=["CVE-2023-29296"]),
        )
    )
    assert store.get_risk_item("APSB20-47:apsb20-47-security-update")

    result = IngestService(settings, store, paths).run()
    assert result["purged_placeholders"] >= 1
    assert store.get_risk_item("APSB20-47:apsb20-47-security-update") is None
    # Fixture risks still present / re-upserted
    assert store.list_risk_items()


def test_ingest_skip_existing(tmp_path: Path):
    settings = AppSettings(
        data_dir=str(tmp_path / "data"),
        db_path=str(tmp_path / "data" / "db" / "w.sqlite"),
    )
    settings.advisory.fixture_dir = str(Path(__file__).parent / "fixtures" / "advisories")
    settings.nvd.enabled = False
    settings.llm.enabled = False
    settings.git.mirrors_dir = str(tmp_path / "data" / "mirrors")
    paths = ensure_data_dirs(settings)
    store = Store(settings.db_path)
    svc = IngestService(settings, store, paths)

    first = svc.run()
    assert first["created"] >= 1
    second = svc.run(skip_existing=True)
    assert second["created"] == 0
    assert second["updated"] == 0
    assert second["skipped_existing"] >= first["created"]
