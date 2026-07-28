from __future__ import annotations

import io
import zipfile
from pathlib import Path

from magento_security_watcher.adobe_bulletin import (
    attach_bulletin_packages_to_seeds,
    attach_patch_signals_to_seeds,
    detect_isolated_patch_signals,
    extract_release_note_urls,
    merge_patch_signals,
)
from magento_security_watcher.patch_artifacts import (
    extract_patch_texts_from_zip,
    prefer_zip_urls,
)


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "advisories"
BULLETIN = (FIXTURE_DIR / "apsb26-73-snippet.html").read_text(encoding="utf-8")
KB = (FIXTURE_DIR / "ka-37421-snippet.html").read_text(encoding="utf-8")


def test_apsb26_73_bulletin_alone_needs_release_notes():
    """Bulletin has Release Notes link but no zip — not enough to prove patch."""
    urls = extract_release_note_urls(BULLETIN)
    assert any("ka-37421" in u for u in urls)
    sig = detect_isolated_patch_signals(BULLETIN)
    assert sig["has_isolated_patch"] is False
    assert sig["patch_zip_urls"] == []


def test_ka_37421_proves_isolated_patch_via_zip():
    sig = detect_isolated_patch_signals(KB)
    assert sig["has_isolated_patch"] is True
    assert any("2-4-8-p5-jul-2026.zip" in u for u in sig["patch_zip_urls"])
    assert "patch_zip" in sig["reasons"]


def test_merge_bulletin_then_kb_like_ingest():
    seeds = [
        {"title": "APSB26-73 CVE-2026-48356", "cve_ids": ["CVE-2026-48356"], "severity": "critical"}
    ]
    seeds = attach_bulletin_packages_to_seeds(seeds, BULLETIN)
    assert seeds[0].get("upgrade_available") is True
    assert seeds[0].get("has_isolated_patch") is not True

    merged = merge_patch_signals(
        detect_isolated_patch_signals(BULLETIN),
        detect_isolated_patch_signals(KB),
    )
    seeds = attach_patch_signals_to_seeds(seeds, merged, kb_urls=["https://example/ka-37421"])
    assert seeds[0]["has_isolated_patch"] is True
    assert seeds[0]["remediation_offer"] == "upgrade_or_patch"
    assert seeds[0]["patch_zip_urls"]
    assert seeds[0]["patch_kb_urls"]


def test_prefer_public_zips_before_auth():
    urls = [
        "https://repo.magento.com/patch/auth/2-4-5-p17-jul-2026.zip",
        "https://repo.magento.com/patch/2-4-8-p5-jul-2026.zip",
    ]
    ordered = prefer_zip_urls(urls, limit=2)
    assert "/auth/" not in ordered[0]
    assert ordered[1].endswith("2-4-5-p17-jul-2026.zip")


def test_extract_patch_texts_from_zip(tmp_path: Path):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "CE/fix.patch",
            "diff --git a/app/code/X.php b/app/code/X.php\n"
            "--- a/app/code/X.php\n"
            "+++ b/app/code/X.php\n"
            "@@ -1,1 +1,1 @@\n"
            "-vulnerable();\n"
            "+fixed();\n",
        )
        zf.writestr("readme.txt", "not a patch")
    zip_path = tmp_path / "p.zip"
    zip_path.write_bytes(buf.getvalue())
    members = extract_patch_texts_from_zip(zip_path)
    assert len(members) == 1
    assert "vulnerable()" in members[0][1]
