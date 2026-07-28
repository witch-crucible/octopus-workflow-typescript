from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from magento_security_watcher.models import (
    BulletinAnalysis,
    FindingRecord,
    RiskItemAnalysis,
    RiskItemRecord,
)


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


_APSB_ID_RE = re.compile(r"APSB(\d{2})-(\d+)", re.IGNORECASE)


def _risk_official_sort_key(row: dict[str, Any]) -> tuple:
    """Newest Adobe bulletin first: APSB YY-NN, then published_at, then risk_id."""
    pub = (row.get("bulletin_published_at") or "").strip()
    bulletin = row.get("bulletin_external_id") or ""
    m = _APSB_ID_RE.search(bulletin) or _APSB_ID_RE.search(row.get("risk_id") or "")
    year = int(m.group(1)) if m else -1
    seq = int(m.group(2)) if m else -1
    has_pub = 1 if pub else 0
    return (year, seq, has_pub, pub, row.get("risk_id") or "")


class Store:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS bulletins (
                    external_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    published_at TEXT,
                    url TEXT,
                    raw_text TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS risk_items (
                    risk_id TEXT PRIMARY KEY,
                    bulletin_external_id TEXT NOT NULL,
                    analysis_json TEXT NOT NULL,
                    report_path TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (bulletin_external_id) REFERENCES bulletins(external_id)
                );

                CREATE TABLE IF NOT EXISTS scan_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    git_commit TEXT,
                    status TEXT NOT NULL,
                    error TEXT
                );

                CREATE TABLE IF NOT EXISTS findings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scan_run_id INTEGER,
                    project_id TEXT NOT NULL,
                    risk_id TEXT NOT NULL,
                    remediation_status TEXT NOT NULL,
                    fix_method TEXT NOT NULL,
                    evidence_json TEXT NOT NULL,
                    analysis_snapshot_json TEXT,
                    project_narrative TEXT,
                    report_path TEXT,
                    evidence_fingerprint TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (scan_run_id) REFERENCES scan_runs(id),
                    FOREIGN KEY (risk_id) REFERENCES risk_items(risk_id)
                );

                CREATE TABLE IF NOT EXISTS alert_state (
                    alert_key TEXT PRIMARY KEY,
                    last_status TEXT NOT NULL,
                    last_fingerprint TEXT NOT NULL,
                    last_notified_at TEXT,
                    last_payload TEXT
                );

                CREATE TABLE IF NOT EXISTS run_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job TEXT NOT NULL,
                    level TEXT NOT NULL,
                    message TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            cols = {
                row[1]
                for row in conn.execute("PRAGMA table_info(bulletins)").fetchall()
            }
            if "analysis_json" not in cols:
                conn.execute("ALTER TABLE bulletins ADD COLUMN analysis_json TEXT")

    def upsert_bulletin(
        self,
        external_id: str,
        title: str,
        published_at: str | None,
        url: str | None,
        raw_text: str | None,
        analysis: BulletinAnalysis | dict[str, Any] | None = None,
    ) -> None:
        now = _utcnow()
        analysis_json = None
        if analysis is not None:
            if isinstance(analysis, BulletinAnalysis):
                analysis_json = analysis.model_dump_json()
            else:
                analysis_json = json.dumps(analysis, ensure_ascii=False)
        with self.connect() as conn:
            if analysis_json is None:
                conn.execute(
                    """
                    INSERT INTO bulletins (external_id, title, published_at, url, raw_text, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(external_id) DO UPDATE SET
                        title=excluded.title,
                        published_at=excluded.published_at,
                        url=excluded.url,
                        raw_text=excluded.raw_text,
                        updated_at=excluded.updated_at
                    """,
                    (external_id, title, published_at, url, raw_text, now, now),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO bulletins (
                        external_id, title, published_at, url, raw_text, analysis_json, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(external_id) DO UPDATE SET
                        title=excluded.title,
                        published_at=excluded.published_at,
                        url=excluded.url,
                        raw_text=excluded.raw_text,
                        analysis_json=excluded.analysis_json,
                        updated_at=excluded.updated_at
                    """,
                    (external_id, title, published_at, url, raw_text, analysis_json, now, now),
                )

    def update_bulletin_analysis(self, external_id: str, analysis: BulletinAnalysis) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE bulletins
                SET analysis_json=?, updated_at=?
                WHERE external_id=?
                """,
                (analysis.model_dump_json(), _utcnow(), external_id),
            )

    def get_bulletin(self, external_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT b.*,
                       (SELECT COUNT(*) FROM risk_items r WHERE r.bulletin_external_id = b.external_id) AS risk_count
                FROM bulletins b
                WHERE b.external_id=?
                """,
                (external_id,),
            ).fetchone()
        return dict(row) if row else None

    def list_risk_item_rows_for_bulletin(self, bulletin_id: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT r.risk_id, r.bulletin_external_id, r.analysis_json, r.report_path,
                       r.created_at, r.updated_at, b.published_at AS bulletin_published_at
                FROM risk_items r
                LEFT JOIN bulletins b ON b.external_id = r.bulletin_external_id
                WHERE r.bulletin_external_id=?
                """,
                (bulletin_id,),
            ).fetchall()
        rows = [dict(r) for r in rows]
        rows.sort(key=_risk_official_sort_key, reverse=True)
        return rows

    def upsert_risk_item(self, record: RiskItemRecord) -> None:
        now = _utcnow()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO risk_items (risk_id, bulletin_external_id, analysis_json, report_path, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(risk_id) DO UPDATE SET
                    bulletin_external_id=excluded.bulletin_external_id,
                    analysis_json=excluded.analysis_json,
                    report_path=excluded.report_path,
                    updated_at=excluded.updated_at
                """,
                (
                    record.risk_id,
                    record.bulletin_external_id,
                    record.analysis.model_dump_json(),
                    record.report_path,
                    now,
                    now,
                ),
            )

    def list_risk_items(self) -> list[RiskItemRecord]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT risk_id, bulletin_external_id, analysis_json, report_path FROM risk_items ORDER BY risk_id"
            ).fetchall()
        out: list[RiskItemRecord] = []
        for row in rows:
            out.append(
                RiskItemRecord(
                    risk_id=row["risk_id"],
                    bulletin_external_id=row["bulletin_external_id"],
                    analysis=RiskItemAnalysis.model_validate_json(row["analysis_json"]),
                    report_path=row["report_path"],
                )
            )
        return out

    def get_risk_item(self, risk_id: str) -> RiskItemRecord | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT risk_id, bulletin_external_id, analysis_json, report_path FROM risk_items WHERE risk_id=?",
                (risk_id,),
            ).fetchone()
        if not row:
            return None
        return RiskItemRecord(
            risk_id=row["risk_id"],
            bulletin_external_id=row["bulletin_external_id"],
            analysis=RiskItemAnalysis.model_validate_json(row["analysis_json"]),
            report_path=row["report_path"],
        )

    def start_scan_run(self, project_id: str) -> int:
        with self.connect() as conn:
            cur = conn.execute(
                "INSERT INTO scan_runs (project_id, started_at, status) VALUES (?, ?, ?)",
                (project_id, _utcnow(), "running"),
            )
            return int(cur.lastrowid)

    def finish_scan_run(
        self,
        scan_run_id: int,
        status: str,
        git_commit: str | None = None,
        error: str | None = None,
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE scan_runs
                SET finished_at=?, status=?, git_commit=?, error=?
                WHERE id=?
                """,
                (_utcnow(), status, git_commit, error, scan_run_id),
            )

    def insert_finding(self, scan_run_id: int | None, finding: FindingRecord) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO findings (
                    scan_run_id, project_id, risk_id, remediation_status, fix_method,
                    evidence_json, analysis_snapshot_json, project_narrative, report_path,
                    evidence_fingerprint, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    scan_run_id,
                    finding.project_id,
                    finding.risk_id,
                    finding.remediation_status.value,
                    finding.fix_method.value,
                    finding.evidence.model_dump_json(),
                    finding.analysis_snapshot.model_dump_json() if finding.analysis_snapshot else None,
                    finding.project_narrative,
                    finding.report_path,
                    finding.evidence_fingerprint,
                    _utcnow(),
                ),
            )

    def get_alert_state(self, alert_key: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT alert_key, last_status, last_fingerprint, last_notified_at, last_payload FROM alert_state WHERE alert_key=?",
                (alert_key,),
            ).fetchone()
        return dict(row) if row else None

    def upsert_alert_state(
        self,
        alert_key: str,
        status: str,
        fingerprint: str,
        payload: str | None = None,
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO alert_state (alert_key, last_status, last_fingerprint, last_notified_at, last_payload)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(alert_key) DO UPDATE SET
                    last_status=excluded.last_status,
                    last_fingerprint=excluded.last_fingerprint,
                    last_notified_at=excluded.last_notified_at,
                    last_payload=excluded.last_payload
                """,
                (alert_key, status, fingerprint, _utcnow(), payload),
            )

    def log(self, job: str, level: str, message: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO run_logs (job, level, message, created_at) VALUES (?, ?, ?, ?)",
                (job, level, message, _utcnow()),
            )

    def recent_findings(self, limit: int = 50) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT project_id, risk_id, remediation_status, fix_method, evidence_fingerprint, created_at, report_path
                FROM findings
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def summary(self) -> dict[str, int]:
        with self.connect() as conn:
            bulletins = conn.execute("SELECT COUNT(*) AS c FROM bulletins").fetchone()["c"]
            risks = conn.execute("SELECT COUNT(*) AS c FROM risk_items").fetchone()["c"]
            findings = conn.execute("SELECT COUNT(*) AS c FROM findings").fetchone()["c"]
            scans = conn.execute("SELECT COUNT(*) AS c FROM scan_runs").fetchone()["c"]
        return {
            "bulletins": bulletins,
            "risk_items": risks,
            "findings": findings,
            "scan_runs": scans,
        }

    def list_latest_findings(self, project_id: str | None = None) -> list[dict[str, Any]]:
        """Latest finding per (project_id, risk_id), optionally filtered by project."""
        sql = """
            SELECT f.*
            FROM findings f
            INNER JOIN (
                SELECT project_id, risk_id, MAX(id) AS max_id
                FROM findings
                GROUP BY project_id, risk_id
            ) latest ON f.id = latest.max_id
        """
        params: list[Any] = []
        if project_id:
            sql += " WHERE f.project_id = ?"
            params.append(project_id)
        sql += " ORDER BY f.project_id, f.risk_id"
        with self.connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def count_latest_by_status(self, project_id: str | None = None) -> dict[str, int]:
        counts = {
            "vulnerable": 0,
            "fixed": 0,
            "unknown": 0,
            "error": 0,
            "not_applicable": 0,
        }
        for row in self.list_latest_findings(project_id=project_id):
            status = row.get("remediation_status") or "unknown"
            if status in counts:
                counts[status] += 1
            else:
                counts["unknown"] += 1
        return counts

    def count_open_latest_findings(self) -> int:
        """vulnerable + unknown + error across latest findings."""
        counts = self.count_latest_by_status()
        return counts["vulnerable"] + counts["unknown"] + counts["error"]

    def list_scan_runs(self, project_id: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        sql = "SELECT * FROM scan_runs"
        params: list[Any] = []
        if project_id:
            sql += " WHERE project_id = ?"
            params.append(project_id)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        with self.connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def latest_scan_run(self, project_id: str) -> dict[str, Any] | None:
        rows = self.list_scan_runs(project_id=project_id, limit=1)
        return rows[0] if rows else None

    def recent_failed_scans(self, limit: int = 10) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM scan_runs
                WHERE status = 'error'
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def list_alert_state(self, project_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as conn:
            if project_id:
                rows = conn.execute(
                    """
                    SELECT * FROM alert_state
                    WHERE alert_key LIKE ?
                    ORDER BY last_notified_at DESC
                    LIMIT ?
                    """,
                    (f"%{project_id}%", limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM alert_state ORDER BY last_notified_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
        return [dict(r) for r in rows]

    def latest_alert_for_project(self, project_id: str) -> dict[str, Any] | None:
        # Prefer aggregate project key; fall back to any key mentioning the project id.
        direct = self.get_alert_state(f"project:{project_id}")
        if direct:
            return direct
        rows = self.list_alert_state(project_id=project_id, limit=1)
        return rows[0] if rows else None

    def list_bulletins(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT b.external_id, b.title, b.published_at, b.url, b.updated_at,
                       (SELECT COUNT(*) FROM risk_items r WHERE r.bulletin_external_id = b.external_id) AS risk_count
                FROM bulletins b
                ORDER BY b.published_at DESC, b.external_id DESC
                """
            ).fetchall()
        return [dict(r) for r in rows]

    def list_risk_item_rows(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT r.risk_id, r.bulletin_external_id, r.analysis_json, r.report_path,
                       r.created_at, r.updated_at, b.published_at AS bulletin_published_at
                FROM risk_items r
                LEFT JOIN bulletins b ON b.external_id = r.bulletin_external_id
                """
            ).fetchall()
        items = [dict(r) for r in rows]
        items.sort(key=_risk_official_sort_key, reverse=True)
        return items

    def get_risk_item_row(self, risk_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT risk_id, bulletin_external_id, analysis_json, report_path, created_at, updated_at
                FROM risk_items WHERE risk_id=?
                """,
                (risk_id,),
            ).fetchone()
        return dict(row) if row else None

    def delete_risk_item(self, risk_id: str) -> bool:
        """Delete a risk item and its findings (FK)."""
        with self.connect() as conn:
            conn.execute("DELETE FROM findings WHERE risk_id=?", (risk_id,))
            cur = conn.execute("DELETE FROM risk_items WHERE risk_id=?", (risk_id,))
            return cur.rowcount > 0

    def delete_risk_items(self, risk_ids: list[str]) -> list[str]:
        """Delete risks and their findings; return ids that were removed."""
        removed: list[str] = []
        for rid in risk_ids:
            if self.delete_risk_item(rid):
                removed.append(rid)
        return removed

    def list_year_mismatched_risk_ids(self) -> list[str]:
        """
        RiskItems whose CVE calendar year is more than 1 year away from APSB YY
        (typical empty-shell invent / cross-wired bulletin). Skips synthetic APSB>2035.
        """
        bad: list[str] = []
        for row in self.list_risk_item_rows():
            try:
                analysis = RiskItemAnalysis.model_validate_json(row["analysis_json"])
            except Exception:  # noqa: BLE001
                continue
            bulletin = (row.get("bulletin_external_id") or "").strip()
            m = _APSB_ID_RE.search(bulletin) or _APSB_ID_RE.search(row.get("risk_id") or "")
            if not m:
                continue
            apsb_y = 2000 + int(m.group(1))
            if apsb_y > 2035:
                continue
            for cve in analysis.cve_ids or []:
                cm = re.match(r"CVE-(\d{4})-", str(cve), re.I)
                if not cm:
                    continue
                cy = int(cm.group(1))
                if abs(cy - apsb_y) > 1:
                    bad.append(row["risk_id"])
                    break
        return bad

    def purge_placeholder_risk_items(self) -> list[str]:
        """Remove list-page placeholder risks (no CVE / no packages, 'security update' shell)."""
        removed: list[str] = []
        for row in self.list_risk_item_rows():
            try:
                analysis = RiskItemAnalysis.model_validate_json(row["analysis_json"])
            except Exception:  # noqa: BLE001
                continue
            if not _is_placeholder_analysis(row["risk_id"], analysis):
                continue
            if self.delete_risk_item(row["risk_id"]):
                removed.append(row["risk_id"])
        return removed


def _is_placeholder_analysis(risk_id: str, analysis: RiskItemAnalysis) -> bool:
    if analysis.cve_ids:
        return False
    if analysis.packages:
        return False
    if analysis.fingerprints:
        return False
    rid = risk_id.lower()
    title = (analysis.title or "").lower()
    if "security-update" in rid or "security update" in title:
        return True
    # Generic empty shell with no actionable intel
    if not analysis.cve_ids and not analysis.packages and "unresolved" in title:
        return True
    return False


def dump_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8")
