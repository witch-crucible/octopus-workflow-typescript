"""Legacy HTTP shell — dashboard lives in web.create_app; ops stay on CLI."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from magento_security_watcher.config import ensure_data_dirs, load_env_secrets, load_projects, load_settings
from magento_security_watcher.ingest import IngestService
from magento_security_watcher.scan import ScanService
from magento_security_watcher.store import Store


@dataclass
class WatcherApp:
    """Application facade usable by CLI or optional ops tooling."""

    root: Path
    config_dir: Path

    def settings(self):
        return load_settings(self.config_dir, self.root)

    def store(self) -> Store:
        return Store(self.settings().db_path)

    def ingest(self, *, notify_new: bool = False) -> dict[str, Any]:
        settings = self.settings()
        paths = ensure_data_dirs(settings)
        return IngestService(
            settings, Store(settings.db_path), paths, load_env_secrets(self.root)
        ).run(notify_new=notify_new)

    def scan(self, *, notify: bool = False, project_ids: Optional[list[str]] = None) -> dict[str, Any]:
        settings = self.settings()
        projects = load_projects(self.config_dir)
        if project_ids:
            wanted = set(project_ids)
            projects = [p for p in projects if p.id in wanted]
        service = ScanService(
            settings,
            Store(settings.db_path),
            ensure_data_dirs(settings),
            load_env_secrets(self.root),
        )
        return service.scan_projects(projects, notify=notify)

    def status(self) -> dict[str, Any]:
        return self.store().summary()


def create_fastapi_app(root: Path | None = None, config_dir: Path | None = None):
    """
    Read-only dashboard factory (no POST ingest/scan).

    Example:
        uvicorn magento_security_watcher.api:create_fastapi_app --factory
        # or: msw serve
    """
    from magento_security_watcher.web.app import create_app

    return create_app(root=root, config_dir=config_dir)
