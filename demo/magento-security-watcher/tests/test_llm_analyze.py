from pathlib import Path

from magento_security_watcher.i18n_zh import extract_commerce_versions, strip_html
from magento_security_watcher.llm import LlmClient, _parse_json_object
from magento_security_watcher.models import RemediationOffer, RemediationOptions
from magento_security_watcher.sources import options_from_offer, seed_to_analysis


def test_extract_versions():
    text = "Adobe Commerce versions 2.4.9-alpha2, 2.4.8-p2 and earlier"
    assert "2.4.8-p2" in extract_commerce_versions(text)


def test_strip_html():
    assert "hello" in strip_html("<html><body>hello<script>x</script></body></html>")


def test_remediation_options_independent():
    opts = RemediationOptions(
        has_isolated_patch=True,
        upgrade_available=True,
        recommended_min_versions=["2.4.8-p3", "2.4.7-p8"],
    )
    assert opts.to_offer().value == "upgrade_or_patch"
    assert opts.has_isolated_patch and opts.upgrade_available


def test_options_from_legacy_offer():
    assert options_from_offer(RemediationOffer.UPGRADE_ONLY).upgrade_available is True
    assert options_from_offer(RemediationOffer.PATCH_ONLY).has_isolated_patch is True
    both = options_from_offer(RemediationOffer.UPGRADE_OR_PATCH)
    assert both.has_isolated_patch and both.upgrade_available


def test_seed_maps_offer_to_options():
    analysis = seed_to_analysis(
        {
            "title": "t",
            "cve_ids": ["CVE-1"],
            "remediation_offer": "upgrade_only",
            "packages": [
                {
                    "name": "magento/module-quote",
                    "affected_versions": ">=2.4.0,<2.4.7",
                    "fixed_version": "2.4.7",
                }
            ],
        },
        "bulletin",
    )
    assert analysis.remediation_options.upgrade_available is True
    assert analysis.remediation_offer == RemediationOffer.UPGRADE_ONLY
    assert "2.4.7" in analysis.remediation_options.recommended_min_versions


def test_llm_logs_prompt(tmp_path: Path, caplog):
    class FakeResp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": '{"business_impact":"测","narrative":"述"}'}}]}

    class FakeClient:
        def post(self, *args, **kwargs):
            return FakeResp()

    client = LlmClient(
        api_base="https://example.com/v1",
        api_key="k",
        model="m",
        enabled=True,
        client=FakeClient(),
        log_dir=tmp_path,
    )
    with caplog.at_level("INFO"):
        out = client.analyze_risk_item_zh({"cve_ids": ["CVE-1"]})
    assert out["business_impact"] == "测"
    files = [p for p in tmp_path.glob("*_analyze_risk_zh.txt") if "_response" not in p.name]
    assert len(files) == 1
    text = files[0].read_text(encoding="utf-8")
    assert "=== SYSTEM ===" in text
    assert "=== USER ===" in text
    assert "CVE-1" in text
    assert "=== ASSISTANT ===" in text
    assert "LLM prompt purpose=analyze_risk_zh" in caplog.text


def test_parse_json_object_fenced():
    data = _parse_json_object('```json\n{"a":1}\n```')
    assert data["a"] == 1
