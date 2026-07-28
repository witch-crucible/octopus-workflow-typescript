from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from urllib.parse import urlparse, urlunparse

logger = logging.getLogger(__name__)


class GitWorkspaceError(RuntimeError):
    pass


def _redact_git_args(args: list[str]) -> list[str]:
    """Avoid logging credentials embedded in git URLs."""
    out: list[str] = []
    for a in args:
        if "://" in a and "@" in a:
            try:
                p = urlparse(a)
                if p.username or p.password:
                    host = p.hostname or "unknown"
                    port = f":{p.port}" if p.port else ""
                    netloc = f"***@{host}{port}"
                    out.append(urlunparse((p.scheme, netloc, p.path, "", p.query, "")))
                    continue
            except Exception:  # noqa: BLE001
                out.append("***")
                continue
        out.append(a)
    return out


class GitWorkspace:
    def __init__(self, mirrors_dir: Path, timeout: int = 600) -> None:
        self.mirrors_dir = mirrors_dir
        self.mirrors_dir.mkdir(parents=True, exist_ok=True)
        self.timeout = timeout

    def project_dir(self, project_id: str) -> Path:
        return self.mirrors_dir / project_id

    def sync(self, project_id: str, git_url: str, branch: str) -> tuple[Path, str]:
        """Fetch remote and checkout branch into a working tree. Returns (path, commit_sha)."""
        path = self.project_dir(project_id)
        if not (path / ".git").exists():
            logger.info("git clone project=%s branch=%s → %s", project_id, branch, path)
            self._run(["git", "clone", "--branch", branch, "--single-branch", git_url, str(path)])
        else:
            logger.info("git fetch/reset project=%s branch=%s path=%s", project_id, branch, path)
            self._run(["git", "remote", "set-url", "origin", git_url], cwd=path)
            self._run(["git", "fetch", "origin", branch], cwd=path)
            self._run(["git", "checkout", "-B", branch, f"origin/{branch}"], cwd=path)
            self._run(["git", "reset", "--hard", f"origin/{branch}"], cwd=path)
            self._run(["git", "clean", "-fd"], cwd=path)

        commit = self._run(["git", "rev-parse", "HEAD"], cwd=path).stdout.strip()
        logger.debug("git sync done project=%s commit=%s", project_id, commit)
        return path, commit

    def _run(
        self,
        args: list[str],
        cwd: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        safe = _redact_git_args(args)
        logger.debug("git run: %s (cwd=%s)", " ".join(safe), cwd)
        try:
            proc = subprocess.run(
                args,
                cwd=str(cwd) if cwd else None,
                capture_output=True,
                text=True,
                timeout=self.timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise GitWorkspaceError(f"git timeout: {' '.join(safe)}") from exc
        if proc.returncode != 0:
            err = (proc.stderr or "").strip()
            logger.error("git failed rc=%s cmd=%s stderr=%s", proc.returncode, " ".join(safe), err)
            raise GitWorkspaceError(
                f"git failed ({proc.returncode}): {' '.join(safe)}\n{err}"
            )
        return proc
