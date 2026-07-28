"""Presentation helpers: redact secrets, expand JSON for templates."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse, urlunparse

from magento_security_watcher.i18n_zh import display_risk_title, fix_method_zh, severity_zh, status_zh
from magento_security_watcher.magento_version import composer_recommendable_versions
from magento_security_watcher.models import BulletinAnalysis, RiskItemAnalysis, Severity


OPEN_STATUSES = frozenset({"vulnerable", "unknown", "error"})
CLOSED_STATUSES = frozenset({"fixed", "not_applicable"})


def redact_git_url(url: str) -> str:
    """Hide credentials embedded in git URLs."""
    if not url:
        return ""
    try:
        parsed = urlparse(url)
    except Exception:
        return "***"
    if parsed.username or parsed.password or "@" in (parsed.netloc or ""):
        host = parsed.hostname or "unknown"
        port = f":{parsed.port}" if parsed.port else ""
        netloc = f"***@{host}{port}"
        return urlunparse((parsed.scheme, netloc, parsed.path, "", parsed.query, ""))
    return url


def parse_json_dict(raw: Optional[str]) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {"_value": data}
    except json.JSONDecodeError:
        return {"_raw": raw}


def analysis_from_json(raw: Optional[str]) -> Optional[RiskItemAnalysis]:
    if not raw:
        return None
    try:
        return RiskItemAnalysis.model_validate_json(raw)
    except Exception:
        return None


def evidence_view(evidence_json: Optional[str]) -> dict[str, Any]:
    data = parse_json_dict(evidence_json)
    if "_raw" in data:
        return {"parse_error": True, "raw": data["_raw"], "version": {}, "content": [], "warnings": []}
    return {
        "parse_error": False,
        "raw": None,
        "version": data.get("version") or {},
        "content": data.get("content") or [],
        "warnings": data.get("warnings") or [],
    }


def analysis_view(analysis: Optional[RiskItemAnalysis], raw_json: Optional[str] = None) -> dict[str, Any]:
    if analysis is None:
        parsed = parse_json_dict(raw_json)
        return {
            "ok": False,
            "raw_fallback": parsed.get("_raw") or json.dumps(parsed, ensure_ascii=False, indent=2),
        }
    opts = analysis.remediation_options
    return {
        "ok": True,
        "title": analysis.title,
        "cve_ids": analysis.cve_ids,
        "severity": analysis.severity.value,
        "severity_zh": severity_zh(analysis.severity),
        "score": analysis.score,
        "score_source": analysis.score_source,
        "business_impact": analysis.business_impact,
        "technical_summary": analysis.technical_summary,
        "narrative": analysis.narrative,
        "remediation_offer": analysis.remediation_offer.value,
        "has_isolated_patch": opts.has_isolated_patch,
        "upgrade_available": opts.upgrade_available,
        "recommended_min_versions": opts.recommended_min_versions,
        "remediation_notes": opts.notes,
        "packages": [p.model_dump() for p in analysis.packages],
        "fingerprints": [f.model_dump() for f in analysis.fingerprints],
        "materials": [m.model_dump() for m in analysis.materials],
        "confidence": analysis.confidence,
        "source_missing": analysis.source_missing,
        "raw": analysis.raw,
    }


def finding_view(row: dict[str, Any]) -> dict[str, Any]:
    status = row.get("remediation_status") or "unknown"
    snap = analysis_from_json(row.get("analysis_snapshot_json"))
    analysis = analysis_view(snap, row.get("analysis_snapshot_json"))
    risk_id = row.get("risk_id") or ""
    raw_title = analysis.get("title") if analysis.get("ok") else risk_id
    cve_ids = analysis.get("cve_ids") if analysis.get("ok") else []
    raw_meta = analysis.get("raw") if analysis.get("ok") else {}
    if not isinstance(raw_meta, dict):
        raw_meta = {}
    title = display_risk_title(
        raw_title,
        risk_id=risk_id,
        cve_ids=cve_ids if isinstance(cve_ids, list) else [],
        vuln_category=raw_meta.get("vuln_category"),
        vuln_impact=raw_meta.get("vuln_impact"),
    )
    if analysis.get("ok"):
        analysis = {**analysis, "title": title}
    severity = analysis.get("severity") if analysis.get("ok") else "unknown"
    # Display: treat inconclusive the same as unfixed.
    badge_status = "vulnerable" if status == "unknown" else status
    return {
        "id": row.get("id"),
        "project_id": row.get("project_id"),
        "risk_id": risk_id,
        "remediation_status": badge_status,
        "remediation_status_raw": status,
        "remediation_status_zh": status_zh(status),
        "fix_method": row.get("fix_method"),
        "fix_method_zh": fix_method_zh(row.get("fix_method") or "unknown"),
        "evidence_fingerprint": row.get("evidence_fingerprint"),
        "created_at": row.get("created_at"),
        "report_path": row.get("report_path"),
        "project_narrative": row.get("project_narrative"),
        "evidence": evidence_view(row.get("evidence_json")),
        "analysis": analysis,
        "title": title,
        "show_risk_id": _norm_risk_label(title) != _norm_risk_label(risk_id),
        "severity": severity,
        "severity_zh": severity_zh(Severity(severity)) if severity in Severity._value2member_map_ else severity,
        "is_open": status in OPEN_STATUSES,
        "is_closed": status in CLOSED_STATUSES,
    }


def format_date_ymd(value: Any) -> str:
    """ISO / datetime-ish → YYYY-MM-DD for display."""
    if value is None:
        return "—"
    text = str(value).strip()
    if not text:
        return "—"
    if len(text) >= 10 and text[4] == "-" and text[7] == "-":
        return text[:10]
    return text[:10] if len(text) >= 10 else text


def _norm_risk_label(value: str) -> str:
    """Collapse 'APSB26-73 CVE-…' vs 'APSB26-73:CVE-…' for duplicate checks."""
    return "".join(ch for ch in (value or "").upper() if ch.isalnum() or ch == "-")


def risk_row_view(row: dict[str, Any]) -> dict[str, Any]:
    analysis_model = analysis_from_json(row.get("analysis_json"))
    analysis = analysis_view(analysis_model, row.get("analysis_json"))
    risk_id = row["risk_id"]
    raw_title = analysis.get("title") if analysis.get("ok") else risk_id
    cve_ids = analysis.get("cve_ids") if analysis.get("ok") else []
    raw_meta = analysis.get("raw") if analysis.get("ok") else {}
    if not isinstance(raw_meta, dict):
        raw_meta = {}
    title = display_risk_title(
        raw_title,
        risk_id=risk_id,
        cve_ids=cve_ids if isinstance(cve_ids, list) else [],
        bulletin_id=row.get("bulletin_external_id"),
        vuln_category=raw_meta.get("vuln_category"),
        vuln_impact=raw_meta.get("vuln_impact"),
    )
    if analysis.get("ok"):
        analysis = {**analysis, "title": title}
    return {
        "risk_id": risk_id,
        "bulletin_external_id": row["bulletin_external_id"],
        "report_path": row.get("report_path"),
        "created_at": format_date_ymd(row.get("created_at")),
        "updated_at": format_date_ymd(row.get("updated_at")),
        "analysis": analysis,
        "title": title,
        "show_risk_id": True,
        "cve_ids": cve_ids if analysis.get("ok") else [],
        "severity": analysis.get("severity") if analysis.get("ok") else "unknown",
        "severity_zh": analysis.get("severity_zh") if analysis.get("ok") else "未知",
        "score": analysis.get("score") if analysis.get("ok") else None,
        "has_isolated_patch": analysis.get("has_isolated_patch") if analysis.get("ok") else False,
        "upgrade_available": analysis.get("upgrade_available") if analysis.get("ok") else False,
        "recommended_min_versions": (
            composer_recommendable_versions(analysis.get("recommended_min_versions") or [])
            if analysis.get("ok")
            else []
        ),
        "confidence": analysis.get("confidence") if analysis.get("ok") else None,
        "source_missing": analysis.get("source_missing") if analysis.get("ok") else [],
    }


def report_web_path(report_path: Optional[str], reports_root: Path) -> Optional[str]:
    """Map absolute report path under reports_root to /files/... URL."""
    if not report_path:
        return None
    try:
        path = Path(report_path).resolve()
        root = reports_root.resolve()
        rel = path.relative_to(root)
    except (ValueError, OSError):
        return None
    return "/files/" + rel.as_posix()


def bulletin_view(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("analysis_json")
    analysis: dict[str, Any] | None = None
    if raw:
        try:
            model = BulletinAnalysis.model_validate_json(raw)
            analysis = model.model_dump()
            analysis["ok"] = True
            # Hide Adobe dated Solution labels (2.4.8-2026-jul) from "建议最低版本".
            analysis["recommended_min_versions"] = composer_recommendable_versions(
                analysis.get("recommended_min_versions") or []
            )
        except Exception:  # noqa: BLE001
            analysis = {"ok": False, "raw_fallback": str(raw)}
    else:
        analysis = {"ok": False}
    return {
        "external_id": row["external_id"],
        "title": row.get("title") or row["external_id"],
        "published_at": format_date_ymd(row.get("published_at")) if row.get("published_at") else None,
        "url": row.get("url"),
        "updated_at": format_date_ymd(row.get("updated_at")),
        "risk_count": row.get("risk_count") or 0,
        "analysis": analysis,
    }
