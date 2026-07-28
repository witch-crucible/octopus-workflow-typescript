from __future__ import annotations

import logging
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

from magento_security_watcher import __version__
from magento_security_watcher.config import (
    default_root,
    ensure_data_dirs,
    load_env_secrets,
    load_projects,
    load_settings,
)
from magento_security_watcher.ingest import IngestService, parse_risk_id_filters
from magento_security_watcher.notify import WeComNotifier
from magento_security_watcher.scan import ScanService
from magento_security_watcher.store import Store

console = Console()


def _configure_logging(verbose: bool = False) -> None:
    """Ensure LLM prompt logs (logger.info) appear when running msw commands."""
    level = logging.DEBUG if verbose else logging.INFO
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(
            level=level,
            format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        )
    else:
        root.setLevel(level)
    # Package loggers should not be silenced by libraries.
    logging.getLogger("magento_security_watcher").setLevel(level)


def _ctx_paths(ctx: click.Context) -> tuple[Path, Path]:
    root: Path = ctx.obj["root"]
    config_dir: Path = ctx.obj["config_dir"]
    return root, config_dir


@click.group()
@click.option(
    "--root",
    type=click.Path(path_type=Path, file_okay=False),
    default=None,
    help="Project root (default: cwd or MSW_ROOT)",
)
@click.option(
    "--config-dir",
    type=click.Path(path_type=Path, file_okay=False),
    default=None,
    help="Config directory containing settings.yaml and projects.yaml",
)
@click.option("-v", "--verbose", is_flag=True, help="Enable DEBUG logging (also: msw -v scan)")
@click.pass_context
def main(
    ctx: click.Context,
    root: Path | None,
    config_dir: Path | None,
    verbose: bool,
) -> None:
    """Magento2 Security Watcher CLI."""
    _configure_logging(verbose=verbose)
    root = (root or default_root()).resolve()
    config_dir = (config_dir or (root / "config")).resolve()
    ctx.ensure_object(dict)
    ctx.obj["root"] = root
    ctx.obj["config_dir"] = config_dir
    ctx.obj["verbose"] = verbose


@main.command("ingest")
@click.option("--notify-new", is_flag=True, help="Notify WeCom for newly created RiskItems")
@click.option(
    "--from-html",
    "html_file",
    type=click.Path(path_type=Path, exists=True, dir_okay=False),
    default=None,
    help="Use a browser-saved Magento security index HTML instead of fetching Adobe",
)
@click.option(
    "--skip-existing",
    is_flag=True,
    help="Skip RiskItems already in DB (no NVD/LLM re-enrichment or overwrite)",
)
@click.option(
    "--risks",
    multiple=True,
    help=(
        "Only ingest these risk_id(s). Repeat flag and/or comma-separate, "
        "e.g. --risks APSB26-73:CVE-2026-48371 --risks APSB24-61:CVE-2024-39397"
    ),
)
@click.pass_context
def ingest_cmd(
    ctx: click.Context,
    notify_new: bool,
    html_file: Path | None,
    skip_existing: bool,
    risks: tuple[str, ...],
) -> None:
    """Fetch bulletins, enrich RiskItems, write reports."""
    root, config_dir = _ctx_paths(ctx)
    settings = load_settings(config_dir, root)
    paths = ensure_data_dirs(settings)
    store = Store(settings.db_path)
    secrets = load_env_secrets(root)
    notifier = WeComNotifier(
        secrets.wecom_webhook_url,
        enabled=settings.wecom.enabled,
        mention_all_on_critical=settings.wecom.mention_all_on_critical,
    )
    service = IngestService(settings, store, paths, secrets)
    result = service.run(
        notify_new=notify_new,
        notifier=notifier,
        html_file=html_file,
        skip_existing=skip_existing,
        risk_ids=parse_risk_id_filters(list(risks) if risks else None),
    )
    console.print(f"[green]ingest complete[/green] {result}")


@main.command("scan")
@click.option("--notify/--no-notify", default=None, help="Send WeCom alerts for changed findings")
@click.option(
    "--full",
    is_flag=True,
    help="Rescan all risks (do not skip previously fixed / not_applicable)",
)
@click.option("--project", "project_ids", multiple=True, help="Limit to project id(s)")
@click.option(
    "--local-workspace",
    type=click.Path(path_type=Path, exists=True, file_okay=False),
    default=None,
    help="Use a local directory instead of git (single --project required)",
)
@click.option(
    "-v",
    "--verbose",
    is_flag=True,
    help="DEBUG logs: each risk verdict, git commands, package sample",
)
@click.pass_context
def scan_cmd(
    ctx: click.Context,
    notify: bool | None,
    full: bool,
    project_ids: tuple[str, ...],
    local_workspace: Path | None,
    verbose: bool,
) -> None:
    """Scan configured Magento projects against stored RiskItems (incremental by default)."""
    if verbose or ctx.obj.get("verbose"):
        _configure_logging(verbose=True)
    root, config_dir = _ctx_paths(ctx)
    settings = load_settings(config_dir, root)
    projects = load_projects(config_dir)
    if project_ids:
        wanted = set(project_ids)
        projects = [p for p in projects if p.id in wanted]
    if local_workspace is not None:
        if len(projects) != 1:
            raise click.UsageError("--local-workspace requires exactly one matching --project")
    do_notify = settings.scan.notify_on_complete if notify is None else notify
    service = ScanService(
        settings, Store(settings.db_path), ensure_data_dirs(settings), load_env_secrets(root)
    )
    local_map = {projects[0].id: local_workspace} if local_workspace is not None else None
    result = service.scan_projects(
        projects, notify=do_notify, full=full, local_workspaces=local_map
    )
    console.print(f"[green]scan complete[/green] {result}")


@main.command("notify")
@click.option("--project", "project_ids", multiple=True)
@click.pass_context
def notify_cmd(ctx: click.Context, project_ids: tuple[str, ...]) -> None:
    """Re-scan projects and notify on state changes (same as ``scan --notify``)."""
    ctx.invoke(scan_cmd, notify=True, full=False, project_ids=project_ids, local_workspace=None)


@main.command("notify-pending")
@click.option("--project", "project_ids", multiple=True, help="Limit to project id(s)")
@click.pass_context
def notify_pending_cmd(ctx: click.Context, project_ids: tuple[str, ...]) -> None:
    """Send WeCom alerts for latest findings without scanning (alert_state dedupe)."""
    from magento_security_watcher.notify import WeComNotifier, notify_pending

    root, config_dir = _ctx_paths(ctx)
    settings = load_settings(config_dir, root)
    projects = load_projects(config_dir)
    if project_ids:
        wanted = set(project_ids)
        projects = [p for p in projects if p.id in wanted]
    secrets = load_env_secrets(root)
    notifier = WeComNotifier(
        secrets.wecom_webhook_url,
        enabled=settings.wecom.enabled,
        mention_all_on_critical=settings.wecom.mention_all_on_critical,
    )
    names = {p.id: (p.name or p.id) for p in projects}
    result = notify_pending(
        Store(settings.db_path),
        notifier,
        project_ids=[p.id for p in projects] if project_ids else None,
        project_names=names,
    )
    console.print(f"[green]notify-pending complete[/green] {result}")


@main.command("clear")
@click.option(
    "--risks",
    multiple=True,
    help="Delete these risk_id(s) and related findings. Repeat or comma-separate.",
)
@click.option(
    "--year-mismatch",
    is_flag=True,
    help="Delete risks whose CVE year is far from the APSB year (e.g. APSB20 + CVE-2024).",
)
@click.option(
    "--placeholders",
    is_flag=True,
    help="Delete list-page placeholder shells (no CVE/packages).",
)
@click.option("--yes", "assume_yes", is_flag=True, help="Do not prompt for confirmation")
@click.pass_context
def clear_cmd(
    ctx: click.Context,
    risks: tuple[str, ...],
    year_mismatch: bool,
    placeholders: bool,
    assume_yes: bool,
) -> None:
    """Remove RiskItems (and their findings) from the database."""
    if not risks and not year_mismatch and not placeholders:
        raise click.UsageError("Specify --risks and/or --year-mismatch and/or --placeholders")

    root, config_dir = _ctx_paths(ctx)
    settings = load_settings(config_dir, root)
    store = Store(settings.db_path)

    targets: list[str] = []
    if risks:
        from magento_security_watcher.ingest import parse_risk_id_filters

        parsed = parse_risk_id_filters(list(risks)) or set()
        # Preserve DB casing by resolving against existing rows.
        existing = {r["risk_id"].upper(): r["risk_id"] for r in store.list_risk_item_rows()}
        for rid in sorted(parsed):
            if rid in existing:
                targets.append(existing[rid])
            else:
                console.print(f"[yellow]not found[/yellow] {rid}")
    if year_mismatch:
        targets.extend(store.list_year_mismatched_risk_ids())
    if placeholders:
        # Preview via same predicate without deleting yet.
        for row in store.list_risk_item_rows():
            try:
                from magento_security_watcher.models import RiskItemAnalysis
                from magento_security_watcher.store import _is_placeholder_analysis

                analysis = RiskItemAnalysis.model_validate_json(row["analysis_json"])
            except Exception:  # noqa: BLE001
                continue
            if _is_placeholder_analysis(row["risk_id"], analysis):
                targets.append(row["risk_id"])

    # Dedupe preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for rid in targets:
        if rid not in seen:
            seen.add(rid)
            unique.append(rid)
    targets = unique

    if not targets:
        console.print("[green]nothing to clear[/green]")
        return

    console.print(f"Will delete {len(targets)} risk_item(s) (+ findings):")
    for rid in targets[:50]:
        console.print(f"  - {rid}")
    if len(targets) > 50:
        console.print(f"  … and {len(targets) - 50} more")

    if not assume_yes and not click.confirm("Proceed?"):
        console.print("aborted")
        return

    removed = store.delete_risk_items(targets)
    console.print(f"[green]cleared[/green] {len(removed)} risk_item(s)")


@main.command("status")
@click.option("--limit", default=20, show_default=True)
@click.pass_context
def status_cmd(ctx: click.Context, limit: int) -> None:
    """Show DB summary and recent findings."""
    root, config_dir = _ctx_paths(ctx)
    settings = load_settings(config_dir, root)
    store = Store(settings.db_path)
    summary = store.summary()
    console.print(
        f"bulletins={summary['bulletins']} risk_items={summary['risk_items']} "
        f"findings={summary['findings']} scan_runs={summary['scan_runs']}"
    )
    rows = store.recent_findings(limit=limit)
    table = Table(title="Recent findings")
    table.add_column("project")
    table.add_column("risk")
    table.add_column("status")
    table.add_column("fix")
    table.add_column("when")
    for r in rows:
        table.add_row(
            r["project_id"],
            r["risk_id"],
            r["remediation_status"],
            r["fix_method"],
            r["created_at"],
        )
    console.print(table)


@main.command("serve")
@click.option("--host", default=None, help="Bind host (default: settings.web.host)")
@click.option("--port", default=None, type=int, help="Bind port (default: settings.web.port)")
@click.pass_context
def serve_cmd(ctx: click.Context, host: str | None, port: int | None) -> None:
    """Start the read-only web dashboard (FastAPI + uvicorn)."""
    root, config_dir = _ctx_paths(ctx)
    settings = load_settings(config_dir, root)
    ensure_data_dirs(settings)
    bind_host = host or settings.web.host
    bind_port = port if port is not None else settings.web.port
    try:
        import uvicorn
    except ImportError as exc:  # pragma: no cover
        raise click.ClickException("uvicorn is required: pip install -e .") from exc

    from magento_security_watcher.web.app import create_app

    app = create_app(root=root, config_dir=config_dir, settings=settings)
    console.print(
        f"[green]MSW dashboard[/green] http://{bind_host}:{bind_port}/ "
        f"(IP allowlist: {settings.web.allowed_cidrs or 'loopback only'})"
    )
    uvicorn.run(app, host=bind_host, port=bind_port, log_level="info")


if __name__ == "__main__":
    main()
