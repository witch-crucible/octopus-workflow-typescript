from __future__ import annotations

from magento_security_watcher.models import (
    BulletinAnalysis,
    FindingEvidence,
    FindingRecord,
    FixMethod,
    RemediationStatus,
    RiskItemAnalysis,
    RiskItemRecord,
    Severity,
)
from magento_security_watcher.notify import (
    WeComNotifier,
    alert_key_bulletin,
    alert_key_project,
    finding_from_row,
    notify_bulletin,
    notify_pending,
    notify_project,
    notify_scan_error,
    should_notify,
)
from magento_security_watcher.store import Store


class FakeResp:
    def __init__(self, payload=None, status_code=200):
        self._payload = payload if payload is not None else {"errcode": 0}
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")

    def json(self):
        return self._payload


class FakeClient:
    def __init__(self):
        self.calls = []

    def post(self, url, json=None):
        self.calls.append({"url": url, "json": json})
        return FakeResp()


def _finding(
    *,
    project_id="p1",
    risk_id="APSB26-73:CVE-1",
    status=RemediationStatus.VULNERABLE,
    severity=Severity.HIGH,
    fp="fp1",
):
    return FindingRecord(
        project_id=project_id,
        risk_id=risk_id,
        remediation_status=status,
        fix_method=FixMethod.NONE,
        evidence_fingerprint=fp,
        analysis_snapshot=RiskItemAnalysis(title="t", severity=severity),
    )


def test_send_markdown_no_at_all():
    client = FakeClient()
    n = WeComNotifier("https://example.com/hook", enabled=True, client=client)
    assert n.send_markdown("hello") is True
    assert client.calls[-1]["json"]["msgtype"] == "markdown"

    assert n.send_markdown("crit", mention_all=True) is True
    assert len(client.calls) == 2
    body = client.calls[-1]["json"]
    assert body["msgtype"] == "markdown"
    assert "<@all>" not in body["markdown"]["content"]
    assert "mentioned_list" not in str(body)


def test_format_project_summary_aggregates_by_bulletin():
    n = WeComNotifier(None, enabled=False)
    text = n.format_project_summary(
        [
            _finding(risk_id="APSB26-73:CVE-1", severity=Severity.CRITICAL),
            _finding(risk_id="APSB26-73:CVE-2", fp="fp2"),
            _finding(risk_id="APSB24-61:CVE-9", fp="fp3", severity=Severity.MEDIUM),
        ],
        project_id="p1",
        project_name="Demo",
    )
    assert "通知" in text
    assert "告警" not in text
    assert "Demo" in text
    assert "APSB26-73" in text
    assert "APSB24-61" in text
    assert "CVE-2026" not in text
    assert 'font color="warning"' in text
    assert text.startswith("## ")


def test_format_bulletin_uses_wecom_markdown():
    n = WeComNotifier(None, enabled=False)
    text = n.format_bulletin_summary(
        external_id="APSB26-73",
        title="Adobe Security Bulletin",
        analysis=BulletinAnalysis(
            severity_overview="严重为主",
            business_impact_scope="结账",
            remediation_summary="先升级再打补丁",
            has_isolated_patch=True,
            upgrade_available=True,
        ),
    )
    assert text.startswith("## Magento 安全监控 — 公告情报")
    assert "**等级概览**" in text
    assert ">严重为主" in text or ">严重为主" in text.replace(" ", "")
    assert 'font color="info"' in text


def test_notify_project_dedupe_and_force(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    client = FakeClient()
    notifier = WeComNotifier(
        "https://example.com/hook",
        enabled=True,
        mention_all_on_critical=True,
        client=client,
    )
    findings = [
        _finding(severity=Severity.CRITICAL),
        _finding(risk_id="APSB26-73:CVE-2", fp="fp2"),
    ]
    assert notify_project(store, notifier, findings, project_id="p1", project_name="P1") is True
    assert client.calls[-1]["json"]["msgtype"] == "markdown"
    assert "<@all>" not in client.calls[-1]["json"]["markdown"]["content"]
    st = store.get_alert_state(alert_key_project("p1"))
    assert should_notify(store, alert_key_project("p1"), st["last_status"], st["last_fingerprint"]) is False
    assert notify_project(store, notifier, findings, project_id="p1") is False
    n_calls = len(client.calls)
    assert notify_project(store, notifier, findings, project_id="p1", force=True) is True
    assert len(client.calls) == n_calls + 1


def test_notify_bulletin_no_cve_list_and_dedupe(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    notifier = WeComNotifier(None, enabled=False)
    analysis = BulletinAnalysis(
        severity_overview="严重为主",
        business_impact_scope="结账",
        remediation_summary="先升级再打补丁",
        has_isolated_patch=True,
        upgrade_available=True,
    )
    assert (
        notify_bulletin(
            store,
            notifier,
            external_id="APSB26-73",
            title="Adobe Security Bulletin",
            analysis=analysis,
            created_count=3,
            has_critical=True,
        )
        is True
    )
    content = store.get_alert_state(alert_key_bulletin("APSB26-73"))["last_payload"]
    assert "公告情报" in content
    assert "CVE-" not in content
    assert "先升级再打补丁" in content
    assert (
        notify_bulletin(
            store,
            notifier,
            external_id="APSB26-73",
            title="Adobe Security Bulletin",
            analysis=analysis,
            created_count=3,
        )
        is False
    )
    assert (
        notify_bulletin(
            store,
            notifier,
            external_id="APSB26-73",
            title="Adobe Security Bulletin",
            analysis=analysis,
            created_count=3,
            force=True,
        )
        is True
    )


def test_notify_scan_error_dedupe(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    notifier = WeComNotifier(None, enabled=False)
    assert notify_scan_error(store, notifier, "p1", "boom") is True
    assert notify_scan_error(store, notifier, "p1", "boom") is False
    assert notify_scan_error(store, notifier, "p1", "boom2") is True


def test_notify_pending_one_per_project(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    notifier = WeComNotifier(None, enabled=False)
    analysis = RiskItemAnalysis(title="t", severity=Severity.HIGH)
    store.upsert_bulletin("APSB26-73", "b", None, None, None)
    store.upsert_risk_item(
        RiskItemRecord(risk_id="APSB26-73:r1", bulletin_external_id="APSB26-73", analysis=analysis)
    )
    store.upsert_risk_item(
        RiskItemRecord(risk_id="APSB26-73:r2", bulletin_external_id="APSB26-73", analysis=analysis)
    )
    run_id = store.start_scan_run("p1")
    for rid, fp in (("APSB26-73:r1", "fp-a"), ("APSB26-73:r2", "fp-b")):
        store.insert_finding(
            run_id,
            FindingRecord(
                project_id="p1",
                risk_id=rid,
                remediation_status=RemediationStatus.VULNERABLE,
                fix_method=FixMethod.NONE,
                evidence=FindingEvidence(),
                analysis_snapshot=analysis,
                evidence_fingerprint=fp,
            ),
        )
    store.finish_scan_run(run_id, "ok")

    result = notify_pending(store, notifier, project_ids=["p1"], project_names={"p1": "P1"})
    assert result["candidates"] == 1
    assert result["notified"] == 1
    result2 = notify_pending(store, notifier, project_ids=["p1"])
    assert result2["notified"] == 0
    assert result2["skipped"] == 1

    row = store.list_latest_findings("p1")[0]
    rebuilt = finding_from_row(row)
    assert rebuilt.remediation_status == RemediationStatus.VULNERABLE


def test_truncate_utf8_respects_bytes():
    from magento_security_watcher.notify import _truncate_utf8

    text = "安" * 100  # 3 bytes each
    out = _truncate_utf8(text, 20)
    assert len(out.encode("utf-8")) <= 20
    assert out.endswith("…")


def test_send_markdown_surfaces_wecom_errcode():
    class ErrClient:
        def post(self, url, json=None):
            return FakeResp({"errcode": 93000, "errmsg": "invalid webhook url"})

    n = WeComNotifier("https://example.com/hook", enabled=True, client=ErrClient())
    assert n.send_markdown("hello") is False
    assert n.last_error and "93000" in n.last_error
    assert "invalid webhook" in n.last_error
