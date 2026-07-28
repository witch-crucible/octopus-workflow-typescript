"""Read-only FastAPI dashboard (Scheme 2 web UI)."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from magento_security_watcher.config import (
    AppSettings,
    ensure_data_dirs,
    load_env_secrets,
    load_settings,
)
from magento_security_watcher.notify import WeComNotifier
from magento_security_watcher.store import Store
from magento_security_watcher.web.middleware import IPAllowlistMiddleware
from magento_security_watcher.web.views import router


PACKAGE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = PACKAGE_DIR / "templates"
STATIC_DIR = PACKAGE_DIR / "static"


def create_app(
    root: Optional[Path] = None,
    config_dir: Optional[Path] = None,
    *,
    settings: Optional[AppSettings] = None,
    store: Optional[Store] = None,
    testing: bool = False,
) -> FastAPI:
    """
    Build the read-only web dashboard.

    Does not mount POST /ingest or /scan (ops stay on CLI).
    POST /projects|bulletins/.../notify is allowed for manual WeCom push.
    IP allowlist applies to all routes including /health.
    """
    root = (root or Path.cwd()).resolve()
    config_dir = (config_dir or (root / "config")).resolve()
    if settings is None:
        settings = load_settings(config_dir, root)
    paths = ensure_data_dirs(settings)
    if store is None:
        store = Store(settings.db_path)

    app = FastAPI(
        title="Magento Security Watcher",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
    )
    app.state.root = root
    app.state.config_dir = config_dir
    app.state.settings = settings
    app.state.store = store
    app.state.paths = paths
    app.state.reports_root = paths["data"] / "reports"
    app.state.templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

    def make_notifier() -> WeComNotifier:
        secrets = load_env_secrets(root)
        return WeComNotifier(
            secrets.wecom_webhook_url,
            enabled=settings.wecom.enabled,
            mention_all_on_critical=settings.wecom.mention_all_on_critical,
        )

    app.state.make_notifier = make_notifier

    web = settings.web
    app.add_middleware(
        IPAllowlistMiddleware,
        allowed_cidrs=web.allowed_cidrs,
        trust_x_forwarded_for=web.trust_x_forwarded_for,
        bypass=testing,
    )

    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
    app.include_router(router)
    return app
