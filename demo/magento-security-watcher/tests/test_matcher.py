from __future__ import annotations

from pathlib import Path

from magento_security_watcher.matcher import match_content_hunk, match_risk_item
from magento_security_watcher.models import (
    ContentFingerprint,
    PackageConstraint,
    RemediationOffer,
    RiskItemAnalysis,
    Severity,
)


def test_content_hunk_fixed(tmp_path: Path):
    rel = Path("vendor/magento/module-customer/Model/AccountManagement.php")
    target = tmp_path / rel
    target.parent.mkdir(parents=True)
    target.write_text(
        "if ($user->isAllowed() && $this->csrfValidator->validate($request)) {\n",
        encoding="utf-8",
    )
    fp = ContentFingerprint(
        path=str(rel),
        before="if ($user->isAllowed()) {",
        after="if ($user->isAllowed() && $this->csrfValidator->validate($request)) {",
    )
    verdict = match_content_hunk(tmp_path, fp)
    assert verdict.result == "fixed"


def test_content_hunk_vulnerable(tmp_path: Path):
    rel = Path("vendor/magento/module-customer/Model/AccountManagement.php")
    target = tmp_path / rel
    target.parent.mkdir(parents=True)
    target.write_text("if ($user->isAllowed()) {\n", encoding="utf-8")
    fp = ContentFingerprint(
        path=str(rel),
        before="if ($user->isAllowed()) {",
        after="if ($user->isAllowed() && $this->csrfValidator->validate($request)) {",
    )
    assert match_content_hunk(tmp_path, fp).result == "vulnerable"


def test_match_risk_upgrade_fixed(tmp_path: Path):
    analysis = RiskItemAnalysis(
        title="t",
        severity=Severity.HIGH,
        remediation_offer=RemediationOffer.UPGRADE_OR_PATCH,
        packages=[
            PackageConstraint(
                name="magento/module-customer",
                affected_versions=">=2.4.0,<2.4.6",
                fixed_version="2.4.6",
            )
        ],
    )
    finding = match_risk_item(
        project_id="demo",
        workspace=tmp_path,
        installed={"magento/module-customer": "2.4.6"},
        analysis=analysis,
        risk_id="APSB99-01:CVE-2026-10001",
    )
    assert finding.remediation_status.value == "fixed"
    assert finding.fix_method.value == "upgrade"


def test_match_risk_patch_content(tmp_path: Path):
    rel = Path("vendor/magento/module-customer/Model/AccountManagement.php")
    target = tmp_path / rel
    target.parent.mkdir(parents=True)
    after = "if ($user->isAllowed() && $this->csrfValidator->validate($request)) {"
    target.write_text(after + "\n", encoding="utf-8")
    analysis = RiskItemAnalysis(
        title="t",
        severity=Severity.HIGH,
        remediation_offer=RemediationOffer.UPGRADE_OR_PATCH,
        packages=[
            PackageConstraint(
                name="magento/module-customer",
                affected_versions=">=2.4.0,<2.4.6",
                fixed_version="2.4.6",
            )
        ],
        fingerprints=[
            ContentFingerprint(
                path=str(rel),
                before="if ($user->isAllowed()) {",
                after=after,
            )
        ],
    )
    finding = match_risk_item(
        project_id="demo",
        workspace=tmp_path,
        installed={"magento/module-customer": "2.4.5"},
        analysis=analysis,
        risk_id="r1",
    )
    assert finding.remediation_status.value == "fixed"
    assert finding.fix_method.value == "patch_content"


def test_match_not_applicable(tmp_path: Path):
    analysis = RiskItemAnalysis(
        title="t",
        remediation_offer=RemediationOffer.UPGRADE_ONLY,
        packages=[
            PackageConstraint(
                name="magento/module-customer",
                affected_versions=">=2.4.0,<2.4.6",
                fixed_version="2.4.6",
            )
        ],
    )
    finding = match_risk_item(
        project_id="demo",
        workspace=tmp_path,
        installed={"magento/module-customer": "2.3.0"},
        analysis=analysis,
        risk_id="r2",
    )
    assert finding.remediation_status.value == "not_applicable"
