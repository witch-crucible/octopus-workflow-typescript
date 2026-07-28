from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import httpx

from magento_security_watcher.browser_identity import BROWSER_USER_AGENT, browser_headers
from magento_security_watcher.config import AppSettings, EnvSecrets, ensure_data_dirs, load_env_secrets
from magento_security_watcher.fingerprint import FingerprintBuilder, write_fingerprint_bundle
from magento_security_watcher.i18n_zh import build_risk_report_md, extract_commerce_versions, strip_html
from magento_security_watcher.llm import LlmClient
from magento_security_watcher.magento_version import composer_recommendable_versions
from magento_security_watcher.models import (
    BulletinAnalysis,
    ContentFingerprint,
    RemediationOffer,
    RemediationOptions,
    RiskItemAnalysis,
    RiskItemRecord,
    Severity,
    SourceMaterial,
)
from magento_security_watcher.patch_artifacts import (
    download_patch_zip,
    extract_patch_texts_from_zip,
    prefer_zip_urls,
    zip_cache_path,
)
from magento_security_watcher.sources import (
    FixtureAdvisorySource,
    HtmlBulletinSource,
    LocalHtmlIndexSource,
    NvdClient,
    nvd_description,
    options_from_offer,
    seed_to_analysis,
    severity_from_nvd,
)
from magento_security_watcher.store import Store, dump_json, _is_placeholder_analysis


_APSB_ID_RE = re.compile(r"^APSB(\d{2})-\d+$", re.IGNORECASE)
_CVE_ID_RE = re.compile(r"^CVE-(\d{4})-\d+$", re.IGNORECASE)
_MIN_ASSIST_BODY = 500


def parse_risk_id_filters(values: Optional[List[str]] = None) -> Optional[Set[str]]:
    """Parse CLI --risks values (repeatable and/or comma-separated) into uppercased ids."""
    if not values:
        return None
    out: Set[str] = set()
    for raw in values:
        for part in re.split(r"[\s,;]+", str(raw).strip()):
            part = part.strip()
            if part:
                out.add(part.upper())
    return out or None


def bulletin_body_ready_for_assist(raw_text: str) -> bool:
    """True when bulletin HTML/text is substantial enough for LLM structure assist."""
    text = strip_html(raw_text or "", 20000)
    if len(text) < _MIN_ASSIST_BODY:
        return False
    return bool(
        re.search(
            r"CVE-\d{4}-\d+|Vulnerability Details|Affected Versions|Security [Uu]pdate",
            text,
        )
    )


def _apsb_year(bulletin_id: str) -> Optional[int]:
    m = _APSB_ID_RE.match((bulletin_id or "").strip())
    if not m:
        return None
    return 2000 + int(m.group(1))


def _cve_year(cve_id: str) -> Optional[int]:
    m = _CVE_ID_RE.match((cve_id or "").strip())
    return int(m.group(1)) if m else None


def seed_belongs_to_bulletin(
    seed: Dict[str, Any],
    *,
    bulletin_id: str,
    raw_text: str,
) -> bool:
    """
    Drop invented / cross-wired CVE seeds.
    - Every CVE must appear in the bulletin body when body is present.
    - CVE calendar year must be within ±1 of APSB year (skip synthetic APSB99+ fixtures).
    """
    cves = [str(c).upper() for c in (seed.get("cve_ids") or []) if c]
    if not cves:
        return True
    body = (raw_text or "").upper()
    body_plain = strip_html(raw_text or "", 50000).upper()
    apsb_y = _apsb_year(bulletin_id)
    for cve in cves:
        if body and cve not in body and cve not in body_plain:
            return False
        if not body and not body_plain:
            # No bulletin text → never accept CVE seeds (blocks empty-shell invent).
            return False
        cy = _cve_year(cve)
        if apsb_y is not None and cy is not None and apsb_y <= 2035:
            if abs(cy - apsb_y) > 1:
                return False
    return True


class IngestService:
    def __init__(
        self,
        settings: AppSettings,
        store: Store,
        paths: Dict[str, Path],
        secrets: Optional[EnvSecrets] = None,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        self.settings = settings
        self.store = store
        self.paths = paths
        self.secrets = secrets or load_env_secrets()
        timeout = settings.advisory.request_timeout_seconds
        self.http = http_client or httpx.Client(
            timeout=timeout,
            headers=browser_headers(settings.advisory.user_agent or BROWSER_USER_AGENT),
            follow_redirects=True,
            http2=False,
            trust_env=True,
        )
        self.llm = LlmClient(
            api_base=settings.llm.api_base,
            api_key=self.secrets.llm_api_key,
            model=settings.llm.model,
            timeout=settings.llm.timeout_seconds,
            enabled=settings.llm.enabled,
            client=self.http,
            log_dir=paths.get("llm_logs"),
        )
        self.fp_builder = FingerprintBuilder(llm_client=self.llm if self.llm.enabled else None)
        self.nvd = (
            NvdClient(
                api_base=settings.nvd.api_base,
                api_key=self.secrets.nvd_api_key,
                delay=settings.nvd.request_delay_seconds,
                client=self.http,
                cache_dir=paths.get("nvd_cache") or (paths["data"] / "cache" / "nvd"),
                cache_ttl_days=settings.nvd.cache_ttl_days,
                use_stale_on_rate_limit=settings.nvd.use_stale_on_rate_limit,
            )
            if settings.nvd.enabled
            else None
        )

    def _source(self, html_file: Optional[Path] = None):
        if self.settings.advisory.fixture_dir:
            return FixtureAdvisorySource(Path(self.settings.advisory.fixture_dir))
        local_html = html_file
        if local_html is None and self.settings.advisory.local_index_html:
            local_html = Path(self.settings.advisory.local_index_html)
        if local_html is not None:
            return LocalHtmlIndexSource(
                local_html,
                list_url=self.settings.advisory.bulletin_list_url,
                detail_fetch_limit=0,
                user_agent=self.settings.advisory.user_agent,
            )
        return HtmlBulletinSource(
            list_url=self.settings.advisory.bulletin_list_url,
            user_agent=self.settings.advisory.user_agent,
            client=self.http,
            detail_fetch_limit=self.settings.advisory.detail_fetch_limit,
            timeout=self.settings.advisory.request_timeout_seconds,
            follow_release_notes=self.settings.advisory.follow_release_notes,
            kb_fetch_limit_per_bulletin=self.settings.advisory.kb_fetch_limit_per_bulletin,
        )

    def run(
        self,
        *,
        notify_new: bool = False,
        notifier: Any = None,
        html_file: Optional[Path] = None,
        skip_existing: bool = False,
        risk_ids: Optional[Set[str]] = None,
    ) -> Dict[str, int]:
        # Drop historical list-page shells left from older ingest versions.
        purged = self.store.purge_placeholder_risk_items()
        if purged:
            self.store.log("ingest", "info", f"purged placeholder risk_items={len(purged)}")

        risk_filter = {r.upper() for r in risk_ids} if risk_ids else None
        source = self._source(html_file=html_file)
        bulletins = source.list_bulletins()
        if risk_filter:
            wanted_apsb = {rid.split(":", 1)[0] for rid in risk_filter}
            bulletins = [b for b in bulletins if b.external_id.upper() in wanted_apsb]
            # Targeted risks may be outside detail_fetch_limit — enrich those bulletins now.
            for bulletin in bulletins:
                if bulletin.risk_seeds:
                    continue
                if isinstance(source, HtmlBulletinSource):
                    source._enrich_from_detail(bulletin)
                elif isinstance(source, LocalHtmlIndexSource):
                    source._delegate._enrich_from_detail(bulletin)

        created = 0
        updated = 0
        skipped_shells = 0
        skipped_existing = 0
        skipped_unmatched = 0
        skipped_filter = 0
        for bulletin in bulletins:
            self.store.upsert_bulletin(
                bulletin.external_id,
                bulletin.title,
                bulletin.published_at,
                bulletin.url,
                bulletin.raw_text,
            )
            seeds = list(bulletin.risk_seeds)
            needs_assist = not seeds or all(not s.get("cve_ids") for s in seeds)
            if self.llm.enabled and needs_assist:
                if not bulletin_body_ready_for_assist(bulletin.raw_text or ""):
                    self.store.log(
                        "ingest",
                        "info",
                        f"skip LLM assist_structure for {bulletin.external_id}: "
                        "bulletin body empty/too short (avoid inventing CVEs)",
                    )
                else:
                    try:
                        assisted = self.llm.assist_structure(
                            strip_html(bulletin.raw_text or "", 14000)
                        )
                        if assisted:
                            seeds = assisted
                    except Exception as exc:  # noqa: BLE001
                        self.store.log(
                            "ingest", "warning", f"LLM structure assist failed: {exc}"
                        )

            kept: List[Dict[str, Any]] = []
            for seed in seeds:
                if not seed_belongs_to_bulletin(
                    seed,
                    bulletin_id=bulletin.external_id,
                    raw_text=bulletin.raw_text or "",
                ):
                    skipped_unmatched += 1
                    self.store.log(
                        "ingest",
                        "warning",
                        f"drop seed for {bulletin.external_id}: "
                        f"CVE {seed.get('cve_ids')} not grounded in bulletin body",
                    )
                    continue
                kept.append(seed)
            seeds = kept
            bulletin_created = 0
            bulletin_has_critical = False

            for idx, seed in enumerate(seeds):
                if self._is_placeholder_seed(seed):
                    skipped_shells += 1
                    continue
                analysis = seed_to_analysis(seed, strip_html(bulletin.raw_text or "", 2000))
                risk_id = self._risk_id(bulletin.external_id, analysis, idx)
                if risk_filter and risk_id.upper() not in risk_filter:
                    skipped_filter += 1
                    continue
                if _is_placeholder_analysis(risk_id, analysis):
                    skipped_shells += 1
                    continue
                if skip_existing and self.store.get_risk_item(risk_id) is not None:
                    skipped_existing += 1
                    continue
                # Replace noisy official HTML excerpt with stripped text
                analysis.materials = [
                    SourceMaterial(
                        kind="official",
                        url=bulletin.url,
                        excerpt=strip_html(bulletin.raw_text or "", 6000) or None,
                    )
                ]
                if not analysis.packages:
                    if "adobe_versions" not in analysis.source_missing:
                        analysis.source_missing.append("adobe_versions")
                analysis = self._enrich_nvd(analysis)
                analysis = self._enrich_patches(analysis, seed, risk_id)
                analysis = self._sync_remediation_flags(analysis, seed)
                analysis = self._analyze_with_ai(
                    analysis, bulletin.external_id, risk_id, bulletin.url
                )

                report_path = self._write_risk_report(risk_id, bulletin.external_id, analysis)
                existing = self.store.get_risk_item(risk_id)
                record = RiskItemRecord(
                    risk_id=risk_id,
                    bulletin_external_id=bulletin.external_id,
                    analysis=analysis,
                    report_path=str(report_path),
                )
                self.store.upsert_risk_item(record)
                if existing:
                    updated += 1
                else:
                    created += 1
                    bulletin_created += 1
                    if analysis.severity == Severity.CRITICAL:
                        bulletin_has_critical = True

            bulletin_analysis = self._analyze_bulletin(
                bulletin.external_id,
                bulletin.title,
                bulletin.url,
                bulletin.raw_text or "",
                seeds,
            )
            self.store.update_bulletin_analysis(bulletin.external_id, bulletin_analysis)

            if notify_new and notifier is not None and bulletin_created:
                from magento_security_watcher.notify import notify_bulletin

                notify_bulletin(
                    self.store,
                    notifier,
                    external_id=bulletin.external_id,
                    title=bulletin.title,
                    analysis=bulletin_analysis,
                    created_count=bulletin_created,
                    has_critical=bulletin_has_critical,
                )

            overview = self.paths["reports_bulletins"] / f"{bulletin.external_id}.md"
            overview.write_text(
                self._bulletin_overview_md(
                    bulletin.external_id,
                    bulletin.title,
                    seeds,
                    bulletin_analysis,
                ),
                encoding="utf-8",
            )

        # Final sweep in case any shell slipped through mid-run.
        final_purged = self.store.purge_placeholder_risk_items()
        if final_purged:
            purged.extend(final_purged)
        self.store.log(
            "ingest",
            "info",
            f"ingest done created={created} updated={updated} "
            f"skipped_shells={skipped_shells} skipped_existing={skipped_existing} "
            f"skipped_unmatched={skipped_unmatched} skipped_filter={skipped_filter} "
            f"purged={len(purged)}",
        )
        return {
            "bulletins": len(bulletins),
            "created": created,
            "updated": updated,
            "skipped_shells": skipped_shells,
            "skipped_existing": skipped_existing,
            "skipped_unmatched": skipped_unmatched,
            "skipped_filter": skipped_filter,
            "purged_placeholders": len(set(purged)),
        }

    @staticmethod
    def _is_placeholder_seed(seed: dict[str, Any]) -> bool:
        if seed.get("cve_ids"):
            return False
        if seed.get("packages"):
            return False
        title = (seed.get("title") or "").lower()
        if "security update" in title or "unresolved" in title:
            return True
        # Empty / title-only shell with no actionable fields
        return not title or title.endswith("security update")

    def _risk_id(self, bulletin_id: str, analysis: RiskItemAnalysis, idx: int) -> str:
        if analysis.cve_ids:
            return f"{bulletin_id}:{analysis.cve_ids[0]}"
        slug = analysis.title.lower().replace(" ", "-")[:40]
        return f"{bulletin_id}:{slug or idx}"

    def _enrich_nvd(self, analysis: RiskItemAnalysis) -> RiskItemAnalysis:
        if not self.nvd or not analysis.cve_ids:
            if analysis.cve_ids:
                analysis.source_missing.append("nvd")
            return analysis
        for cve_id in analysis.cve_ids:
            try:
                cve = self.nvd.fetch_cve(cve_id)
            except Exception as exc:  # noqa: BLE001
                self.store.log("ingest", "warning", f"NVD fetch failed {cve_id}: {exc}")
                analysis.source_missing.append(f"nvd:{cve_id}")
                continue
            if not cve:
                analysis.source_missing.append(f"nvd:{cve_id}")
                continue
            sev, score, source = severity_from_nvd(cve)
            if analysis.severity.value == "unknown":
                analysis.severity = sev
            if analysis.score is None:
                analysis.score = score
                analysis.score_source = source
            desc = nvd_description(cve)
            analysis.materials.append(
                SourceMaterial(
                    kind="nvd",
                    url=f"https://nvd.nist.gov/vuln/detail/{cve_id}",
                    excerpt=desc,
                )
            )
            if not analysis.technical_summary and desc:
                analysis.technical_summary = desc
            analysis.confidence = max(analysis.confidence, 0.6)
            # Deterministic upgrade hint from NVD prose (AI may refine versions).
            versions = extract_commerce_versions(desc or "")
            if versions:
                analysis.remediation_options.upgrade_available = True
                if not analysis.remediation_options.recommended_min_versions:
                    # Keep mentioned versions as clues; AI should refine to "fixed" mins.
                    analysis.raw["nvd_mentioned_versions"] = versions
        return analysis

    def _enrich_patches(
        self,
        analysis: RiskItemAnalysis,
        seed: Dict[str, Any],
        risk_id: str,
    ) -> RiskItemAnalysis:
        if seed.get("has_isolated_patch") is True:
            analysis.remediation_options.has_isolated_patch = True

        for kb in seed.get("patch_kb_urls") or []:
            analysis.materials.append(SourceMaterial(kind="patch_kb", url=str(kb)))

        patch_text = seed.get("patch_text")
        patch_url = seed.get("patch_url")
        patch_path = seed.get("patch_path")
        if patch_path:
            p = Path(patch_path)
            if p.is_file():
                patch_text = p.read_text(encoding="utf-8", errors="replace")
        if not patch_text and patch_url:
            try:
                resp = self.http.get(patch_url)
                resp.raise_for_status()
                patch_text = resp.text
            except Exception as exc:  # noqa: BLE001
                self.store.log("ingest", "warning", f"patch download failed: {exc}")

        # Isolated Magento ZIPs from Release Notes (repo.magento.com/patch/*.zip).
        zip_texts: list[str] = []
        if (
            not patch_text
            and self.settings.advisory.download_isolated_patch_zips
            and (seed.get("patch_zip_urls") or [])
        ):
            zip_texts = self._download_isolated_zip_patches(seed, risk_id)
            if zip_texts:
                patch_text = "\n".join(zip_texts)
                analysis.remediation_options.has_isolated_patch = True

        if not patch_text:
            fps = [ContentFingerprint.model_validate(x) for x in (seed.get("fingerprints") or [])]
            if fps:
                analysis.fingerprints = fps
                analysis.remediation_options.has_isolated_patch = True
            elif analysis.remediation_options.has_isolated_patch:
                # We know a patch exists (KB/zip) but have no diff yet.
                if "fingerprints" not in analysis.source_missing:
                    analysis.source_missing.append("fingerprints")
            else:
                analysis.source_missing.append("patch")
            return analysis

        cache_file = self.paths.get("patch_cache") or (self.paths["cache"] / "patches")
        cache_file = Path(cache_file) / f"{risk_id.replace(':', '_')}.patch"
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(patch_text, encoding="utf-8")
        analysis.materials.append(
            SourceMaterial(
                kind="patch",
                url=patch_url or (seed.get("patch_zip_urls") or [None])[0],
                local_path=str(cache_file),
                excerpt=patch_text[:500],
            )
        )
        analysis.remediation_options.has_isolated_patch = True

        fps = self.fp_builder.build(patch_text, allow_ai_draft=self.llm.enabled)
        analysis.fingerprints = fps
        fp_path = self.paths["fingerprints"] / f"{risk_id.replace(':', '_')}.json"
        write_fingerprint_bundle(fp_path, fps)
        if fps:
            analysis.confidence = max(analysis.confidence, 0.7)
        else:
            analysis.source_missing.append("fingerprints")
        return analysis

    def _download_isolated_zip_patches(self, seed: Dict[str, Any], risk_id: str) -> list[str]:
        urls = prefer_zip_urls(
            [str(u) for u in (seed.get("patch_zip_urls") or [])],
            limit=self.settings.advisory.patch_zip_download_limit,
        )
        if not urls:
            return []
        cache_root = Path(self.paths.get("patch_cache") or (self.paths["data"] / "cache" / "patches"))
        zip_dir = cache_root / "zips"
        user = self.secrets.magento_repo_public_key
        password = self.secrets.magento_repo_private_key
        texts: list[str] = []
        for url in urls:
            needs_auth = "/auth/" in url.lower()
            if needs_auth and not (user and password):
                self.store.log(
                    "ingest",
                    "warning",
                    f"skip auth patch zip (set MAGENTO_REPO_PUBLIC_KEY/PRIVATE_KEY): {url}",
                )
                continue
            dest = zip_cache_path(zip_dir, url)
            try:
                download_patch_zip(
                    url,
                    dest,
                    username=user if needs_auth else None,
                    password=password if needs_auth else None,
                    timeout=max(60.0, self.settings.advisory.request_timeout_seconds),
                    client=self.http,
                )
                members = extract_patch_texts_from_zip(dest)
                if not members:
                    self.store.log("ingest", "warning", f"no .patch members in zip: {url}")
                    continue
                for name, body in members:
                    texts.append(f"# from {url} :: {name}\n{body}")
                analysis_note = f"downloaded_zip:{Path(url).name}:{len(members)}"
                self.store.log("ingest", "info", f"{risk_id} {analysis_note}")
            except Exception as exc:  # noqa: BLE001
                self.store.log("ingest", "warning", f"patch zip failed {url}: {exc}")
        return texts

    def _sync_remediation_flags(self, analysis: RiskItemAnalysis, seed: Dict[str, Any]) -> RiskItemAnalysis:
        # Seed may carry explicit flags from fixtures / LLM structure assist.
        if seed.get("has_isolated_patch") is True:
            analysis.remediation_options.has_isolated_patch = True
        if seed.get("upgrade_available") is True:
            analysis.remediation_options.upgrade_available = True
        mins = seed.get("recommended_min_versions") or []
        if isinstance(mins, list) and mins:
            analysis.remediation_options.recommended_min_versions = composer_recommendable_versions(
                [str(x) for x in mins]
            )
        # Legacy remediation_offer on seed fills gaps when independent flags absent.
        offer_raw = seed.get("remediation_offer")
        if offer_raw:
            try:
                legacy = options_from_offer(RemediationOffer(offer_raw))
                if legacy.has_isolated_patch:
                    analysis.remediation_options.has_isolated_patch = True
                if legacy.upgrade_available:
                    analysis.remediation_options.upgrade_available = True
            except ValueError:
                pass
        # Package fixed_version implies an upgrade path.
        fixed_versions = [p.fixed_version for p in analysis.packages if p.fixed_version]
        if fixed_versions:
            analysis.remediation_options.upgrade_available = True
            if not analysis.remediation_options.recommended_min_versions:
                analysis.remediation_options.recommended_min_versions = list(
                    dict.fromkeys(str(v) for v in fixed_versions)
                )
        # If NVD mentioned product versions, upgrade path exists even without patch file.
        if analysis.raw.get("nvd_mentioned_versions") or extract_commerce_versions(
            analysis.technical_summary or ""
        ):
            analysis.remediation_options.upgrade_available = True
        analysis.remediation_offer = analysis.remediation_options.to_offer()
        return analysis

    def _analyze_with_ai(
        self,
        analysis: RiskItemAnalysis,
        bulletin_id: str,
        risk_id: str,
        bulletin_url: Optional[str],
    ) -> RiskItemAnalysis:
        official = next((m for m in analysis.materials if m.kind == "official"), None)
        nvd = next((m for m in analysis.materials if m.kind == "nvd"), None)
        patch = next((m for m in analysis.materials if m.kind == "patch"), None)

        payload = {
            "risk_id": risk_id,
            "bulletin_id": bulletin_id,
            "bulletin_url": bulletin_url,
            "title": analysis.title,
            "cve_ids": analysis.cve_ids,
            "severity": analysis.severity.value,
            "score": analysis.score,
            "score_source": analysis.score_source,
            "technical_summary_en": analysis.technical_summary,
            "source_missing": analysis.source_missing,
            "known_remediation_flags": {
                "has_isolated_patch": analysis.remediation_options.has_isolated_patch,
                "upgrade_available": analysis.remediation_options.upgrade_available,
                "recommended_min_versions": analysis.remediation_options.recommended_min_versions,
                "nvd_mentioned_versions": analysis.raw.get("nvd_mentioned_versions"),
            },
            "official_material": {
                "url": official.url if official else bulletin_url,
                "text": (official.excerpt if official else None) or "",
            },
            "nvd_material": {
                "url": nvd.url if nvd else None,
                "text": (nvd.excerpt if nvd else None) or "",
            },
            "patch_material": {
                "present": bool(patch) or analysis.remediation_options.has_isolated_patch,
                "url": patch.url if patch else None,
                "local_path": patch.local_path if patch else None,
                "excerpt": (patch.excerpt if patch else None) or "",
            },
            "language": "zh-CN",
        }

        if not self.llm.enabled:
            analysis.source_missing.append("llm")
            analysis.business_impact = None
            analysis.narrative = (
                "未启用 LLM（llm.enabled=false 或缺少 API Key），中文业务影响/综合说明未生成。"
                "请开启 LLM 后重新 ingest。"
            )
            return analysis

        try:
            result = self.llm.analyze_risk_item_zh(payload)
        except Exception as exc:  # noqa: BLE001
            self.store.log("ingest", "warning", f"LLM analyze failed: {exc}")
            analysis.source_missing.append("llm_analyze")
            analysis.narrative = f"LLM 分析失败：{exc}"
            return analysis

        if not result:
            analysis.source_missing.append("llm_empty")
            analysis.narrative = "LLM 未返回内容。"
            return analysis

        llm_title = result.get("title")
        if isinstance(llm_title, str) and llm_title.strip():
            from magento_security_watcher.i18n_zh import (
                is_code_style_risk_title,
                is_generic_product_title,
                zh_vuln_type_title,
            )

            cleaned = llm_title.strip()
            # Prefer concrete vuln-type labels; reject APSB+CVE and product generics.
            if not is_code_style_risk_title(cleaned) and not is_generic_product_title(cleaned):
                mapped = zh_vuln_type_title(cleaned) or cleaned
                # Keep deterministic seed title if LLM still returns a vague label.
                if not (
                    is_generic_product_title(mapped)
                    and analysis.title
                    and not is_generic_product_title(analysis.title)
                    and analysis.title != "未分类漏洞"
                ):
                    analysis.title = mapped[:200]

        analysis.business_impact = result.get("business_impact") or analysis.business_impact
        analysis.narrative = result.get("narrative") or analysis.narrative
        if result.get("technical_summary_zh"):
            # Keep EN NVD in materials; store ZH summary in narrative-adjacent field.
            analysis.technical_summary = (
                f"{result.get('technical_summary_zh')}\n\n---\n原文/NVD：\n{analysis.technical_summary or ''}"
            ).strip()

        # Merge remediation: AI + deterministic flags (OR for booleans).
        if result.get("has_isolated_patch") is True:
            analysis.remediation_options.has_isolated_patch = True
        if result.get("upgrade_available") is True:
            analysis.remediation_options.upgrade_available = True
        ai_mins = result.get("recommended_min_versions") or []
        if isinstance(ai_mins, list) and ai_mins:
            cleaned = composer_recommendable_versions([str(x) for x in ai_mins])
            if cleaned:
                analysis.remediation_options.recommended_min_versions = cleaned
        if result.get("remediation_notes"):
            analysis.remediation_options.notes = str(result.get("remediation_notes"))
        analysis.remediation_offer = analysis.remediation_options.to_offer()
        analysis.confidence = max(analysis.confidence, 0.8)
        analysis.raw["llm_analyze"] = result
        return analysis

    def _analyze_bulletin(
        self,
        external_id: str,
        title: str,
        url: Optional[str],
        raw_text: str,
        seeds: List[Dict[str, Any]],
    ) -> BulletinAnalysis:
        risk_rows = self.store.list_risk_item_rows_for_bulletin(external_id)
        risk_summaries: List[Dict[str, Any]] = []
        cve_ids: List[str] = []
        has_patch = False
        upgrade = False
        mins: List[str] = []
        refs: List[Dict[str, str]] = []
        if url:
            refs.append({"kind": "official", "title": "Adobe 官方公告", "url": url})
        for row in risk_rows:
            try:
                analysis = RiskItemAnalysis.model_validate_json(row["analysis_json"])
            except Exception:  # noqa: BLE001
                continue
            for cve in analysis.cve_ids:
                if cve not in cve_ids:
                    cve_ids.append(cve)
                    refs.append(
                        {
                            "kind": "nvd",
                            "title": cve,
                            "url": f"https://nvd.nist.gov/vuln/detail/{cve}",
                        }
                    )
            opts = analysis.remediation_options
            has_patch = has_patch or opts.has_isolated_patch
            upgrade = upgrade or opts.upgrade_available
            for m in opts.recommended_min_versions:
                if m not in mins:
                    mins.append(m)
            for mat in analysis.materials:
                if mat.url and not any(r.get("url") == mat.url for r in refs):
                    refs.append(
                        {
                            "kind": mat.kind or "link",
                            "title": mat.kind or "参考",
                            "url": mat.url,
                        }
                    )
            risk_summaries.append(
                {
                    "risk_id": row["risk_id"],
                    "title": analysis.title,
                    "cve_ids": analysis.cve_ids,
                    "severity": analysis.severity.value,
                    "has_isolated_patch": opts.has_isolated_patch,
                    "upgrade_available": opts.upgrade_available,
                    "recommended_min_versions": opts.recommended_min_versions,
                    "business_impact": (analysis.business_impact or "")[:400],
                }
            )
        mins = composer_recommendable_versions(mins)
        if not cve_ids:
            for s in seeds:
                for cve in s.get("cve_ids") or []:
                    c = str(cve).upper()
                    if c not in cve_ids:
                        cve_ids.append(c)

        base = BulletinAnalysis(
            cve_ids=cve_ids,
            has_isolated_patch=has_patch,
            upgrade_available=upgrade,
            recommended_min_versions=mins,
            reference_links=refs,
        )
        payload = {
            "bulletin_id": external_id,
            "title": title,
            "url": url,
            "official_excerpt": strip_html(raw_text or "", 8000),
            "risks": risk_summaries,
            "known_flags": {
                "has_isolated_patch": has_patch,
                "upgrade_available": upgrade,
                "recommended_min_versions": mins,
                "cve_ids": cve_ids,
            },
        }
        if not self.llm.enabled:
            base.source_missing.append("llm")
            base.summary = "未启用 LLM，公告级综合分析未生成。请开启后重新 ingest。"
            base.business_impact_scope = None
            base.remediation_summary = (
                f"独立补丁：{'有' if has_patch else '无/未确认'}；"
                f"可升级：{'是' if upgrade else '否/未确认'}；"
                f"建议版本：{', '.join(mins) or '材料未提供'}"
            )
            return base
        try:
            result = self.llm.analyze_bulletin_zh(payload)
        except Exception as exc:  # noqa: BLE001
            self.store.log("ingest", "warning", f"bulletin LLM analyze failed: {exc}")
            base.source_missing.append("llm_analyze")
            base.summary = f"公告级 LLM 分析失败：{exc}"
            return base
        if not isinstance(result, dict) or not result:
            base.source_missing.append("llm_empty")
            base.summary = "公告级 LLM 未返回内容。"
            return base
        base.summary = result.get("summary") or base.summary
        base.business_impact_scope = result.get("business_impact_scope")
        base.remediation_summary = result.get("remediation_summary")
        if result.get("has_isolated_patch") is True:
            base.has_isolated_patch = True
        if result.get("upgrade_available") is True:
            base.upgrade_available = True
        ai_mins = result.get("recommended_min_versions") or []
        if isinstance(ai_mins, list) and ai_mins:
            cleaned = composer_recommendable_versions([str(x) for x in ai_mins])
            if cleaned:
                base.recommended_min_versions = cleaned
        base.affected_version_summary = result.get("affected_version_summary")
        base.severity_overview = result.get("severity_overview")
        base.raw["llm_analyze"] = result
        return base

    def _write_risk_report(self, risk_id: str, bulletin_id: str, analysis: RiskItemAnalysis) -> Path:
        safe = risk_id.replace(":", "_")
        md_path = self.paths["reports_risk"] / f"{safe}.md"
        json_path = self.paths["reports_risk"] / f"{safe}.json"
        dump_json(json_path, analysis.model_dump())
        md_path.write_text(build_risk_report_md(risk_id, bulletin_id, analysis), encoding="utf-8")
        return md_path

    def _bulletin_overview_md(
        self,
        external_id: str,
        title: str,
        seeds: List[Dict[str, Any]],
        analysis: Optional[BulletinAnalysis] = None,
    ) -> str:
        lines = [f"# 公告 {external_id}", "", title, ""]
        if analysis:
            lines.extend(
                [
                    "## 综合分析（AI）",
                    analysis.summary or "_未生成_",
                    "",
                    "## 业务影响范围",
                    analysis.business_impact_scope or "_未生成_",
                    "",
                    "## 修复方式",
                    analysis.remediation_summary
                    or (
                        f"独立补丁={'有' if analysis.has_isolated_patch else '无'}；"
                        f"可升级={'是' if analysis.upgrade_available else '否'}"
                    ),
                    "",
                    f"- 建议最低版本：{', '.join(analysis.recommended_min_versions) or '—'}",
                    f"- 受影响版本摘要：{analysis.affected_version_summary or '—'}",
                    f"- 等级概览：{analysis.severity_overview or '—'}",
                    "",
                    "## 参考链接",
                ]
            )
            for ref in analysis.reference_links:
                lines.append(f"- [{ref.get('title') or ref.get('kind')}]({ref.get('url')})")
            lines.append("")
        lines.extend(["## 风险条目", ""])
        for s in seeds:
            cves = ", ".join(s.get("cve_ids") or []) or "无"
            lines.append(f"- {s.get('title')}（{cves}）")
        return "\n".join(lines) + "\n"


def build_ingest(settings: AppSettings, root: Optional[Path] = None) -> IngestService:
    paths = ensure_data_dirs(settings)
    store = Store(settings.db_path)
    return IngestService(settings, store, paths, load_env_secrets())
