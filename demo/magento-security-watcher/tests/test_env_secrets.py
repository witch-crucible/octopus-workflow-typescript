from pathlib import Path

from magento_security_watcher.config import load_env_secrets


def test_load_env_secrets_from_project_root(tmp_path: Path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(
        "WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test\n"
        "MSW_LLM_API_KEY=sk-test\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("WECOM_WEBHOOK_URL", raising=False)
    monkeypatch.delenv("MSW_LLM_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    secrets = load_env_secrets(tmp_path)
    assert secrets.wecom_webhook_url and secrets.wecom_webhook_url.endswith("key=test")
    assert secrets.llm_api_key == "sk-test"
