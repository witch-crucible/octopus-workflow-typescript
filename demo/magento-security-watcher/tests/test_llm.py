from __future__ import annotations

from magento_security_watcher.llm import LlmClient, _parse_fingerprint_json, _parse_json_list


def test_parse_json_list_fenced():
    text = """```json
[{"title": "x", "cve_ids": ["CVE-1"]}]
```"""
    items = _parse_json_list(text)
    assert items[0]["title"] == "x"


def test_parse_fingerprint_json():
    text = '[{"path": "a.php", "before": "old_code_here", "after": "new_code_here", "critical": true}]'
    fps = _parse_fingerprint_json(text)
    assert len(fps) == 1
    assert fps[0].path == "a.php"


def test_llm_disabled_returns_none():
    client = LlmClient(api_base="http://example.com/v1", api_key=None, model="x", enabled=True)
    assert client.enabled is False
    assert client.chat("s", "u") is None
    assert client.draft_fingerprints("diff") == []
