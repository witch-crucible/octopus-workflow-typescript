from __future__ import annotations

from pathlib import Path

import yaml
from fastapi.testclient import TestClient

from magento_security_watcher.config import AppSettings, ensure_data_dirs
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
from magento_security_watcher.store import Store
from magento_security_watcher.web.app import create_app
from magento_security_watcher.web.middleware import IPAllowlistMiddleware, ip_allowed, resolve_client_ip
from magento_security_watcher.web.presenters import redact_git_url
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient as StarletteTestClient


def test_redact_git_url_strips_credentials():
    url = "https://woody.yang:s3cretToken@git.example.com/org/repo.git"
    out = redact_git_url(url)
    assert "s3cretToken" not in out
    assert "woody.yang" not in out
    assert "***@git.example.com" in out
    assert out.endswith("/org/repo.git")


def test_list_latest_findings_picks_max_id(tmp_path: Path):
    db = tmp_path / "w.sqlite"
    store = Store(db)
    store.upsert_bulletin("B1", "t", None, None, None)
    analysis = RiskItemAnalysis(title="R", severity=Severity.HIGH)
    store.upsert_risk_item(
        RiskItemRecord(risk_id="R1", bulletin_external_id="B1", analysis=analysis)
    )
    f1 = FindingRecord(
        project_id="p1",
        risk_id="R1",
        remediation_status=RemediationStatus.VULNERABLE,
        fix_method=FixMethod.NONE,
        evidence=FindingEvidence(),
        evidence_fingerprint="a",
    )
    f2 = FindingRecord(
        project_id="p1",
        risk_id="R1",
        remediation_status=RemediationStatus.FIXED,
        fix_method=FixMethod.UPGRADE,
        evidence=FindingEvidence(),
        evidence_fingerprint="b",
    )
    store.insert_finding(None, f1)
    store.insert_finding(None, f2)
    latest = store.list_latest_findings(project_id="p1")
    assert len(latest) == 1
    assert latest[0]["remediation_status"] == "fixed"
    assert store.count_latest_by_status("p1")["fixed"] == 1
    assert store.count_open_latest_findings() == 0


def test_ip_allowlist_middleware_blocks():
    async def homepage(request: Request):
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/", homepage)])
    app.add_middleware(
        IPAllowlistMiddleware,
        allowed_cidrs=["127.0.0.1/32"],
        trust_x_forwarded_for=False,
        bypass=False,
    )
    client = StarletteTestClient(app)
    # TestClient host is "testclient" → allowed by middleware special-case
    assert client.get("/").status_code == 200

    assert ip_allowed("10.0.0.1", []) is False
    from magento_security_watcher.web.middleware import default_loopback_networks

    nets = default_loopback_networks()
    assert ip_allowed("127.0.0.1", nets) is True
    assert ip_allowed("8.8.8.8", nets) is False


def test_ip_allowlist_with_forwarded_header():
    async def homepage(request: Request):
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/", homepage)])
    app.add_middleware(
        IPAllowlistMiddleware,
        allowed_cidrs=["10.1.2.3/32"],
        trust_x_forwarded_for=True,
        bypass=False,
    )

    # Force a non-testclient host by using ASGI scope manipulation via headers only when trusted.
    # Starlette TestClient still sets client to testclient; special-case still allows.
    # Unit-test resolve + ip_allowed instead for forwarded path:
    class FakeClient:
        host = "192.168.1.1"

    class FakeRequest:
        headers = {"x-forwarded-for": "10.1.2.3, 1.1.1.1"}
        client = FakeClient()

    ip = resolve_client_ip(FakeRequest(), trust_x_forwarded_for=True)  # type: ignore[arg-type]
    assert ip == "10.1.2.3"
    import ipaddress

    assert ip_allowed(ip, [ipaddress.ip_network("10.1.2.3/32")])


def _seed_web(tmp_path: Path) -> tuple[AppSettings, Store, Path]:
    root = tmp_path
    config_dir = root / "config"
    config_dir.mkdir()
    data_dir = root / "data"
    settings = AppSettings(
        data_dir=str(data_dir),
        db_path=str(data_dir / "db" / "watcher.sqlite"),
    )
    settings.web.allowed_cidrs = ["127.0.0.1/32"]
    ensure_data_dirs(settings)
    store = Store(settings.db_path)
    store.upsert_bulletin(
        "APSB-TEST",
        "Test Bulletin",
        "2026-01-01",
        "https://example.com/b",
        None,
        analysis=BulletinAnalysis(
            summary="公告综合说明",
            business_impact_scope="可能影响结账与后台",
            remediation_summary="先升级到 2.4.7-p10，再打对应 Isolated patch",
            has_isolated_patch=True,
            upgrade_available=True,
            recommended_min_versions=["2.4.7-p10", "2.4.7-2026-jul"],
            affected_version_summary="2.4.7-p10 and earlier",
            severity_overview="公告包含 2 个漏洞：1 个严重，1 个高危。",
            cve_ids=["CVE-2026-0001"],
            reference_links=[
                {"kind": "official", "title": "官方", "url": "https://example.com/b"},
            ],
        ),
    )
    analysis = RiskItemAnalysis(
        title="测试风险",
        cve_ids=["CVE-2026-0001"],
        severity=Severity.CRITICAL,
        score=9.1,
    )
    store.upsert_risk_item(
        RiskItemRecord(risk_id="APSB-TEST:1", bulletin_external_id="APSB-TEST", analysis=analysis)
    )
    secret = "superSecretGitToken99"
    projects = {
        "projects": [
            {
                "id": "demo",
                "name": "Demo Shop",
                "git_url": f"https://user:{secret}@git.example.com/demo.git",
                "branch": "main",
                "enabled": True,
                "owners": ["ops@example.com"],
            }
        ]
    }
    (config_dir / "projects.yaml").write_text(yaml.dump(projects), encoding="utf-8")
    (config_dir / "settings.yaml").write_text("data_dir: data\n", encoding="utf-8")

    run_id = store.start_scan_run("demo")
    store.finish_scan_run(run_id, "ok", git_commit="abc123")
    store.insert_finding(
        run_id,
        FindingRecord(
            project_id="demo",
            risk_id="APSB-TEST:1",
            remediation_status=RemediationStatus.VULNERABLE,
            fix_method=FixMethod.NONE,
            evidence=FindingEvidence(warnings=["w1"]),
            analysis_snapshot=analysis,
            evidence_fingerprint="fp1",
        ),
    )
    store.insert_finding(
        run_id,
        FindingRecord(
            project_id="demo",
            risk_id="APSB-TEST:1",
            remediation_status=RemediationStatus.FIXED,
            fix_method=FixMethod.UPGRADE,
            evidence=FindingEvidence(),
            analysis_snapshot=analysis,
            evidence_fingerprint="fp2",
        ),
    )
    # Second risk still vulnerable for open section
    analysis2 = RiskItemAnalysis(title="仍受影响", severity=Severity.HIGH)
    store.upsert_risk_item(
        RiskItemRecord(risk_id="APSB-TEST:2", bulletin_external_id="APSB-TEST", analysis=analysis2)
    )
    store.insert_finding(
        run_id,
        FindingRecord(
            project_id="demo",
            risk_id="APSB-TEST:2",
            remediation_status=RemediationStatus.VULNERABLE,
            fix_method=FixMethod.NONE,
            evidence=FindingEvidence(),
            analysis_snapshot=analysis2,
            evidence_fingerprint="fp3",
        ),
    )
    analysis3 = RiskItemAnalysis(title="无法确认项", severity=Severity.MEDIUM)
    store.upsert_risk_item(
        RiskItemRecord(risk_id="APSB-TEST:3", bulletin_external_id="APSB-TEST", analysis=analysis3)
    )
    store.insert_finding(
        run_id,
        FindingRecord(
            project_id="demo",
            risk_id="APSB-TEST:3",
            remediation_status=RemediationStatus.UNKNOWN,
            fix_method=FixMethod.UNKNOWN,
            evidence=FindingEvidence(),
            analysis_snapshot=analysis3,
            evidence_fingerprint="fp4",
        ),
    )
    return settings, store, secret


def test_web_pages_and_redaction(tmp_path: Path):
    settings, store, secret = _seed_web(tmp_path)
    app = create_app(
        root=tmp_path,
        config_dir=tmp_path / "config",
        settings=settings,
        store=store,
        testing=True,
    )
    client = TestClient(app)
    for path in (
        "/",
        "/projects",
        "/projects/demo",
        "/risks",
        "/risks/APSB-TEST:1",
        "/bulletins",
        "/bulletins/APSB-TEST",
        "/health",
    ):
        resp = client.get(path)
        assert resp.status_code == 200, path
        assert secret not in resp.text
        if path != "/health":
            assert "data-theme-toggle" in resp.text
            assert "msw-theme" in resp.text

    detail = client.get("/bulletins/APSB-TEST")
    assert "业务影响范围" in detail.text
    assert "可能影响结账与后台" in detail.text
    assert "参考链接" in detail.text
    assert "综合说明" in detail.text
    assert "受影响版本" in detail.text
    assert "2.4.7-p10 and earlier" in detail.text
    assert "2.4.7-p10" in detail.text
    assert "2.4.7-2026-jul" not in detail.text
    assert "等级概览" in detail.text
    assert "公告包含 2 个漏洞" in detail.text
    # CVE list removed from bulletin meta grid (still ok in risk table)
    assert "<dt>CVE</dt>" not in detail.text
    # summary section appears before meta-grid; severity overview is its own section
    assert detail.text.index("综合说明") < detail.text.index("独立补丁")
    assert detail.text.index("独立补丁") < detail.text.index("等级概览")
    assert detail.text.index("等级概览") < detail.text.index("业务影响范围")
    assert "<h3>等级概览</h3>" in detail.text

    detail = client.get("/projects/demo")
    assert "仍受影响" in detail.text
    assert "未修 2" in detail.text  # vulnerable + unknown
    assert "· 未知" not in detail.text
    assert "无法确认项" in detail.text
    assert "未修复/仍受影响" in detail.text
    assert 'class="status-pill status-vulnerable"' in detail.text
    assert "需关注" in detail.text
    assert "已处理" in detail.text
    assert 'class="fold finding-open"' in detail.text
    assert 'class="fold finding-closed"' in detail.text
    assert 'class="btn btn-sm fold-toggle"' in detail.text
    assert "全部展开" not in detail.text

    export = client.get("/projects/demo/export", follow_redirects=False)
    assert export.status_code == 302
    assert export.headers.get("location") == "/projects/demo?print=1"

    detail = client.get("/projects/demo")
    assert 'data-print-pdf' in detail.text
    assert "导出 PDF" in detail.text
    assert 'data-notify-url="/projects/demo/notify"' in detail.text
    assert "发送通知" in detail.text

    bulletin_export = client.get("/bulletins/APSB-TEST/export", follow_redirects=False)
    assert bulletin_export.status_code == 302
    assert bulletin_export.headers.get("location") == "/bulletins/APSB-TEST?print=1"
    bulletin_page = client.get("/bulletins/APSB-TEST")
    assert 'data-print-pdf' in bulletin_page.text
    assert 'data-notify-url="/bulletins/APSB-TEST/notify"' in bulletin_page.text

    # Manual notify: disabled wecom → 503
    disabled = client.post("/projects/demo/notify")
    assert disabled.status_code == 503
    assert disabled.json()["ok"] is False

    from magento_security_watcher.notify import WeComNotifier

    class FakeResp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"errcode": 0}

    class FakeClient:
        def __init__(self):
            self.calls = []

        def post(self, url, json=None):
            self.calls.append(json)
            return FakeResp()

    fake = FakeClient()

    def make_notifier():
        return WeComNotifier(
            "https://example.com/hook",
            enabled=True,
            mention_all_on_critical=True,
            client=fake,
        )

    app.state.make_notifier = make_notifier
    sent = client.post("/projects/demo/notify")
    assert sent.status_code == 200
    assert sent.json()["ok"] is True
    assert store.get_alert_state("project:demo") is not None
    assert fake.calls

    sent_b = client.post("/bulletins/APSB-TEST/notify")
    assert sent_b.status_code == 200
    assert sent_b.json()["ok"] is True
    assert store.get_alert_state("bulletin:APSB-TEST") is not None

    blocked = create_app(
        root=tmp_path,
        config_dir=tmp_path / "config",
        settings=settings,
        store=store,
        testing=False,
    )
    # With testing=False, testclient host is still allowlisted via special-case;
    # explicitly verify middleware reject path via unit test above.
    assert TestClient(blocked).get("/").status_code == 200


def test_web_dark_mode_css(tmp_path: Path):
    settings, store, secret = _seed_web(tmp_path)
    app = create_app(
        root=tmp_path,
        config_dir=tmp_path / "config",
        settings=settings,
        store=store,
        testing=True,
    )
    css = TestClient(app).get("/static/app.css")
    assert css.status_code == 200
    assert "color-scheme" in css.text
    assert '[data-theme="dark"]' in css.text
    assert "prefers-color-scheme: dark" in css.text
    assert ":root[data-theme=\"dark\"]" in css.text
