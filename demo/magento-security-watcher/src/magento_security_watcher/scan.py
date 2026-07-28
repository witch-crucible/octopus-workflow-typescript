from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from magento_security_watcher.config import AppSettings, EnvSecrets, ensure_data_dirs, load_env_secrets
from magento_security_watcher.git_workspace import GitWorkspace, GitWorkspaceError
from magento_security_watcher.inventory import MagentoInventory
from magento_security_watcher.llm import LlmClient
from magento_security_watcher.matcher import match_risk_item
from magento_security_watcher.models import FindingRecord, ProjectConfig, RemediationStatus
from magento_security_watcher.notify import (
    WeComNotifier,
    finding_from_row,
    notify_project,
    notify_scan_error,
)
from magento_security_watcher.store import Store, dump_json, _is_placeholder_analysis

logger = logging.getLogger(__name__)

# Latest findings with these statuses are skipped on incremental scan.
_SKIP_RESCAN_STATUSES = frozenset(
    {
        RemediationStatus.FIXED.value,
        RemediationStatus.NOT_APPLICABLE.value,
    }
)


def _attention_reason(finding: FindingRecord) -> str:
    """Short hint for why a finding needs attention / is unknown."""
    parts: list[str] = []
    analysis = finding.analysis_snapshot
    if analysis is not None:
        if not analysis.packages:
            parts.append("no packages")
        if not analysis.fingerprints:
            parts.append("no fingerprints")
        if analysis.remediation_offer.value == "unknown":
            parts.append("offer=unknown")
        if analysis.source_missing:
            parts.append("missing=" + ",".join(analysis.source_missing[:4]))
    ver = finding.evidence.version or {}
    if ver.get("applicable") is None and not (analysis and analysis.packages):
        parts.append("cannot version-match")
    for w in (finding.evidence.warnings or [])[:2]:
        parts.append(w)
    return "; ".join(parts)


class ScanService:
    def __init__(
        self,
        settings: AppSettings,
        store: Store,
        paths: dict[str, Path],
        secrets: EnvSecrets | None = None,
    ) -> None:
        self.settings = settings
        self.store = store
        self.paths = paths
        self.secrets = secrets or load_env_secrets()
        self.git = GitWorkspace(
            Path(settings.git.mirrors_dir),
            timeout=settings.git.fetch_timeout_seconds,
        )
        self.llm = LlmClient(
            api_base=settings.llm.api_base,
            api_key=self.secrets.llm_api_key,
            model=settings.llm.model,
            timeout=settings.llm.timeout_seconds,
            enabled=settings.llm.enabled,
        )
        self.notifier = WeComNotifier(
            webhook_url=self.secrets.wecom_webhook_url,
            enabled=settings.wecom.enabled,
            mention_all_on_critical=settings.wecom.mention_all_on_critical,
        )

    def scan_projects(
        self,
        projects: list[ProjectConfig],
        *,
        notify: bool = False,
        full: bool = False,
        local_workspaces: dict[str, Path] | None = None,
    ) -> dict[str, Any]:
        enabled = [p for p in projects if p.enabled]
        skipped = len(projects) - len(enabled)
        risk_items = [
            r
            for r in self.store.list_risk_items()
            if not _is_placeholder_analysis(r.risk_id, r.analysis)
        ]
        logger.info(
            "scan start: %s project(s) enabled (%s skipped), %s risk item(s), notify=%s full=%s",
            len(enabled),
            skipped,
            len(risk_items),
            notify,
            full,
        )
        summary = {
            "projects": 0,
            "findings": 0,
            "errors": 0,
            "notified": 0,
            "skipped_risks": 0,
        }
        for idx, project in enumerate(enabled, start=1):
            summary["projects"] += 1
            logger.info(
                "[%s/%s] scanning project id=%s name=%s branch=%s",
                idx,
                len(enabled),
                project.id,
                project.name or project.id,
                project.branch,
            )
            try:
                findings, skipped_n = self.scan_one(
                    project,
                    risk_items=risk_items,
                    notify=notify,
                    full=full,
                    local_workspace=(local_workspaces or {}).get(project.id),
                )
                summary["findings"] += len(findings)
                summary["skipped_risks"] += skipped_n
                counts: dict[str, int] = {}
                for finding in findings:
                    key = finding.remediation_status.value
                    counts[key] = counts.get(key, 0) + 1
                logger.info(
                    "[%s/%s] project %s done: %s finding(s) skipped_risks=%s %s",
                    idx,
                    len(enabled),
                    project.id,
                    len(findings),
                    skipped_n,
                    counts,
                )
                if notify:
                    latest = [
                        finding_from_row(r)
                        for r in self.store.list_latest_findings(project_id=project.id)
                    ]
                    if notify_project(
                        self.store,
                        self.notifier,
                        latest,
                        project_id=project.id,
                        project_name=project.name,
                    ):
                        summary["notified"] += 1
                        logger.info("notified project=%s (aggregate)", project.id)
            except Exception as exc:  # noqa: BLE001
                summary["errors"] += 1
                logger.exception("project %s failed: %s", project.id, exc)
                self.store.log("scan", "error", f"{project.id}: {exc}")
                if notify:
                    notify_scan_error(self.store, self.notifier, project.id, str(exc))
        logger.info(
            "scan complete: projects=%s findings=%s skipped_risks=%s errors=%s notified=%s",
            summary["projects"],
            summary["findings"],
            summary["skipped_risks"],
            summary["errors"],
            summary["notified"],
        )
        return summary

    def risks_to_scan(
        self,
        project_id: str,
        risk_items: list,
        *,
        full: bool = False,
    ) -> tuple[list, int]:
        """Filter risk items for incremental scan. Returns (to_scan, skipped_count)."""
        if full or not risk_items:
            return list(risk_items), 0
        latest = {
            row["risk_id"]: row.get("remediation_status")
            for row in self.store.list_latest_findings(project_id=project_id)
        }
        to_scan = []
        skipped = 0
        for risk in risk_items:
            status = latest.get(risk.risk_id)
            if status in _SKIP_RESCAN_STATUSES:
                skipped += 1
                continue
            to_scan.append(risk)
        return to_scan, skipped

    def scan_one(
        self,
        project: ProjectConfig,
        *,
        risk_items: list | None = None,
        notify: bool = False,
        full: bool = False,
        local_workspace: Path | None = None,
    ) -> tuple[list[FindingRecord], int]:
        risk_items = risk_items if risk_items is not None else self.store.list_risk_items()
        risk_items, skipped_n = self.risks_to_scan(project.id, risk_items, full=full)
        if skipped_n:
            logger.info(
                "project %s incremental: scanning %s risk(s), skipping %s fixed/N/A",
                project.id,
                len(risk_items),
                skipped_n,
            )
        run_id = self.store.start_scan_run(project.id)
        commit = None
        try:
            if local_workspace is not None:
                workspace = Path(local_workspace)
                commit = "local"
                logger.info("project %s using local workspace %s", project.id, workspace)
            else:
                logger.info("project %s syncing git branch=%s …", project.id, project.branch)
                workspace, commit = self.git.sync(project.id, project.git_url, project.branch)
                logger.info(
                    "project %s git ready commit=%s path=%s",
                    project.id,
                    commit[:12] if commit else None,
                    workspace,
                )

            inventory = MagentoInventory(workspace).collect()
            installed = inventory["packages"]
            logger.info(
                "project %s inventory: product_version=%s packages=%s",
                project.id,
                inventory.get("product_version"),
                inventory.get("package_count"),
            )
            logger.debug(
                "project %s installed package sample: %s",
                project.id,
                list(installed.keys())[:20],
            )
            findings: list[FindingRecord] = []

            for i, risk in enumerate(risk_items, start=1):
                finding = match_risk_item(
                    project_id=project.id,
                    workspace=workspace,
                    installed=installed,
                    analysis=risk.analysis,
                    risk_id=risk.risk_id,
                )
                finding.project_narrative = self._project_narrative(project, finding)
                report_path = self._write_finding_report(project, finding, inventory, commit)
                finding.report_path = str(report_path)
                self.store.insert_finding(run_id, finding)
                findings.append(finding)
                logger.debug(
                    "  [%s/%s] %s → %s / %s (fp=%s)",
                    i,
                    len(risk_items),
                    risk.risk_id,
                    finding.remediation_status.value,
                    finding.fix_method.value,
                    finding.evidence_fingerprint[:16],
                )
                if finding.remediation_status in {
                    RemediationStatus.VULNERABLE,
                    RemediationStatus.UNKNOWN,
                    RemediationStatus.ERROR,
                }:
                    why = _attention_reason(finding)
                    logger.info(
                        "  attention %s → %s / %s%s",
                        risk.risk_id,
                        finding.remediation_status.value,
                        finding.fix_method.value,
                        f" ({why})" if why else "",
                    )

            self.store.finish_scan_run(run_id, "ok", git_commit=commit)
            summary_path = self._write_project_summary(project, findings, commit)
            logger.debug("project %s summary written %s", project.id, summary_path)
            return findings, skipped_n
        except GitWorkspaceError as exc:
            logger.error("project %s git error: %s", project.id, exc)
            self.store.finish_scan_run(run_id, "error", git_commit=commit, error=str(exc))
            raise
        except Exception as exc:
            logger.error("project %s scan error: %s", project.id, exc)
            self.store.finish_scan_run(run_id, "error", git_commit=commit, error=str(exc))
            raise

    def _project_narrative(self, project: ProjectConfig, finding: FindingRecord) -> str:
        base = (
            f"项目 `{project.id}` 风险 `{finding.risk_id}`："
            f"{finding.remediation_status.value} / {finding.fix_method.value}。"
        )
        if not self.llm.enabled:
            return base
        try:
            logger.debug("LLM narrative for %s / %s", project.id, finding.risk_id)
            text = self.llm.narrate_project_finding(
                {
                    "project": project.model_dump(),
                    "finding": {
                        "risk_id": finding.risk_id,
                        "remediation_status": finding.remediation_status.value,
                        "fix_method": finding.fix_method.value,
                        "evidence": finding.evidence.model_dump(),
                        "analysis": finding.analysis_snapshot.model_dump() if finding.analysis_snapshot else None,
                    },
                }
            )
            return text or base
        except Exception as exc:  # noqa: BLE001
            logger.warning("LLM project narrative failed for %s: %s", project.id, exc)
            self.store.log("scan", "warning", f"LLM project narrative failed: {exc}")
            return base + "（大模型项目说明不可用）"

    def _write_finding_report(
        self,
        project: ProjectConfig,
        finding: FindingRecord,
        inventory: dict[str, Any],
        commit: str | None,
    ) -> Path:
        out_dir = self.paths["reports_projects"] / project.id
        out_dir.mkdir(parents=True, exist_ok=True)
        safe = finding.risk_id.replace(":", "_")
        json_path = out_dir / f"{safe}.json"
        md_path = out_dir / f"{safe}.md"
        dump_json(
            json_path,
            {
                "project_id": project.id,
                "commit": commit,
                "inventory": {
                    "product_version": inventory.get("product_version"),
                    "package_count": inventory.get("package_count"),
                },
                "finding": finding.model_dump(),
            },
        )
        analysis = finding.analysis_snapshot
        md = [
            f"# Finding: {project.id} / {finding.risk_id}",
            "",
            f"- remediation_status: **{finding.remediation_status.value}**",
            f"- fix_method: `{finding.fix_method.value}`",
            f"- commit: `{commit}`",
            f"- product_version: `{inventory.get('product_version')}`",
            "",
            "## Risk snapshot",
            f"- title: {analysis.title if analysis else 'n/a'}",
            f"- severity: {analysis.severity.value if analysis else 'n/a'}",
            f"- score: {analysis.score if analysis else 'n/a'}",
            f"- remediation_offer: {analysis.remediation_offer.value if analysis else 'n/a'}",
            "",
            "## Project narrative",
            finding.project_narrative or "_none_",
            "",
            "## Evidence",
            "```json",
            finding.evidence.model_dump_json(indent=2),
            "```",
            "",
        ]
        md_path.write_text("\n".join(md), encoding="utf-8")
        return md_path

    def _write_project_summary(
        self,
        project: ProjectConfig,
        findings: list[FindingRecord],
        commit: str | None,
    ) -> Path:
        out = self.paths["reports_projects"] / project.id / "SUMMARY.md"
        counts: dict[str, int] = {}
        for f in findings:
            counts[f.remediation_status.value] = counts.get(f.remediation_status.value, 0) + 1
        lines = [
            f"# Scan summary: {project.id}",
            "",
            f"- commit: `{commit}`",
            f"- findings: {len(findings)}",
            "",
            "## Counts",
        ]
        for k, v in sorted(counts.items()):
            lines.append(f"- {k}: {v}")
        lines.extend(["", "## Details", ""])
        for f in findings:
            lines.append(
                f"- `{f.risk_id}`: {f.remediation_status.value} ({f.fix_method.value})"
            )
        out.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return out


def build_scan(settings: AppSettings) -> ScanService:
    paths = ensure_data_dirs(settings)
    store = Store(settings.db_path)
    return ScanService(settings, store, paths, load_env_secrets())
