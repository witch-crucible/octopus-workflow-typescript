from __future__ import annotations

import hashlib
import logging
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse, urlunparse

import httpx

from magento_security_watcher.i18n_zh import severity_zh
from magento_security_watcher.models import (
    BulletinAnalysis,
    FindingEvidence,
    FindingRecord,
    FixMethod,
    RemediationStatus,
    RiskItemAnalysis,
    Severity,
)

logger = logging.getLogger(__name__)


_SEV_RANK = {
    Severity.CRITICAL: 5,
    Severity.HIGH: 4,
    Severity.MEDIUM: 3,
    Severity.LOW: 2,
    Severity.NONE: 1,
    Severity.UNKNOWN: 0,
}

_NOTIFY_STATUSES = frozenset(
    {
        RemediationStatus.VULNERABLE,
        RemediationStatus.UNKNOWN,
        RemediationStatus.FIXED,
    }
)

_OPEN_STATUSES = frozenset(
    {
        RemediationStatus.VULNERABLE,
        RemediationStatus.UNKNOWN,
    }
)


def _truncate_utf8(text: str, max_bytes: int) -> str:
    """Truncate so UTF-8 encoding stays within max_bytes (WeCom API limit)."""
    raw = (text or "").encode("utf-8")
    if len(raw) <= max_bytes:
        return text or ""
    cut = raw[: max(0, max_bytes - 3)]
    while cut:
        try:
            return cut.decode("utf-8") + "…"
        except UnicodeDecodeError:
            cut = cut[:-1]
    return "…"


def _short_block(text: str, max_chars: int) -> str:
    body = (text or "").strip() or "—"
    if len(body) <= max_chars:
        return body
    return body[: max_chars - 1] + "…"


def _font(color: str, text: str) -> str:
    """WeCom markdown only allows info|comment|warning."""
    return f'<font color="{color}">{text}</font>'


def _quote_block(text: str) -> str:
    lines = [ln for ln in (text or "").strip().splitlines() if ln.strip()] or ["—"]
    return "\n".join(f">{ln}" for ln in lines)


def _sev_font(sev: Severity) -> str:
    label = severity_zh(sev)
    if sev in (Severity.CRITICAL, Severity.HIGH):
        return _font("warning", label)
    if sev == Severity.MEDIUM:
        return _font("comment", label)
    return _font("info", label)


def _redact_webhook(url: Optional[str]) -> str:
    if not url:
        return "(empty)"
    try:
        parsed = urlparse(url)
        qs = parse_qs(parsed.query)
        if "key" in qs and qs["key"]:
            key = qs["key"][0]
            if len(key) > 8:
                qs["key"] = [f"{key[:4]}…{key[-4:]}"]
            else:
                qs["key"] = ["***"]
            query = "&".join(f"{k}={v[0]}" for k, v in qs.items())
            return urlunparse(parsed._replace(query=query))
    except Exception:  # noqa: BLE001
        pass
    return "(webhook)"


def _console(msg: str) -> None:
    """Always visible in the serve process console (uvicorn)."""
    print(f"[msw:wecom] {msg}", flush=True)
    logger.info("%s", msg)


class WeComNotifier:
    def __init__(
        self,
        webhook_url: Optional[str],
        enabled: bool = False,
        *,
        mention_all_on_critical: bool = False,
        client: Optional[httpx.Client] = None,
    ) -> None:
        self.webhook_url = webhook_url
        self.enabled = enabled and bool(webhook_url)
        self.mention_all_on_critical = mention_all_on_critical
        self.client = client or httpx.Client(timeout=30.0)
        self.last_error: Optional[str] = None

    def send_markdown(self, content: str, *, mention_all: bool = False) -> bool:
        """Send WeCom group-robot markdown (official subset). Never @all."""
        self.last_error = None
        if not self.enabled or not self.webhook_url:
            self.last_error = "企微未启用或缺少 Webhook"
            _console(f"send skipped: {self.last_error} enabled_flag={bool(self.webhook_url)}")
            return False
        # mention_all kept for call-site compat; @all intentionally disabled.
        _ = mention_all
        text = _truncate_utf8((content or "").rstrip(), 3500)
        payload: dict[str, Any] = {"msgtype": "markdown", "markdown": {"content": text}}
        return self._post_payload(payload, label="markdown")

    def _post_payload(self, payload: dict[str, Any], *, label: str) -> bool:
        msgtype = payload.get("msgtype", "?")
        if msgtype == "markdown":
            raw = (payload.get("markdown") or {}).get("content") or ""
        elif msgtype == "text":
            raw = (payload.get("text") or {}).get("content") or ""
        else:
            raw = ""
        raw_bytes = len(str(raw).encode("utf-8"))
        _console(
            f"POST {_redact_webhook(self.webhook_url)} "
            f"label={label} msgtype={msgtype} chars={len(str(raw))} bytes={raw_bytes}"
        )
        try:
            resp = self.client.post(self.webhook_url, json=payload)
            status = getattr(resp, "status_code", "?")
            body_preview = ""
            try:
                body_preview = (resp.text or "")[:500]
            except Exception:  # noqa: BLE001
                try:
                    body_preview = str(resp.json())[:500]
                except Exception:  # noqa: BLE001
                    body_preview = "(unreadable body)"
            _console(f"response http={status} body={body_preview!r}")
            if hasattr(resp, "raise_for_status"):
                resp.raise_for_status()
            data = resp.json()
            code = int(data.get("errcode", 0) or 0)
            if code != 0:
                self.last_error = f"errcode={code} {data.get('errmsg') or ''}".strip()
                _console(f"send failed ({label}): {self.last_error}")
                return False
            _console(f"send ok ({label})")
            return True
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)
            _console(f"send exception ({label}): {self.last_error}")
            return False

    def format_project_summary(
        self,
        findings: list[FindingRecord],
        *,
        project_id: str,
        project_name: Optional[str] = None,
    ) -> str:
        name = project_name or project_id
        eligible = [f for f in findings if f.remediation_status in _NOTIFY_STATUSES]
        open_n = sum(1 for f in eligible if f.remediation_status in _OPEN_STATUSES)
        fixed_n = sum(1 for f in eligible if f.remediation_status == RemediationStatus.FIXED)
        unknown_n = sum(1 for f in eligible if f.remediation_status == RemediationStatus.UNKNOWN)
        vuln_n = sum(1 for f in eligible if f.remediation_status == RemediationStatus.VULNERABLE)

        by_bulletin: dict[str, list[FindingRecord]] = {}
        for f in eligible:
            bid = bulletin_id_from_risk_id(f.risk_id)
            by_bulletin.setdefault(bid or "—", []).append(f)

        open_color = "warning" if open_n else "info"
        lines = [
            "## Magento 安全监控通知",
            f">项目：`{name}`",
            f">未修+未知：{_font(open_color, str(open_n))}",
            f">汇总：未修 {vuln_n} · 未知 {unknown_n} · 已修 {fixed_n}（纳入 {len(eligible)}）",
        ]
        if by_bulletin:
            lines.append("")
            lines.append("**按公告**")
            for bid in sorted(by_bulletin.keys()):
                group = by_bulletin[bid]
                open_g = sum(1 for f in group if f.remediation_status in _OPEN_STATUSES)
                top = max(
                    (_finding_severity(f) for f in group),
                    key=lambda s: _SEV_RANK.get(s, 0),
                    default=Severity.UNKNOWN,
                )
                lines.append(
                    f">`{bid}` · 未修/未知 {open_g}/{len(group)} · 最高 {_sev_font(top)}"
                )
        else:
            lines.append("")
            lines.append(f">{_font('comment', '当前无纳入通知的发现（未修/未知/已修）')}")
        return "\n".join(lines)

    def format_bulletin_summary(
        self,
        *,
        external_id: str,
        title: str,
        analysis: Optional[BulletinAnalysis] = None,
        created_count: int = 0,
    ) -> str:
        a = analysis
        overview = _short_block((a.severity_overview if a else None) or "—", 360)
        impact = _short_block((a.business_impact_scope if a else None) or "—", 360)
        rem = _short_block((a.remediation_summary if a else None) or "—", 420)
        patch = "有" if (a and a.has_isolated_patch) else "无/未确认"
        upgrade = "是" if (a and a.upgrade_available) else "否/未确认"
        patch_font = _font("info", patch) if a and a.has_isolated_patch else _font("comment", patch)
        upgrade_font = (
            _font("info", upgrade) if a and a.upgrade_available else _font("comment", upgrade)
        )
        lines = [
            "## Magento 安全监控 — 公告情报",
            f">公告：`{external_id}`",
            f">标题：{title or '—'}",
        ]
        if created_count:
            lines.append(f">本轮新建风险：{_font('warning', str(created_count))}")
        lines.extend(
            [
                f">独立补丁：{patch_font} · 可升级：{upgrade_font}",
                "",
                "**等级概览**",
                _quote_block(overview),
                "",
                "**业务影响**",
                _quote_block(impact),
                "",
                "**支持的修复方式**",
                _quote_block(rem),
            ]
        )
        return "\n".join(lines)

    def format_error(self, job: str, project_id: Optional[str], message: str) -> str:
        proj = project_id or "-"
        job_zh = {"scan": "扫描", "ingest": "采集"}.get(job, job)
        return (
            f"## Magento 安全监控 — {_font('warning', job_zh + '失败')}\n"
            f">项目：`{proj}`\n"
            f">{_font('comment', message[:500])}"
        )


def bulletin_id_from_risk_id(risk_id: str) -> str:
    text = (risk_id or "").strip()
    if ":" in text:
        return text.split(":", 1)[0]
    return text


def alert_key_project(project_id: str) -> str:
    return f"project:{project_id}"


def alert_key_bulletin(external_id: str) -> str:
    return f"bulletin:{external_id}"


def alert_key_scan_error(project_id: str) -> str:
    return f"scan_error:{project_id}"


def _finding_severity(finding: FindingRecord) -> Severity:
    if finding.analysis_snapshot:
        return finding.analysis_snapshot.severity
    return Severity.UNKNOWN


def project_notify_fingerprint(findings: list[FindingRecord]) -> str:
    parts = sorted(
        f"{f.risk_id}|{f.remediation_status.value}|{f.evidence_fingerprint}"
        for f in findings
    )
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:16]


def bulletin_notify_fingerprint(
    *,
    title: str,
    analysis: Optional[BulletinAnalysis],
    created_count: int,
) -> str:
    a = analysis
    blob = "|".join(
        [
            title or "",
            (a.severity_overview if a else "") or "",
            (a.business_impact_scope if a else "") or "",
            (a.remediation_summary if a else "") or "",
            str(bool(a.has_isolated_patch) if a else False),
            str(bool(a.upgrade_available) if a else False),
            str(created_count),
        ]
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def finding_from_row(row: dict[str, Any]) -> FindingRecord:
    """Rebuild FindingRecord from a findings table row (latest or otherwise)."""
    analysis = None
    raw_analysis = row.get("analysis_snapshot_json")
    if raw_analysis:
        try:
            analysis = RiskItemAnalysis.model_validate_json(raw_analysis)
        except Exception:  # noqa: BLE001
            analysis = None
    evidence = FindingEvidence()
    raw_evidence = row.get("evidence_json")
    if raw_evidence:
        try:
            evidence = FindingEvidence.model_validate_json(raw_evidence)
        except Exception:  # noqa: BLE001
            evidence = FindingEvidence()
    try:
        status = RemediationStatus(row.get("remediation_status") or "unknown")
    except ValueError:
        status = RemediationStatus.UNKNOWN
    try:
        fix = FixMethod(row.get("fix_method") or "unknown")
    except ValueError:
        fix = FixMethod.UNKNOWN
    return FindingRecord(
        project_id=row["project_id"],
        risk_id=row["risk_id"],
        remediation_status=status,
        fix_method=fix,
        evidence=evidence,
        analysis_snapshot=analysis,
        project_narrative=row.get("project_narrative"),
        report_path=row.get("report_path"),
        evidence_fingerprint=row.get("evidence_fingerprint") or "",
    )


def should_notify(store: Any, key: str, status: str, fingerprint: str) -> bool:
    prev = store.get_alert_state(key)
    if not prev:
        return True
    return prev["last_status"] != status or prev["last_fingerprint"] != fingerprint


def _commit_alert(
    store: Any,
    notifier: WeComNotifier,
    *,
    key: str,
    status: str,
    fingerprint: str,
    content: str,
    mention_all: bool,
    force: bool,
) -> bool:
    if not force and not should_notify(store, key, status, fingerprint):
        return False
    sent = notifier.send_markdown(content, mention_all=mention_all)
    if sent or not notifier.enabled:
        store.upsert_alert_state(key, status, fingerprint, payload=content)
        return True
    return False


def notify_project(
    store: Any,
    notifier: WeComNotifier,
    findings: list[FindingRecord],
    *,
    project_id: str,
    project_name: Optional[str] = None,
    force: bool = False,
) -> bool:
    """One WeCom message per project (aggregate)."""
    eligible = [f for f in findings if f.remediation_status in _NOTIFY_STATUSES]
    if not eligible and not force:
        return False
    key = alert_key_project(project_id)
    fp = project_notify_fingerprint(eligible)
    open_n = sum(1 for f in eligible if f.remediation_status in _OPEN_STATUSES)
    status = f"open:{open_n}/total:{len(eligible)}"
    content = notifier.format_project_summary(
        findings,
        project_id=project_id,
        project_name=project_name,
    )
    mention = False
    return _commit_alert(
        store,
        notifier,
        key=key,
        status=status,
        fingerprint=fp,
        content=content,
        mention_all=mention,
        force=force,
    )


def notify_bulletin(
    store: Any,
    notifier: WeComNotifier,
    *,
    external_id: str,
    title: str,
    analysis: Optional[BulletinAnalysis] = None,
    created_count: int = 0,
    has_critical: bool = False,
    force: bool = False,
) -> bool:
    """One WeCom message per bulletin (no CVE list)."""
    if created_count <= 0 and not force:
        return False
    key = alert_key_bulletin(external_id)
    fp = bulletin_notify_fingerprint(
        title=title, analysis=analysis, created_count=created_count
    )
    status = f"new:{created_count}" if created_count else "manual"
    content = notifier.format_bulletin_summary(
        external_id=external_id,
        title=title,
        analysis=analysis,
        created_count=created_count,
    )
    _ = has_critical
    mention = False
    return _commit_alert(
        store,
        notifier,
        key=key,
        status=status,
        fingerprint=fp,
        content=content,
        mention_all=mention,
        force=force,
    )


def notify_scan_error(store: Any, notifier: WeComNotifier, project_id: str, message: str) -> bool:
    key = alert_key_scan_error(project_id)
    fp = hashlib.sha256(message.encode("utf-8")).hexdigest()[:16]
    if not should_notify(store, key, "error", fp):
        return False
    content = notifier.format_error("scan", project_id, message)
    sent = notifier.send_markdown(content)
    if sent or not notifier.enabled:
        store.upsert_alert_state(key, "error", fp, payload=content)
        return True
    return False


def notify_pending(
    store: Any,
    notifier: WeComNotifier,
    *,
    project_ids: list[str] | None = None,
    project_names: dict[str, str] | None = None,
) -> dict[str, int]:
    """
    Send WeCom alerts for latest findings without scanning.

    One message per project; same status filter and alert_state dedupe as ``scan --notify``.
    """
    names = project_names or {}
    wanted = set(project_ids) if project_ids else None
    by_project: dict[str, list[FindingRecord]] = {}
    for row in store.list_latest_findings():
        pid = row.get("project_id") or ""
        if wanted is not None and pid not in wanted:
            continue
        finding = finding_from_row(row)
        if finding.remediation_status not in _NOTIFY_STATUSES:
            continue
        by_project.setdefault(pid, []).append(finding)

    summary = {"candidates": len(by_project), "notified": 0, "skipped": 0}
    for pid, findings in by_project.items():
        if notify_project(
            store,
            notifier,
            findings,
            project_id=pid,
            project_name=names.get(pid) or pid,
        ):
            summary["notified"] += 1
        else:
            summary["skipped"] += 1
    return summary
