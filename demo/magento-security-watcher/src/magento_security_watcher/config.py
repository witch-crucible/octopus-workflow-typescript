from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from magento_security_watcher.browser_identity import BROWSER_USER_AGENT
from magento_security_watcher.models import ProjectConfig


class AdvisorySettings(BaseModel):
    # Adobe Magento/Commerce product security index (not Experience League KCS).
    bulletin_list_url: str = "https://helpx.adobe.com/security/products/magento.html"
    fixture_dir: Optional[str] = None
    # Browser-saved HTML of the Magento security index (bypasses CLI network blocks).
    local_index_html: Optional[str] = None
    # Spoof Chrome; paired with browser-like headers in http_fetch.
    user_agent: str = BROWSER_USER_AGENT
    # How many newest Magento APSB detail pages to fetch for CVE enrichment (0 = listing only).
    detail_fetch_limit: int = 15
    request_timeout_seconds: float = 45.0
    # When bulletin page cannot prove isolated patches, follow Installation Instructions / Release Notes.
    follow_release_notes: bool = True
    kb_fetch_limit_per_bulletin: int = 2
    # Download Magento isolated-patch ZIPs during ingest to build content fingerprints.
    download_isolated_patch_zips: bool = True
    patch_zip_download_limit: int = 4


class NvdSettings(BaseModel):
    enabled: bool = True
    api_base: str = "https://services.nvd.nist.gov/rest/json/cves/2.0"
    # Without NVD_API_KEY, NIST recommends ~6s between requests.
    request_delay_seconds: float = 6.0
    # Disk cache under data/cache/nvd; same CVE is not re-fetched within TTL.
    cache_ttl_days: float = 30.0
    # On HTTP 429, reuse expired cache if present (better than empty enrichment).
    use_stale_on_rate_limit: bool = True


class LlmSettings(BaseModel):
    enabled: bool = False
    api_base: str = "https://api.openai.com/v1"
    model: str = "gpt-4o-mini"
    timeout_seconds: float = 120.0
    # Relative to data_dir unless absolute
    log_dir: Optional[str] = "data/logs/llm"


class WecomSettings(BaseModel):
    enabled: bool = False
    mention_all_on_critical: bool = False


class GitSettings(BaseModel):
    mirrors_dir: str = "data/mirrors"
    concurrency: int = 1
    fetch_timeout_seconds: int = 600


class ScanSettings(BaseModel):
    notify_on_complete: bool = False


class WebSettings(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8080
    # Empty → only loopback (see IP whitelist middleware).
    allowed_cidrs: List[str] = Field(default_factory=list)
    trust_x_forwarded_for: bool = False


class AppSettings(BaseModel):
    data_dir: str = "data"
    db_path: str = "data/db/watcher.sqlite"
    advisory: AdvisorySettings = Field(default_factory=AdvisorySettings)
    nvd: NvdSettings = Field(default_factory=NvdSettings)
    llm: LlmSettings = Field(default_factory=LlmSettings)
    wecom: WecomSettings = Field(default_factory=WecomSettings)
    git: GitSettings = Field(default_factory=GitSettings)
    scan: ScanSettings = Field(default_factory=ScanSettings)
    web: WebSettings = Field(default_factory=WebSettings)

    def resolve(self, root: Path) -> "AppSettings":
        """Resolve relative paths against project root."""
        data = self.model_copy(deep=True)
        data.data_dir = str((root / data.data_dir).resolve()) if not Path(data.data_dir).is_absolute() else data.data_dir
        data.db_path = str((root / data.db_path).resolve()) if not Path(data.db_path).is_absolute() else data.db_path
        mirrors = data.git.mirrors_dir
        data.git.mirrors_dir = (
            str((root / mirrors).resolve()) if not Path(mirrors).is_absolute() else mirrors
        )
        if data.advisory.fixture_dir and not Path(data.advisory.fixture_dir).is_absolute():
            data.advisory.fixture_dir = str((root / data.advisory.fixture_dir).resolve())
        if data.advisory.local_index_html and not Path(data.advisory.local_index_html).is_absolute():
            data.advisory.local_index_html = str((root / data.advisory.local_index_html).resolve())
        return data


class EnvSecrets(BaseSettings):
    """Secrets from process env and/or project-root ``.env`` (never commit .env)."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    openai_api_key: Optional[str] = None
    msw_llm_api_key: Optional[str] = None
    nvd_api_key: Optional[str] = None
    wecom_webhook_url: Optional[str] = None
    # Magento repo keys (HTTP basic) for repo.magento.com/patch/auth/*.zip
    magento_repo_public_key: Optional[str] = None
    magento_repo_private_key: Optional[str] = None

    @property
    def llm_api_key(self) -> Optional[str]:
        return self.msw_llm_api_key or self.openai_api_key


def load_env_secrets(root: Optional[Path] = None) -> EnvSecrets:
    """Load secrets from ``<root>/.env`` (and real environment variables)."""
    root = (root or default_root()).resolve()
    env_file = root / ".env"
    # pydantic-settings accepts _env_file even when the path is missing.
    return EnvSecrets(_env_file=env_file)  # type: ignore[call-arg]


def load_yaml(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError(f"YAML root must be a mapping: {path}")
    return data


def load_settings(config_dir: Path, root: Optional[Path] = None) -> AppSettings:
    root = root or config_dir.parent
    settings_path = config_dir / "settings.yaml"
    raw = load_yaml(settings_path)
    settings = AppSettings.model_validate(raw)
    return settings.resolve(root)


def load_projects(config_dir: Path) -> List[ProjectConfig]:
    path = config_dir / "projects.yaml"
    raw = load_yaml(path)
    items = raw.get("projects") or []
    return [ProjectConfig.model_validate(item) for item in items]


def ensure_data_dirs(settings: AppSettings) -> Dict[str, Path]:
    base = Path(settings.data_dir)
    if settings.llm.log_dir:
        lp = Path(settings.llm.log_dir)
        if lp.is_absolute():
            log_path = lp
        else:
            # Relative to data_dir; strip leading data_dir segment if present
            # (e.g. "data/logs/llm" or "logs/llm" → <data_dir>/logs/llm).
            parts = lp.parts
            if parts and parts[0] == Path(settings.data_dir).name:
                log_path = base.joinpath(*parts[1:]) if len(parts) > 1 else (base / "logs" / "llm")
            else:
                log_path = base / lp
    else:
        log_path = base / "logs" / "llm"
    paths = {
        "data": base,
        "db": Path(settings.db_path).parent,
        "mirrors": Path(settings.git.mirrors_dir),
        "cache": base / "cache" / "advisories",
        "nvd_cache": base / "cache" / "nvd",
        "patch_cache": base / "cache" / "patches",
        "fingerprints": base / "fingerprints",
        "reports_risk": base / "reports" / "risk_items",
        "reports_projects": base / "reports" / "projects",
        "reports_bulletins": base / "reports" / "bulletins",
        "llm_logs": log_path,
    }
    for p in paths.values():
        p.mkdir(parents=True, exist_ok=True)
    return paths


def default_root() -> Path:
    env = os.environ.get("MSW_ROOT")
    if env:
        return Path(env).resolve()
    return Path.cwd().resolve()
