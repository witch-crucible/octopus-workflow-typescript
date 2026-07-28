from __future__ import annotations

import json
from pathlib import Path

import pytest

from magento_security_watcher.inventory import MagentoInventory, merge_installed_for_matching
from magento_security_watcher.magento_version import (
    magento_gte,
    magento_lte,
    parse_magento_version,
    same_release_line,
)
from magento_security_watcher.matcher import match_risk_item, version_fixed, version_in_range
from magento_security_watcher.models import (
    PackageConstraint,
    RemediationOffer,
    RiskItemAnalysis,
    Severity,
)


def _write_composer_json(workspace: Path, data: dict) -> None:
    (workspace / "composer.json").write_text(json.dumps(data), encoding="utf-8")


def _write_composer_lock(workspace: Path, packages: list[dict]) -> None:
    (workspace / "composer.lock").write_text(
        json.dumps({"packages": packages, "packages-dev": []}),
        encoding="utf-8",
    )


def _analysis(*constraints: PackageConstraint) -> RiskItemAnalysis:
    return RiskItemAnalysis(
        title="t",
        severity=Severity.CRITICAL,
        remediation_offer=RemediationOffer.UPGRADE_ONLY,
        packages=list(constraints),
    )


# --- inventory merge ---


def test_merge_uses_composer_json_require(tmp_path: Path):
    _write_composer_json(
        tmp_path,
        {"require": {"magento/product-community-edition": "2.4.7-p8"}},
    )
    installed = merge_installed_for_matching(tmp_path)
    assert installed["magento/product-community-edition"] == "2.4.7-p8"
    inv = MagentoInventory(tmp_path).collect()
    assert inv["product_version"] == "2.4.7-p8"


def test_merge_strips_composer_constraint_operators(tmp_path: Path):
    _write_composer_json(
        tmp_path,
        {"require": {"magento/product-community-edition": "^2.4.7-p8"}},
    )
    installed = merge_installed_for_matching(tmp_path)
    assert installed["magento/product-community-edition"] == "2.4.7-p8"


def test_merge_prefers_lock_over_composer_json(tmp_path: Path):
    _write_composer_json(
        tmp_path,
        {"require": {"magento/product-community-edition": "2.4.7-p8"}},
    )
    _write_composer_lock(
        tmp_path,
        [{"name": "magento/product-community-edition", "version": "2.4.7-p7"}],
    )
    installed = merge_installed_for_matching(tmp_path)
    assert installed["magento/product-community-edition"] == "2.4.7-p7"
    assert MagentoInventory(tmp_path).collect()["product_version"] == "2.4.7-p7"


def test_merge_enterprise_and_aliases_ce(tmp_path: Path):
    _write_composer_json(
        tmp_path,
        {"require": {"magento/product-enterprise-edition": "2.4.6-p3"}},
    )
    installed = merge_installed_for_matching(tmp_path)
    assert installed["magento/product-enterprise-edition"] == "2.4.6-p3"
    # Alias missing CE so bulletin CE constraints can still match.
    assert installed["magento/product-community-edition"] == "2.4.6-p3"


def test_merge_magento2_base_fallback(tmp_path: Path):
    _write_composer_lock(
        tmp_path,
        [{"name": "magento/magento2-base", "version": "2.4.8-p1"}],
    )
    inv = MagentoInventory(tmp_path).collect()
    assert inv["product_version"] == "2.4.8-p1"
    assert inv["packages"]["magento/product-community-edition"] == "2.4.8-p1"


# --- version parse / same-line compare ---


@pytest.mark.parametrize(
    ("left", "right", "expect_lt"),
    [
        ("2.4.7-p7", "2.4.7-p8", True),
        ("2.4.7", "2.4.7-p1", True),
        ("2.4.7-p10", "2.4.7-p2", False),  # numeric patch, not lexicographic
        ("2.4.8-p5", "2.4.8-2026-jul", True),
        ("2.4.8-p6", "2.4.8-p6", False),
    ],
)
def test_parse_order_within_line(left: str, right: str, expect_lt: bool):
    a = parse_magento_version(left)
    b = parse_magento_version(right)
    assert a is not None and b is not None
    assert (a < b) is expect_lt


@pytest.mark.parametrize(
    ("a", "b", "same"),
    [
        ("2.4.7-p8", "2.4.7-p1", True),
        ("2.4.7-p8", "2.4.8-p5", False),
        ("2.4.6-p3", "2.4.7-p7", False),
        ("2.4.8", "2.4.8-2026-jul", True),
    ],
)
def test_same_release_line(a: str, b: str, same: bool):
    assert same_release_line(a, b) is same


@pytest.mark.parametrize(
    ("current", "maximum", "expect"),
    [
        ("2.4.7-p7", "2.4.7-p7", True),
        ("2.4.7-p8", "2.4.7-p7", False),
        ("2.4.7-p6", "2.4.7-p7", True),
        # Cross-line must NOT be treated as "earlier"
        ("2.4.7-p8", "2.4.8-p5", False),
        ("2.4.6-p3", "2.4.7-p7", False),
        ("2.4.8-p5", "2.4.7-p7", False),
    ],
)
def test_magento_lte_line_scoped(current: str, maximum: str, expect: bool):
    assert magento_lte(current, maximum) is expect


@pytest.mark.parametrize(
    ("current", "minimum", "expect"),
    [
        ("2.4.7-p8", "2.4.7-p8", True),
        ("2.4.7-p9", "2.4.7-p8", True),
        ("2.4.7-p7", "2.4.7-p8", False),
        ("2.4.8-p6", "2.4.7-p8", False),  # different line
        ("2.4.8-2026-jul", "2.4.8-p6", True),
    ],
)
def test_magento_gte_line_scoped(current: str, minimum: str, expect: bool):
    assert magento_gte(current, minimum) is expect


@pytest.mark.parametrize(
    ("current", "affected", "expect"),
    [
        ("2.4.7-p7", "<=2.4.7-p7", True),
        ("2.4.7-p8", "<=2.4.7-p7", False),
        ("2.4.7-p8", "<=2.4.8-p5", False),
        ("2.4.8-p5", "<=2.4.8-p5", True),
        ("2.4.8-p6", "<=2.4.8-p5", False),
        ("2.4.7-p7", "<2.4.7-p8", True),
        ("2.4.7-p8", "<2.4.7-p8", False),
        ("2.4.7-p8", "==2.4.7-p8", True),
        ("2.4.7-p7", "==2.4.7-p8", False),
    ],
)
def test_version_in_range_specs(current: str, affected: str, expect: bool):
    assert version_in_range(current, affected) is expect


@pytest.mark.parametrize(
    ("current", "fixed", "expect"),
    [
        ("2.4.7-p8", "2.4.7-p8", True),
        ("2.4.7-p9", "2.4.7-p8", True),
        ("2.4.7-p7", "2.4.7-p8", False),
        ("2.4.8-p6", "2.4.7-p8", True),  # newer Magento line has moved past 2.4.7 fix
        ("2.4.6-p3", "2.4.7-p8", False),  # older line has not met 2.4.7 fix
        ("2.4.8-p6", "2.4.8-p6", True),
        ("2.4.8-2026-jul", "2.4.8-p6", True),
    ],
)
def test_version_fixed_specs(current: str, fixed: str, expect: bool):
    assert version_fixed(current, fixed) is expect


@pytest.mark.parametrize(
    ("installed_ver", "packages", "expect_status"),
    [
        # Classic false positive: title/fix about 2.4.6, project already on 2.4.7
        (
            "2.4.7-p8",
            [("magento/product-community-edition", None, "2.4.6")],
            "not_applicable",
        ),
        (
            "2.4.7-p8",
            [("magento/product-community-edition", "<=2.4.6", "2.4.6")],
            "not_applicable",
        ),
        (
            "2.4.7-p8",
            [("magento/product-community-edition", "<=2.4.6-p15", "2.4.6-p16")],
            "not_applicable",
        ),
        (
            "2.4.7-p8",
            [("magento/product-community-edition", "2.4.6 and earlier", "2.4.6-p1")],
            "not_applicable",
        ),
        (
            "2.4.7-p8",
            [("magento/product-community-edition", "2.4.6", "2.4.6")],
            "not_applicable",
        ),
        (
            "2.4.7-p8",
            [("magento/product-community-edition", ">=2.4.0,<2.4.6", "2.4.6")],
            "not_applicable",
        ),
        (
            "2.4.5-p1",
            [("magento/product-community-edition", ">=2.4.0,<2.4.6", "2.4.6")],
            "vulnerable",
        ),
        (
            "2.4.6",
            [("magento/product-community-edition", ">=2.4.0,<2.4.6", "2.4.6")],
            "fixed",
        ),
    ],
)
def test_246_line_bulletin_vs_247_project(
    tmp_path: Path,
    installed_ver: str,
    packages: list[tuple[str, str | None, str | None]],
    expect_status: str,
):
    analysis = _analysis(
        *[
            PackageConstraint(name=n, affected_versions=a, fixed_version=f)
            for n, a, f in packages
        ]
    )
    finding = match_risk_item(
        project_id="demo",
        workspace=tmp_path,
        installed={"magento/product-community-edition": installed_ver},
        analysis=analysis,
        risk_id="APSB20-02:CVE-2023-29295",
    )
    assert finding.remediation_status.value == expect_status, finding.evidence.version


# --- end-to-end match with inventory-like installed map ---


@pytest.mark.parametrize(
    ("installed_ver", "expect_status"),
    [
        ("2.4.7-p6", "vulnerable"),
        ("2.4.7-p7", "vulnerable"),
        ("2.4.7-p8", "fixed"),
        ("2.4.7-p9", "fixed"),
        ("2.4.8-p5", "vulnerable"),  # hits 2.4.8 line only
        ("2.4.8-p6", "fixed"),
        ("2.4.6-p3", "fixed"),  # meets 2.4.6-p3 fix on its own line
        ("2.4.5-p1", "not_applicable"),  # no matching release line
    ],
)
def test_multi_line_bulletin_match_statuses(tmp_path: Path, installed_ver: str, expect_status: str):
    analysis = _analysis(
        PackageConstraint(
            name="magento/product-community-edition",
            affected_versions="<=2.4.8-p5",
            fixed_version="2.4.8-p6",
        ),
        PackageConstraint(
            name="magento/product-community-edition",
            affected_versions="<=2.4.7-p7",
            fixed_version="2.4.7-p8",
        ),
        PackageConstraint(
            name="magento/product-community-edition",
            affected_versions="<=2.4.6-p2",
            fixed_version="2.4.6-p3",
        ),
    )
    finding = match_risk_item(
        project_id="demo",
        workspace=tmp_path,
        installed={"magento/product-community-edition": installed_ver},
        analysis=analysis,
        risk_id="APSB:CVE",
    )
    assert finding.remediation_status.value == expect_status, finding.evidence.version


def test_scan_path_composer_json_247_p8_is_fixed(tmp_path: Path):
    """Real inventory path: version only in composer.json require."""
    _write_composer_json(
        tmp_path,
        {"require": {"magento/product-community-edition": "2.4.7-p8"}},
    )
    installed = merge_installed_for_matching(tmp_path)
    analysis = _analysis(
        PackageConstraint(
            name="magento/product-community-edition",
            affected_versions="<=2.4.8-p5",
            fixed_version="2.4.8-p6",
        ),
        PackageConstraint(
            name="magento/product-community-edition",
            affected_versions="<=2.4.7-p7",
            fixed_version="2.4.7-p8",
        ),
    )
    finding = match_risk_item(
        project_id="demo",
        workspace=tmp_path,
        installed=installed,
        analysis=analysis,
        risk_id="APSB:CVE",
    )
    assert finding.remediation_status.value == "fixed"
