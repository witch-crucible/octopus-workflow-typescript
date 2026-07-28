from __future__ import annotations

from pathlib import Path

from magento_security_watcher.fingerprint import FingerprintBuilder, parse_unified_diff, validate_fingerprints


SAMPLE_PATCH = """diff --git a/vendor/magento/module-customer/Model/AccountManagement.php b/vendor/magento/module-customer/Model/AccountManagement.php
index 111..222 100644
--- a/vendor/magento/module-customer/Model/AccountManagement.php
+++ b/vendor/magento/module-customer/Model/AccountManagement.php
@@ -10,7 +10,7 @@ class AccountManagement
      public function doSomething($user, $request)
      {
-    if ($user->isAllowed()) {
+    if ($user->isAllowed() && $this->csrfValidator->validate($request)) {
          return true;
      }
"""


def test_parse_unified_diff_extracts_before_after():
    fps = parse_unified_diff(SAMPLE_PATCH)
    assert len(fps) >= 1
    fp = fps[0]
    assert fp.path.endswith("AccountManagement.php")
    assert fp.before and "isAllowed()" in fp.before
    assert fp.after and "csrfValidator" in fp.after


def test_validate_rejects_empty():
    from magento_security_watcher.models import ContentFingerprint

    assert validate_fingerprints([ContentFingerprint(path="", before="x", after="y")]) == []
    assert validate_fingerprints([ContentFingerprint(path="a.php", before="", after="")]) == []


def test_builder_rule_only():
    fps = FingerprintBuilder().build(SAMPLE_PATCH, allow_ai_draft=False)
    assert fps
    assert all(fp.path for fp in fps)
