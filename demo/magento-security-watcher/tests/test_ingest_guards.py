from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

from magento_security_watcher.config import AppSettings, ensure_data_dirs
from magento_security_watcher.ingest import (
    IngestService,
    bulletin_body_ready_for_assist,
    parse_risk_id_filters,
    seed_belongs_to_bulletin,
)
from magento_security_watcher.store import Store


FIXTURES = Path(__file__).parent / "fixtures" / "advisories"


def _settings(tmp_path: Path) -> AppSettings:
    settings = AppSettings(
        data_dir=str(tmp_path / "data"),
        db_path=str(tmp_path / "data" / "db" / "watcher.sqlite"),
    )
    settings.advisory.fixture_dir = str(FIXTURES)
    settings.nvd.enabled = False
    settings.llm.enabled = False
    settings.wecom.enabled = False
    return settings


def test_parse_risk_id_filters():
    assert parse_risk_id_filters(None) is None
    assert parse_risk_id_filters([]) is None
    got = parse_risk_id_filters(
        ["APSB26-73:CVE-2026-48371", "apsb24-61:cve-2024-39397, APSB20-02:CVE-2020-3715"]
    )
    assert got == {
        "APSB26-73:CVE-2026-48371",
        "APSB24-61:CVE-2024-39397",
        "APSB20-02:CVE-2020-3715",
    }


def test_bulletin_body_ready_for_assist():
    assert not bulletin_body_ready_for_assist("")
    assert not bulletin_body_ready_for_assist("short")
    long_empty = "x" * 600
    assert not bulletin_body_ready_for_assist(long_empty)
    body = ("Adobe Security Update. " * 40) + " CVE-2024-39397 Affected Versions listed."
    assert bulletin_body_ready_for_assist(body)


def test_seed_belongs_rejects_empty_body_invent():
    seed = {"cve_ids": ["CVE-2024-39397"], "title": "x"}
    assert not seed_belongs_to_bulletin(seed, bulletin_id="APSB20-02", raw_text="")


def test_seed_belongs_rejects_year_mismatch_even_if_mentioned():
    raw = "Footer noise mentions CVE-2024-39397 but this is APSB20-02 from 2020."
    seed = {"cve_ids": ["CVE-2024-39397"]}
    assert not seed_belongs_to_bulletin(seed, bulletin_id="APSB20-02", raw_text=raw)


def test_seed_belongs_accepts_matching_cve():
    raw = "APSB24-61 Vulnerability Details include CVE-2024-39397 and CVE-2024-39400."
    seed = {"cve_ids": ["CVE-2024-39397"]}
    assert seed_belongs_to_bulletin(seed, bulletin_id="APSB24-61", raw_text=raw)


def test_empty_shell_skips_llm_assist(tmp_path: Path):
    settings = _settings(tmp_path)
    settings.llm.enabled = True
    settings.advisory.fixture_dir = None
    paths = ensure_data_dirs(settings)
    store = Store(settings.db_path)

    # Bulletin shell with no body / no seeds — LLM must not invent CVEs.
    from magento_security_watcher.sources import RawBulletin

    class FakeSource:
        def list_bulletins(self):
            return [
                RawBulletin(
                    external_id="APSB20-02",
                    title="Adobe Magento Security Bulletin APSB20-02",
                    url="https://helpx.adobe.com/security/products/magento/apsb20-02.html",
                    published_at=None,
                    raw_text="",
                    risk_seeds=[],
                )
            ]

    svc = IngestService(settings, store, paths)
    svc._source = lambda html_file=None: FakeSource()  # type: ignore[method-assign]
    svc.llm = MagicMock()
    svc.llm.enabled = True
    svc.llm.assist_structure.return_value = [
        {"title": "invented", "cve_ids": ["CVE-2024-39397"], "severity": "critical"}
    ]
    svc.llm.analyze_bulletin_zh.return_value = None

    result = svc.run()
    svc.llm.assist_structure.assert_not_called()
    assert result["created"] == 0
    assert store.list_risk_items() == []


def test_ingest_risks_filter(tmp_path: Path):
    settings = _settings(tmp_path)
    paths = ensure_data_dirs(settings)
    store = Store(settings.db_path)
    only = {"APSB99-01:CVE-2026-10001"}
    result = IngestService(settings, store, paths).run(risk_ids=only)
    assert result["created"] == 1
    assert result["skipped_filter"] >= 1
    risks = store.list_risk_items()
    assert len(risks) == 1
    assert risks[0].risk_id == "APSB99-01:CVE-2026-10001"
