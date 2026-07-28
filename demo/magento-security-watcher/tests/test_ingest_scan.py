from __future__ import annotations

import json
from pathlib import Path

from magento_security_watcher.config import AppSettings, ensure_data_dirs
from magento_security_watcher.ingest import IngestService
from magento_security_watcher.inventory import MagentoInventory
from magento_security_watcher.models import ProjectConfig
from magento_security_watcher.notify import WeComNotifier, notify_project, should_notify
from magento_security_watcher.scan import ScanService
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
    settings.git.mirrors_dir = str(tmp_path / "data" / "mirrors")
    return settings


def test_ingest_from_fixtures(tmp_path: Path):
    settings = _settings(tmp_path)
    paths = ensure_data_dirs(settings)
    store = Store(settings.db_path)
    result = IngestService(settings, store, paths).run()
    assert result["bulletins"] == 1
    assert result["created"] == 2
    risks = store.list_risk_items()
    assert len(risks) == 2
    patched = next(r for r in risks if "10001" in r.risk_id)
    assert patched.analysis.fingerprints
    assert patched.report_path and Path(patched.report_path).is_file()
    assert patched.analysis.remediation_options.has_isolated_patch is True
    assert patched.analysis.remediation_options.upgrade_available is True
    assert patched.analysis.remediation_offer.value == "upgrade_or_patch"
    upgrade_only = next(r for r in risks if "10002" in r.risk_id)
    assert upgrade_only.analysis.remediation_options.upgrade_available is True
    assert upgrade_only.analysis.remediation_offer.value == "upgrade_only"
    # LLM disabled: no fake Chinese analysis templates
    assert "未启用 LLM" in (upgrade_only.analysis.narrative or "")
    assert "llm" in upgrade_only.analysis.source_missing
    assert paths["llm_logs"].is_dir()


def test_scan_local_workspace(tmp_path: Path):
    settings = _settings(tmp_path)
    paths = ensure_data_dirs(settings)
    store = Store(settings.db_path)
    IngestService(settings, store, paths).run()

    workspace = tmp_path / "shop"
    # vulnerable file content
    rel = Path("vendor/magento/module-customer/Model/AccountManagement.php")
    target = workspace / rel
    target.parent.mkdir(parents=True)
    target.write_text("if ($user->isAllowed()) {\n", encoding="utf-8")
    lock = {
        "packages": [
            {"name": "magento/module-customer", "version": "2.4.5"},
            {"name": "magento/module-quote", "version": "2.4.5"},
            {"name": "magento/product-community-edition", "version": "2.4.5"},
        ],
        "packages-dev": [],
    }
    (workspace / "composer.lock").write_text(json.dumps(lock), encoding="utf-8")

    inv = MagentoInventory(workspace).collect()
    assert inv["product_version"] == "2.4.5"

    project = ProjectConfig(
        id="demo-shop",
        name="Demo",
        git_url="file:///dev/null",
        branch="main",
    )
    service = ScanService(settings, store, paths)
    findings, skipped = service.scan_one(project, local_workspace=workspace)
    assert skipped == 0
    assert len(findings) == 2
    f1 = next(f for f in findings if "10001" in f.risk_id)
    assert f1.remediation_status.value == "vulnerable"
    f2 = next(f for f in findings if "10002" in f.risk_id)
    assert f2.remediation_status.value == "vulnerable"
    summary = paths["reports_projects"] / "demo-shop" / "SUMMARY.md"
    assert summary.is_file()

    # Mark one fixed in DB, then incremental scan should skip it.
    from magento_security_watcher.models import FindingEvidence, FindingRecord, FixMethod, RemediationStatus

    run_id = store.start_scan_run(project.id)
    store.insert_finding(
        run_id,
        FindingRecord(
            project_id=project.id,
            risk_id=f1.risk_id,
            remediation_status=RemediationStatus.FIXED,
            fix_method=FixMethod.UPGRADE,
            evidence=FindingEvidence(),
            analysis_snapshot=f1.analysis_snapshot,
            evidence_fingerprint="fixed-fp",
        ),
    )
    store.finish_scan_run(run_id, "ok", git_commit="local")

    findings2, skipped2 = service.scan_one(project, local_workspace=workspace, full=False)
    assert skipped2 == 1
    assert len(findings2) == 1
    assert findings2[0].risk_id == f2.risk_id

    findings3, skipped3 = service.scan_one(project, local_workspace=workspace, full=True)
    assert skipped3 == 0
    assert len(findings3) == 2


def test_alert_dedupe(tmp_path: Path):
    settings = _settings(tmp_path)
    store = Store(settings.db_path)
    from magento_security_watcher.models import FindingRecord, FixMethod, RemediationStatus

    finding = FindingRecord(
        project_id="p1",
        risk_id="APSB:r1",
        remediation_status=RemediationStatus.VULNERABLE,
        fix_method=FixMethod.NONE,
        evidence_fingerprint="abc",
    )
    notifier = WeComNotifier(None, enabled=False)
    assert notify_project(store, notifier, [finding], project_id="p1") is True
    prev = store.get_alert_state("project:p1")
    assert prev is not None
    assert should_notify(store, "project:p1", prev["last_status"], prev["last_fingerprint"]) is False
    assert notify_project(store, notifier, [finding], project_id="p1") is False
    finding.evidence_fingerprint = "def"
    assert notify_project(store, notifier, [finding], project_id="p1") is True
