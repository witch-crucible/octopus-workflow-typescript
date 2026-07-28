"""FastAPI route handlers for the read-only dashboard."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from magento_security_watcher.config import load_projects
from magento_security_watcher.models import BulletinAnalysis, RiskItemAnalysis, Severity
from magento_security_watcher.notify import (
    finding_from_row,
    notify_bulletin,
    notify_project,
)
from magento_security_watcher.store import _risk_official_sort_key
from magento_security_watcher.web.presenters import (
    CLOSED_STATUSES,
    OPEN_STATUSES,
    bulletin_view,
    finding_view,
    redact_git_url,
    report_web_path,
    risk_row_view,
)

router = APIRouter()


def _templates(request: Request) -> Jinja2Templates:
    return request.app.state.templates


def _store(request: Request):
    return request.app.state.store


def _reports_root(request: Request) -> Path:
    return Path(request.app.state.reports_root)


def _render(request: Request, name: str, **extra: Any) -> HTMLResponse:
    ctx = {"nav": request.url.path}
    ctx.update(extra)
    return _templates(request).TemplateResponse(request, name, ctx)


@router.get("/health")
def health() -> dict[str, bool]:
    """Liveness probe; subject to the same IP allowlist as other routes."""
    return {"ok": True}


@router.get("/", response_class=HTMLResponse)
def dashboard(request: Request) -> HTMLResponse:
    store = _store(request)
    summary = store.summary()
    status_counts = store.count_latest_by_status()
    fixed_count = int(status_counts.get("fixed") or 0)
    open_fix_count = int(status_counts.get("vulnerable") or 0) + int(
        status_counts.get("unknown") or 0
    )

    projects = load_projects(request.app.state.config_dir)
    open_by_project: dict[str, int] = {}
    for row in store.list_latest_findings():
        if row.get("remediation_status") not in ("vulnerable", "unknown"):
            continue
        pid = row.get("project_id") or ""
        open_by_project[pid] = open_by_project.get(pid, 0) + 1
    at_risk = sum(1 for p in projects if open_by_project.get(p.id, 0) > 0)
    project_summary = {
        "total": len(projects),
        "at_risk": at_risk,
    }

    recent = store.recent_findings(limit=12)
    return _render(
        request,
        "dashboard.html",
        summary=summary,
        fixed_count=fixed_count,
        open_fix_count=open_fix_count,
        project_summary=project_summary,
        recent_findings=recent,
    )


@router.get("/projects", response_class=HTMLResponse)
def projects_list(request: Request) -> HTMLResponse:
    store = _store(request)
    projects = load_projects(request.app.state.config_dir)
    rows = []
    for p in projects:
        counts = store.count_latest_by_status(project_id=p.id)
        last_scan = store.latest_scan_run(p.id)
        alert = store.latest_alert_for_project(p.id)
        open_n = counts["vulnerable"] + counts["unknown"] + counts["error"]
        if alert and alert.get("last_notified_at"):
            notify_label = f"已通知 {alert['last_notified_at']}"
            notify_kind = "ok"
        elif open_n > 0:
            notify_label = "有未修复且无通知记录"
            notify_kind = "warn"
        else:
            notify_label = "—"
            notify_kind = "muted"
        rows.append(
            {
                "id": p.id,
                "name": p.name or p.id,
                "enabled": p.enabled,
                "owners": p.owners,
                "branch": p.branch,
                "git_display": redact_git_url(p.git_url),
                "counts": counts,
                "open_n": open_n,
                "last_scan": last_scan,
                "notify_label": notify_label,
                "notify_kind": notify_kind,
            }
        )
    return _render(request, "projects.html", projects=rows)


@router.get("/projects/{project_id}", response_class=HTMLResponse)
def project_detail(request: Request, project_id: str) -> HTMLResponse:
    store = _store(request)
    projects = {p.id: p for p in load_projects(request.app.state.config_dir)}
    project = projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    findings = [finding_view(r) for r in store.list_latest_findings(project_id=project_id)]
    for f in findings:
        f["report_url"] = report_web_path(f.get("report_path"), _reports_root(request))

    open_findings = [f for f in findings if f["remediation_status"] in OPEN_STATUSES]
    closed_findings = [f for f in findings if f["remediation_status"] in CLOSED_STATUSES]
    other = [
        f
        for f in findings
        if f["remediation_status"] not in OPEN_STATUSES and f["remediation_status"] not in CLOSED_STATUSES
    ]
    open_findings.extend(other)
    # Newest Adobe bulletin / CVE first (same order as /risks).
    open_findings.sort(key=_risk_official_sort_key, reverse=True)
    closed_findings.sort(key=_risk_official_sort_key, reverse=True)

    return _render(
        request,
        "project_detail.html",
        project={
            "id": project.id,
            "name": project.name or project.id,
            "enabled": project.enabled,
            "owners": project.owners,
            "branch": project.branch,
            "git_display": redact_git_url(project.git_url),
            "profile": project.profile,
        },
        last_scan=store.latest_scan_run(project_id),
        alerts=store.list_alert_state(project_id=project_id, limit=20),
        scan_runs=store.list_scan_runs(project_id=project_id, limit=15),
        open_findings=open_findings,
        closed_findings=closed_findings,
        counts=store.count_latest_by_status(project_id=project_id),
    )


@router.get("/projects/{project_id}/export")
def project_export(project_id: str) -> RedirectResponse:
    """Compat: old export URL → project page with print dialog."""
    return RedirectResponse(url=f"/projects/{project_id}?print=1", status_code=302)


@router.post("/projects/{project_id}/notify")
def project_notify(request: Request, project_id: str) -> JSONResponse:
    """Force-send one aggregate WeCom notification for this project."""
    from magento_security_watcher.notify import _console

    store = _store(request)
    projects = {p.id: p for p in load_projects(request.app.state.config_dir)}
    project = projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    notifier = request.app.state.make_notifier()
    _console(
        f"manual project notify id={project_id} "
        f"enabled={notifier.enabled} webhook={bool(notifier.webhook_url)}"
    )
    if not notifier.enabled:
        _console("manual project notify aborted: wecom disabled or missing webhook")
        return JSONResponse(
            {"ok": False, "message": "企微未启用或缺少 Webhook"},
            status_code=503,
        )
    findings = [
        finding_from_row(r) for r in store.list_latest_findings(project_id=project_id)
    ]
    _console(f"manual project notify findings={len(findings)}")
    ok = notify_project(
        store,
        notifier,
        findings,
        project_id=project.id,
        project_name=project.name or project.id,
        force=True,
    )
    if not ok:
        detail = notifier.last_error or "企微接口未成功"
        _console(f"manual project notify failed: {detail}")
        return JSONResponse(
            {"ok": False, "message": f"发送失败：{detail}"},
            status_code=502,
        )
    _console("manual project notify ok")
    return JSONResponse({"ok": True, "message": "已发送到企微"})


@router.get("/bulletins/{external_id}/export")
def bulletin_export(external_id: str) -> RedirectResponse:
    """Compat shortcut → bulletin page with print dialog."""
    return RedirectResponse(url=f"/bulletins/{external_id}?print=1", status_code=302)


@router.get("/risks", response_class=HTMLResponse)
def risks_list(
    request: Request,
    severity: Optional[str] = Query(None),
    has_cve: Optional[str] = Query(None),
    has_source_missing: Optional[str] = Query(None),
) -> HTMLResponse:
    store = _store(request)
    rows = [risk_row_view(r) for r in store.list_risk_item_rows()]
    if severity:
        rows = [r for r in rows if r.get("severity") == severity]
    if has_cve == "1":
        rows = [r for r in rows if r.get("cve_ids")]
    elif has_cve == "0":
        rows = [r for r in rows if not r.get("cve_ids")]
    if has_source_missing == "1":
        rows = [r for r in rows if r.get("source_missing")]
    elif has_source_missing == "0":
        rows = [r for r in rows if not r.get("source_missing")]
    return _render(
        request,
        "risks.html",
        risks=rows,
        filters={
            "severity": severity or "",
            "has_cve": has_cve or "",
            "has_source_missing": has_source_missing or "",
        },
    )


@router.get("/risks/{risk_id}", response_class=HTMLResponse)
def risk_detail(request: Request, risk_id: str) -> HTMLResponse:
    store = _store(request)
    row = store.get_risk_item_row(risk_id)
    if not row:
        raise HTTPException(status_code=404, detail="Risk item not found")
    view = risk_row_view(row)
    view["report_url"] = report_web_path(view.get("report_path"), _reports_root(request))
    return _render(request, "risk_detail.html", risk=view)


@router.get("/bulletins", response_class=HTMLResponse)
def bulletins_list(request: Request) -> HTMLResponse:
    store = _store(request)
    return _render(request, "bulletins.html", bulletins=store.list_bulletins())


@router.get("/bulletins/{external_id}", response_class=HTMLResponse)
def bulletin_detail(request: Request, external_id: str) -> HTMLResponse:
    store = _store(request)
    row = store.get_bulletin(external_id)
    if not row:
        raise HTTPException(status_code=404, detail="Bulletin not found")
    bulletin = bulletin_view(row)
    risks = [risk_row_view(r) for r in store.list_risk_item_rows_for_bulletin(external_id)]
    return _render(
        request,
        "bulletin_detail.html",
        bulletin=bulletin,
        risks=risks,
    )


@router.post("/bulletins/{external_id}/notify")
def bulletin_notify(request: Request, external_id: str) -> JSONResponse:
    """Force-send one bulletin-level WeCom notification (no CVE list)."""
    from magento_security_watcher.notify import _console

    store = _store(request)
    row = store.get_bulletin(external_id)
    if not row:
        raise HTTPException(status_code=404, detail="Bulletin not found")
    notifier = request.app.state.make_notifier()
    _console(
        f"manual bulletin notify id={external_id} "
        f"enabled={notifier.enabled} webhook={bool(notifier.webhook_url)}"
    )
    if not notifier.enabled:
        _console("manual bulletin notify aborted: wecom disabled or missing webhook")
        return JSONResponse(
            {"ok": False, "message": "企微未启用或缺少 Webhook"},
            status_code=503,
        )
    analysis = None
    raw = row.get("analysis_json")
    if raw:
        try:
            analysis = BulletinAnalysis.model_validate_json(raw)
        except Exception:  # noqa: BLE001
            analysis = None
    risks = store.list_risk_item_rows_for_bulletin(external_id)
    has_critical = False
    for r in risks:
        try:
            item = RiskItemAnalysis.model_validate_json(r["analysis_json"])
            if item.severity == Severity.CRITICAL:
                has_critical = True
                break
        except Exception:  # noqa: BLE001
            continue
    _console(f"manual bulletin notify risks={len(risks)} has_critical={has_critical}")
    ok = notify_bulletin(
        store,
        notifier,
        external_id=external_id,
        title=row.get("title") or external_id,
        analysis=analysis,
        created_count=0,
        has_critical=has_critical,
        force=True,
    )
    if not ok:
        detail = notifier.last_error or "企微接口未成功"
        _console(f"manual bulletin notify failed: {detail}")
        return JSONResponse(
            {"ok": False, "message": f"发送失败：{detail}"},
            status_code=502,
        )
    _console("manual bulletin notify ok")
    return JSONResponse({"ok": True, "message": "已发送到企微"})


@router.get("/files/{file_path:path}")
def serve_report(request: Request, file_path: str) -> FileResponse:
    root = _reports_root(request).resolve()
    target = (root / file_path).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Path not allowed") from exc
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(target)


@router.get("/api/status")
def api_status(request: Request) -> JSONResponse:
    return JSONResponse(_store(request).summary())
