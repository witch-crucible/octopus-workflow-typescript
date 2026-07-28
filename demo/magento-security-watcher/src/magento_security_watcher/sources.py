from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin

import httpx

from magento_security_watcher.adobe_bulletin import (
    attach_bulletin_packages_to_seeds,
    attach_patch_signals_to_seeds,
    detect_isolated_patch_signals,
    extract_release_note_urls,
    merge_patch_signals,
)
from magento_security_watcher.browser_identity import BROWSER_USER_AGENT, browser_headers
from magento_security_watcher.http_fetch import fetch_text, _NETWORK_HINT
from magento_security_watcher.i18n_zh import zh_risk_title
from magento_security_watcher.models import (
    PackageConstraint,
    RemediationOffer,
    RemediationOptions,
    RiskItemAnalysis,
    Severity,
    SourceMaterial,
)

logger = logging.getLogger(__name__)

_CACHE_MISS = object()


def options_from_offer(offer: RemediationOffer) -> RemediationOptions:
    """Map legacy aggregate remediation_offer into independent flags."""
    if offer == RemediationOffer.UPGRADE_OR_PATCH:
        return RemediationOptions(has_isolated_patch=True, upgrade_available=True)
    if offer == RemediationOffer.PATCH_ONLY:
        return RemediationOptions(has_isolated_patch=True, upgrade_available=False)
    if offer == RemediationOffer.UPGRADE_ONLY:
        return RemediationOptions(has_isolated_patch=False, upgrade_available=True)
    return RemediationOptions()


@dataclass
class RawBulletin:
    external_id: str
    title: str
    url: Optional[str]
    published_at: Optional[str]
    raw_text: str
    risk_seeds: List[Dict[str, Any]]


class AdvisorySource:
    def list_bulletins(self) -> list[RawBulletin]:
        raise NotImplementedError


class FixtureAdvisorySource(AdvisorySource):
    """Load bulletins from a local directory of JSON fixtures (tests / offline)."""

    def __init__(self, fixture_dir: Path) -> None:
        self.fixture_dir = fixture_dir

    def list_bulletins(self) -> list[RawBulletin]:
        out: list[RawBulletin] = []
        for path in sorted(self.fixture_dir.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            out.append(
                RawBulletin(
                    external_id=data["external_id"],
                    title=data.get("title") or data["external_id"],
                    url=data.get("url"),
                    published_at=data.get("published_at"),
                    raw_text=data.get("raw_text") or "",
                    risk_seeds=data.get("risk_items") or [],
                )
            )
        return out


_CVE_RE = re.compile(r"CVE-\d{4}-\d{4,}", re.IGNORECASE)
_APSB_RE = re.compile(r"APSB\d{2}-\d{2}", re.IGNORECASE)
_MAGENTO_APSB_HREF_RE = re.compile(
    r'href=["\'](?P<href>[^"\']*?/security/products/magento/(?P<id>apsb\d{2}-\d{2})\.html[^"\']*)["\']',
    re.IGNORECASE,
)
_GENERIC_APSB_HREF_RE = re.compile(
    r'href=["\'](?P<href>[^"\']*?(?P<id>apsb\d{2}-\d{2})[^"\']*)["\']',
    re.IGNORECASE,
)
_VULN_DETAILS_RE = re.compile(
    r"(?is)<h[1-6][^>]*>\s*Vulnerability Details\s*</h[1-6]>(.*?)(?=<h[1-6]\b|$)",
)


def extract_bulletin_cves(html: str) -> list[str]:
    """Prefer CVEs inside Vulnerability Details; fall back to full page."""
    if not html:
        return []
    scope = html
    m = _VULN_DETAILS_RE.search(html)
    if m and m.group(1).strip():
        scoped = sorted({c.upper() for c in _CVE_RE.findall(m.group(1))})
        if scoped:
            return scoped
    return sorted({c.upper() for c in _CVE_RE.findall(html)})


class LocalHtmlIndexSource(AdvisorySource):
    """Parse a browser-saved Magento security index HTML file."""

    def __init__(
        self,
        html_path: Path,
        *,
        list_url: str = "https://helpx.adobe.com/security/products/magento.html",
        detail_fetch_limit: int = 0,
        user_agent: str = BROWSER_USER_AGENT,
    ) -> None:
        self.html_path = html_path
        self.list_url = list_url
        self.detail_fetch_limit = detail_fetch_limit
        self.user_agent = user_agent
        self._delegate = HtmlBulletinSource(
            list_url=list_url,
            user_agent=user_agent,
            detail_fetch_limit=0,
            timeout=5.0,
        )

    def list_bulletins(self) -> list[RawBulletin]:
        html = self.html_path.read_text(encoding="utf-8", errors="replace")
        found = self._delegate._parse_listing(html)
        if not found:
            raise RuntimeError(
                f"No Magento APSB links found in {self.html_path}. "
                "Save https://helpx.adobe.com/security/products/magento.html from the browser (Webpage, HTML Only)."
            )
        ordered = sorted(found.values(), key=lambda b: b.external_id, reverse=True)
        # Optional remote detail enrichment (may fail offline; soft-skip).
        if self.detail_fetch_limit > 0:
            enricher = HtmlBulletinSource(
                list_url=self.list_url,
                user_agent=self.user_agent,
                detail_fetch_limit=self.detail_fetch_limit,
            )
            for bulletin in ordered[: self.detail_fetch_limit]:
                enricher._enrich_from_detail(bulletin)
        return ordered


class HtmlBulletinSource(AdvisorySource):
    """
    Best-effort HTML listing fetcher for Adobe Magento/Commerce bulletins.

    Default index: https://helpx.adobe.com/security/products/magento.html
    """

    def __init__(
        self,
        list_url: str,
        user_agent: str,
        client: httpx.Client | None = None,
        *,
        detail_fetch_limit: int = 15,
        timeout: float = 45.0,
        follow_release_notes: bool = True,
        kb_fetch_limit_per_bulletin: int = 2,
    ) -> None:
        self.list_url = list_url
        self.user_agent = user_agent
        self.detail_fetch_limit = detail_fetch_limit
        self.timeout = timeout
        self.follow_release_notes = follow_release_notes
        self.kb_fetch_limit_per_bulletin = kb_fetch_limit_per_bulletin
        self.client = client or httpx.Client(
            timeout=timeout,
            headers=browser_headers(user_agent),
            follow_redirects=True,
            http2=False,
            trust_env=True,
        )

    def list_bulletins(self) -> list[RawBulletin]:
        timeout = 45.0
        try:
            t = getattr(self.client, "timeout", None)
            if t is not None and getattr(t, "read", None) is not None:
                timeout = float(t.read)  # type: ignore[arg-type]
        except Exception:  # noqa: BLE001
            timeout = 45.0

        try:
            fetched = fetch_text(
                self.list_url,
                user_agent=self.user_agent,
                timeout=timeout,
                client=None if "adobe.com" in self.list_url.lower() else self.client,
            )
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"Failed to fetch advisory index {self.list_url!r}: {exc}\n{_NETWORK_HINT}"
            ) from exc

        if fetched.status_code == 404:
            raise RuntimeError(
                f"Advisory index returned 404: {self.list_url}. "
                "Update config advisory.bulletin_list_url to "
                "https://helpx.adobe.com/security/products/magento.html "
                "(or use advisory.fixture_dir for offline ingest)."
            )
        if fetched.status_code >= 400:
            raise RuntimeError(
                f"Advisory index returned HTTP {fetched.status_code}: {self.list_url}"
            )
        html = fetched.text
        found = self._parse_listing(html)
        if not found:
            cves = sorted({c.upper() for c in _CVE_RE.findall(html)})
            seeds = [{"title": cve, "cve_ids": [cve], "severity": "unknown"} for cve in cves]
            return [
                RawBulletin(
                    external_id="MAGENTO-SECURITY-INDEX",
                    title="Magento / Adobe Security Index",
                    url=self.list_url,
                    published_at=None,
                    raw_text=html[:50000],
                    risk_seeds=seeds,  # empty if no CVEs on page — do not invent placeholders
                )
            ]

        # Newest Magento APSB ids tend to sort well by year-number in the id.
        ordered = sorted(found.values(), key=lambda b: b.external_id, reverse=True)
        if self.detail_fetch_limit > 0:
            for bulletin in ordered[: self.detail_fetch_limit]:
                self._enrich_from_detail(bulletin)
        return ordered

    def _parse_listing(self, html: str) -> dict[str, RawBulletin]:
        found: dict[str, RawBulletin] = {}
        # Prefer Magento product bulletin links.
        for match in _MAGENTO_APSB_HREF_RE.finditer(html):
            apsb = match.group("id").upper()
            href = urljoin(self.list_url, match.group("href"))
            found[apsb] = RawBulletin(
                external_id=apsb,
                title=f"Adobe Magento Security Bulletin {apsb}",
                url=href,
                published_at=None,
                raw_text="",
                # No placeholder RiskItem: wait for detail CVE enrichment (or stay empty).
                risk_seeds=[],
            )
        if found:
            return found

        # Fallback: any APSB mention / href on the page.
        for match in _GENERIC_APSB_HREF_RE.finditer(html):
            apsb = match.group("id").upper()
            if apsb in found:
                continue
            href = urljoin(self.list_url, match.group("href"))
            # Skip non-Magento product bulletins when listing is the global Adobe index.
            if "/security/products/" in href and "/magento/" not in href.lower():
                continue
            found[apsb] = RawBulletin(
                external_id=apsb,
                title=f"Adobe Magento Security Bulletin {apsb}",
                url=href,
                published_at=None,
                raw_text="",
                risk_seeds=[],
            )
        if found:
            return found

        for match in _APSB_RE.finditer(html):
            apsb = match.group(0).upper()
            if apsb in found:
                continue
            window = html[max(0, match.start() - 200) : match.end() + 200]
            href_match = re.search(r'href=["\']([^"\']+)["\']', window)
            url = urljoin(self.list_url, href_match.group(1)) if href_match else self.list_url
            found[apsb] = RawBulletin(
                external_id=apsb,
                title=f"Adobe Magento Security Bulletin {apsb}",
                url=url,
                published_at=None,
                raw_text=window,
                risk_seeds=[],
            )
        return found

    def _enrich_from_detail(self, bulletin: RawBulletin) -> None:
        if not bulletin.url:
            return
        try:
            fetched = fetch_text(
                bulletin.url,
                user_agent=self.user_agent,
                timeout=getattr(self, "timeout", 45.0),
                client=None,  # prefer curl for Adobe detail pages
            )
            if fetched.status_code >= 400:
                return
            html = fetched.text
        except Exception:  # noqa: BLE001
            return
        bulletin.raw_text = html[:80000]
        title_match = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
        if title_match:
            title = re.sub(r"\s+", " ", title_match.group(1)).strip()
            if title:
                bulletin.title = title[:200]
        cves = extract_bulletin_cves(html)
        if cves:
            bulletin.risk_seeds = [
                {
                    "title": zh_risk_title(
                        bulletin_id=bulletin.external_id,
                        cve_id=cve,
                        page_title=bulletin.title,
                    ),
                    "cve_ids": [cve],
                    "severity": "unknown",
                }
                for cve in cves
            ]
            # Attach Affected/Solution package constraints to every CVE seed.
            bulletin.risk_seeds = attach_bulletin_packages_to_seeds(bulletin.risk_seeds, html)
            # Severity + vuln category titles from Vulnerability Details table.
            _apply_cve_details_from_table(bulletin.risk_seeds, html)
            # Isolated patch: bulletin page first; follow Release Notes when inconclusive.
            bulletin.risk_seeds = self._attach_isolated_patch_intel(bulletin.risk_seeds, html)

    def _attach_isolated_patch_intel(
        self,
        seeds: list[dict[str, Any]],
        bulletin_html: str,
    ) -> list[dict[str, Any]]:
        signals = detect_isolated_patch_signals(bulletin_html)
        kb_urls = extract_release_note_urls(bulletin_html)
        fetched_kb: list[str] = []
        if (
            not signals.get("has_isolated_patch")
            and getattr(self, "follow_release_notes", True)
            and kb_urls
        ):
            limit = max(0, int(getattr(self, "kb_fetch_limit_per_bulletin", 2) or 0))
            for url in kb_urls[:limit]:
                try:
                    kb = fetch_text(
                        url,
                        user_agent=self.user_agent,
                        timeout=getattr(self, "timeout", 45.0),
                        prefer_curl=True,
                    )
                    if kb.status_code >= 400:
                        continue
                    fetched_kb.append(url)
                    signals = merge_patch_signals(signals, detect_isolated_patch_signals(kb.text))
                    if signals.get("has_isolated_patch") and signals.get("patch_zip_urls"):
                        break
                except Exception:  # noqa: BLE001
                    continue
        return attach_patch_signals_to_seeds(
            seeds,
            signals,
            kb_urls=fetched_kb or kb_urls[:1],
        )


def _apply_cve_severity_from_details(seeds: list[dict[str, Any]], html: str) -> None:
    """Backward-compatible alias."""
    _apply_cve_details_from_table(seeds, html)


def _apply_cve_details_from_table(seeds: list[dict[str, Any]], html: str) -> None:
    """Fill severity/score/title from Adobe Vulnerability Details rows when possible."""
    from magento_security_watcher.i18n_zh import is_generic_product_title, zh_risk_title

    details = extract_vuln_detail_by_cve(html)
    for seed in seeds:
        for cve in seed.get("cve_ids") or []:
            row = details.get(str(cve).upper())
            if not row:
                continue
            if row.get("severity"):
                seed["severity"] = row["severity"]
            if row.get("score") is not None:
                seed["score"] = row["score"]
                seed["score_source"] = "adobe-bulletin"
            if row.get("category"):
                seed["vuln_category"] = row["category"]
            if row.get("impact"):
                seed["vuln_impact"] = row["impact"]
            typed = zh_risk_title(
                bulletin_id="",
                cve_id=str(cve),
                page_title=None,
                vuln_category=row.get("category"),
                vuln_impact=row.get("impact"),
            )
            cur = str(seed.get("title") or "")
            if typed and (not cur or is_generic_product_title(cur) or cur == "未分类漏洞"):
                seed["title"] = typed
            break


def extract_vuln_detail_by_cve(html: str) -> dict[str, dict[str, Any]]:
    """
    Parse Vulnerability Details table rows → CVE → {category, impact, severity, score}.

    Adobe columns are typically:
    Vulnerability Category | Vulnerability Impact | Severity | … | CVE number(s)
    """
    mapping: dict[str, dict[str, Any]] = {}
    scope = html or ""
    m = _VULN_DETAILS_RE.search(scope)
    if m and m.group(1).strip():
        scope = m.group(1)

    header_idx: dict[str, int] = {}
    for row_html in re.findall(r"(?is)<tr\b[^>]*>(.*?)</tr>", scope):
        cells = re.findall(r"(?is)<t[hd]\b[^>]*>(.*?)</t[hd]>", row_html)
        texts = [re.sub(r"\s+", " ", re.sub(r"(?is)<[^>]+>", " ", c)).strip() for c in cells]
        if not texts:
            continue
        # Header row: learn column indexes.
        joined = " ".join(texts).lower()
        if "cve" in joined and ("category" in joined or "severity" in joined or "impact" in joined):
            header_idx = {}
            for i, t in enumerate(texts):
                low = t.lower()
                if "category" in low:
                    header_idx["category"] = i
                elif "impact" in low:
                    header_idx["impact"] = i
                elif "severity" in low:
                    header_idx["severity"] = i
                elif "cvss" in low and "score" in low:
                    header_idx["score"] = i
                elif "cve" in low:
                    header_idx["cve"] = i
            continue

        cves = [c.upper() for c in _CVE_RE.findall(row_html)]
        if not cves:
            continue

        category = None
        impact = None
        sev = None
        score = None
        if header_idx:
            if "category" in header_idx and header_idx["category"] < len(texts):
                category = texts[header_idx["category"]] or None
            if "impact" in header_idx and header_idx["impact"] < len(texts):
                impact = texts[header_idx["impact"]] or None
            if "severity" in header_idx and header_idx["severity"] < len(texts):
                sev = _adobe_severity_token(texts[header_idx["severity"]])
            if "score" in header_idx and header_idx["score"] < len(texts):
                score = _parse_score_token(texts[header_idx["score"]])
        else:
            # Fallback: first cell = category, second = impact (Adobe layout).
            if texts:
                category = texts[0] or None
            if len(texts) > 1:
                impact = texts[1] or None
            for t in texts:
                if sev is None:
                    sev = _adobe_severity_token(t)
                if score is None:
                    score = _parse_score_token(t)

        payload = {
            "category": category,
            "impact": impact,
            "severity": sev,
            "score": score,
        }
        for cve in cves:
            mapping[cve] = payload
    return mapping


def _adobe_severity_token(text: str) -> str | None:
    low = (text or "").strip().lower()
    return {
        "critical": "critical",
        "important": "high",
        "moderate": "medium",
        "low": "low",
    }.get(low)


def _parse_score_token(text: str) -> float | None:
    t = (text or "").strip()
    if re.fullmatch(r"\d+(?:\.\d+)?", t):
        try:
            return float(t)
        except ValueError:
            return None
    return None


class NvdClient:
    def __init__(
        self,
        api_base: str,
        api_key: str | None = None,
        delay: float = 6.0,
        client: httpx.Client | None = None,
        cache_dir: Path | None = None,
        cache_ttl_days: float = 30.0,
        use_stale_on_rate_limit: bool = True,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.delay = delay
        self.client = client or httpx.Client(timeout=60.0)
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.cache_ttl_seconds = max(0.0, float(cache_ttl_days)) * 86400.0
        self.use_stale_on_rate_limit = use_stale_on_rate_limit
        self._memory: dict[str, dict[str, Any] | None] = {}
        if self.cache_dir:
            self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _cache_path(self, cve_id: str) -> Path | None:
        if not self.cache_dir:
            return None
        safe = cve_id.upper().replace("/", "_")
        return self.cache_dir / f"{safe}.json"

    def _read_cache(self, cve_id: str, *, allow_stale: bool) -> dict[str, Any] | None | object:
        """Return CVE dict, None (cached miss/404), or _CACHE_MISS sentinel."""
        path = self._cache_path(cve_id)
        if path is None or not path.is_file():
            return _CACHE_MISS
        try:
            age = time.time() - path.stat().st_mtime
            if age > self.cache_ttl_seconds and not allow_stale:
                return _CACHE_MISS
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return _CACHE_MISS
        if raw.get("_nvd_not_found"):
            return None
        cve = raw.get("cve")
        if isinstance(cve, dict):
            return cve
        # Legacy: ingest used to dump the CVE object directly
        if isinstance(raw, dict) and ("id" in raw or "descriptions" in raw or "metrics" in raw):
            return raw
        return _CACHE_MISS

    def _write_cache(self, cve_id: str, cve: dict[str, Any] | None) -> None:
        path = self._cache_path(cve_id)
        if path is None:
            return
        payload = {"cve_id": cve_id.upper(), "fetched_at": time.time(), "cve": cve}
        if cve is None:
            payload = {"cve_id": cve_id.upper(), "fetched_at": time.time(), "_nvd_not_found": True}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    def fetch_cve(self, cve_id: str) -> dict[str, Any] | None:
        key = cve_id.upper()
        if key in self._memory:
            logger.debug("NVD memory cache hit %s", key)
            return self._memory[key]

        cached = self._read_cache(key, allow_stale=False)
        if cached is not _CACHE_MISS:
            logger.info("NVD disk cache hit %s", key)
            self._memory[key] = cached  # type: ignore[assignment]
            return cached  # type: ignore[return-value]

        headers = {}
        if self.api_key:
            headers["apiKey"] = self.api_key
        time.sleep(self.delay)
        try:
            resp = self.client.get(self.api_base, params={"cveId": key}, headers=headers)
        except Exception:
            stale = self._read_cache(key, allow_stale=True)
            if stale is not _CACHE_MISS:
                logger.warning("NVD network error; using stale cache for %s", key)
                self._memory[key] = stale  # type: ignore[assignment]
                return stale  # type: ignore[return-value]
            raise

        if resp.status_code == 404:
            self._write_cache(key, None)
            self._memory[key] = None
            return None

        if resp.status_code == 429:
            stale = self._read_cache(key, allow_stale=True) if self.use_stale_on_rate_limit else _CACHE_MISS
            if stale is not _CACHE_MISS:
                logger.warning("NVD 429; using stale cache for %s", key)
                self._memory[key] = stale  # type: ignore[assignment]
                return stale  # type: ignore[return-value]
            resp.raise_for_status()

        resp.raise_for_status()
        data = resp.json()
        vulns = data.get("vulnerabilities") or []
        cve = vulns[0].get("cve") if vulns else None
        self._write_cache(key, cve)
        self._memory[key] = cve
        logger.info("NVD fetched and cached %s", key)
        return cve


def severity_from_nvd(cve: dict[str, Any]) -> tuple[Severity, float | None, str | None]:
    metrics = cve.get("metrics") or {}
    for key, source in (
        ("cvssMetricV31", "nvd-cvss3.1"),
        ("cvssMetricV30", "nvd-cvss3.0"),
        ("cvssMetricV2", "nvd-cvss2"),
    ):
        items = metrics.get(key) or []
        if not items:
            continue
        cvss = items[0].get("cvssData") or {}
        score = cvss.get("baseScore")
        severity = (cvss.get("baseSeverity") or items[0].get("baseSeverity") or "unknown").lower()
        try:
            sev = Severity(severity)
        except ValueError:
            sev = Severity.UNKNOWN
        return sev, float(score) if score is not None else None, source
    return Severity.UNKNOWN, None, None


def nvd_description(cve: dict[str, Any]) -> str | None:
    for desc in cve.get("descriptions") or []:
        if desc.get("lang") == "en":
            return desc.get("value")
    return None


def seed_to_analysis(seed: dict[str, Any], bulletin_text: str) -> RiskItemAnalysis:
    cves = [c.upper() for c in seed.get("cve_ids") or []]
    packages = [
        PackageConstraint.model_validate(p) for p in (seed.get("packages") or [])
    ]
    offer_raw = seed.get("remediation_offer") or "unknown"
    try:
        offer = RemediationOffer(offer_raw)
    except ValueError:
        offer = RemediationOffer.UNKNOWN
    opts = options_from_offer(offer)
    # Explicit independent flags override legacy offer mapping.
    if seed.get("has_isolated_patch") is True:
        opts.has_isolated_patch = True
    if seed.get("has_isolated_patch") is False:
        opts.has_isolated_patch = False
    if seed.get("upgrade_available") is True:
        opts.upgrade_available = True
    if seed.get("upgrade_available") is False:
        opts.upgrade_available = False
    mins = seed.get("recommended_min_versions") or []
    if isinstance(mins, list) and mins:
        opts.recommended_min_versions = [str(x) for x in mins]
    elif packages:
        # Deterministic hint: package fixed_version is a min upgrade target.
        fixed = [p.fixed_version for p in packages if p.fixed_version]
        if fixed:
            opts.upgrade_available = True
            if not opts.recommended_min_versions:
                opts.recommended_min_versions = list(dict.fromkeys(fixed))
    offer = opts.to_offer() if (opts.has_isolated_patch or opts.upgrade_available) else offer
    sev_raw = (seed.get("severity") or "unknown").lower()
    try:
        severity = Severity(sev_raw)
    except ValueError:
        severity = Severity.UNKNOWN
    return RiskItemAnalysis(
        title=seed.get("title") or (cves[0] if cves else "Untitled risk"),
        cve_ids=cves,
        severity=severity,
        score=seed.get("score"),
        score_source=seed.get("score_source"),
        business_impact=seed.get("business_impact"),
        technical_summary=seed.get("technical_summary"),
        remediation_offer=offer,
        remediation_options=opts,
        packages=packages,
        materials=[
            SourceMaterial(kind="official", excerpt=(bulletin_text or "")[:2000]),
        ],
        confidence=float(seed.get("confidence") or 0.3),
        raw=seed,
    )
