from pathlib import Path

from magento_security_watcher.i18n_zh import (
    display_risk_title,
    is_code_style_risk_title,
    is_generic_product_title,
    zh_risk_title,
    zh_vuln_type_title,
)
from magento_security_watcher.sources import _apply_cve_details_from_table, extract_vuln_detail_by_cve
from magento_security_watcher.web.presenters import risk_row_view


def test_code_style_detection():
    assert is_code_style_risk_title("APSB25-94 CVE-2025-54264")
    assert is_code_style_risk_title("APSB25-94:CVE-2025-54264")
    assert not is_code_style_risk_title("存储型 XSS")


def test_generic_product_title():
    assert is_generic_product_title("Magento 安全更新")
    assert is_generic_product_title("Adobe Commerce / Magento 安全更新")
    assert not is_generic_product_title("存储型 XSS")
    assert not is_generic_product_title("错误授权")


def test_zh_vuln_type_from_adobe_category():
    assert zh_vuln_type_title("Cross-site Scripting (Stored XSS) (CWE-79)") == "存储型 XSS"
    assert zh_vuln_type_title("Server-Side Request Forgery (SSRF) (CWE-918)") == "服务端请求伪造 (SSRF)"
    assert zh_vuln_type_title("Incorrect Authorization (CWE-863)") == "错误授权"
    assert zh_vuln_type_title("CWE-79") == "跨站脚本 (XSS)"
    assert zh_vuln_type_title("CWE-434", "Privilege escalation") == "任意文件上传"


def test_zh_risk_title_prefers_vuln_type():
    title = zh_risk_title(
        bulletin_id="APSB26-05",
        cve_id="CVE-2026-21361",
        page_title="Security updates available for Adobe Commerce | Adobe",
        vuln_category="Cross-site Scripting (Stored XSS) (CWE-79)",
    )
    assert title == "存储型 XSS"


def test_zh_risk_title_fallback_when_no_category():
    title = zh_risk_title(
        bulletin_id="APSB25-94",
        cve_id="CVE-2025-54264",
        page_title="Security updates available for Adobe Commerce | Adobe",
    )
    assert title == "未分类漏洞"


def test_display_rewrites_legacy_code_title():
    out = display_risk_title(
        "APSB26-73 CVE-2026-48371",
        risk_id="APSB26-73:CVE-2026-48371",
        cve_ids=["CVE-2026-48371"],
        bulletin_id="APSB26-73",
    )
    assert out == "未分类漏洞"


def test_display_rewrites_generic_product_title():
    out = display_risk_title(
        "Adobe Commerce / Magento 安全更新（CVE-2026-48371）",
        risk_id="APSB26-73:CVE-2026-48371",
    )
    assert out == "未分类漏洞"


def test_display_maps_english_category_title():
    out = display_risk_title(
        "Cross-site Scripting (Stored XSS) (CWE-79)",
        risk_id="APSB26-05:CVE-2026-21361",
    )
    assert out == "存储型 XSS"


def test_display_keeps_vuln_style():
    raw = "存储型 XSS"
    assert display_risk_title(raw, risk_id="APSB25-71:CVE-2023-29298") == raw


def test_extract_and_apply_vuln_details_from_fixture():
    html = Path("tests/fixtures/advisories/apsb26-73-snippet.html").read_text(encoding="utf-8")
    details = extract_vuln_detail_by_cve(html)
    assert details["CVE-2026-47995"]["severity"] == "critical"
    assert "Stored XSS" in details["CVE-2026-47995"]["category"]

    seeds = [
        {"title": "Magento 安全更新", "cve_ids": ["CVE-2026-48356"], "severity": "unknown"},
        {"title": "Magento 安全更新", "cve_ids": ["CVE-2026-47995"], "severity": "unknown"},
    ]
    _apply_cve_details_from_table(seeds, html)
    assert seeds[0]["title"] == "任意文件上传"
    assert seeds[1]["title"] == "存储型 XSS"
    assert seeds[0]["severity"] == "critical"


def test_risk_row_view_rewrites_generic_and_shows_id():
    row = {
        "risk_id": "APSB25-94:CVE-2025-54264",
        "bulletin_external_id": "APSB25-94",
        "analysis_json": (
            '{"title":"Magento 安全更新","cve_ids":["CVE-2025-54264"],'
            '"severity":"high","remediation_offer":"unknown",'
            '"remediation_options":{"has_isolated_patch":false,"upgrade_available":false,'
            '"recommended_min_versions":[],"notes":null},'
            '"packages":[],"fingerprints":[],"materials":[],"confidence":0.3,'
            '"source_missing":[],"raw":{}}'
        ),
        "created_at": "2026-07-22T00:00:00",
        "updated_at": "2026-07-22T00:00:00",
    }
    view = risk_row_view(row)
    assert view["title"] == "未分类漏洞"
    assert view["show_risk_id"] is True


def test_risk_row_view_uses_stored_vuln_title():
    row = {
        "risk_id": "APSB26-05:CVE-2026-21361",
        "bulletin_external_id": "APSB26-05",
        "analysis_json": (
            '{"title":"存储型 XSS","cve_ids":["CVE-2026-21361"],'
            '"severity":"critical","remediation_offer":"upgrade_only",'
            '"remediation_options":{"has_isolated_patch":false,"upgrade_available":true,'
            '"recommended_min_versions":["2.4.7-p9"],"notes":null},'
            '"packages":[],"fingerprints":[],"materials":[],"confidence":0.8,'
            '"source_missing":[],"raw":{"vuln_category":"Cross-site Scripting (Stored XSS) (CWE-79)"}}'
        ),
        "created_at": "2026-07-22T00:00:00",
        "updated_at": "2026-07-22T00:00:00",
    }
    view = risk_row_view(row)
    assert view["title"] == "存储型 XSS"
