from __future__ import annotations

import re
from typing import List, Optional

from magento_security_watcher.models import RiskItemAnalysis, Severity

_SEVERITY_ZH = {
    Severity.CRITICAL: "严重",
    Severity.HIGH: "高",
    Severity.MEDIUM: "中",
    Severity.LOW: "低",
    Severity.NONE: "无",
    Severity.UNKNOWN: "未知",
}

_STATUS_ZH = {
    "not_applicable": "不适用",
    "vulnerable": "未修复/仍受影响",
    "fixed": "已修复",
    # UI treats inconclusive the same as unfixed (still needs attention).
    "unknown": "未修复/仍受影响",
    "error": "扫描错误",
}

_FIX_ZH = {
    "none": "无",
    "upgrade": "升级",
    "patch_content": "内容补丁",
    "upgrade_and_patch": "升级+补丁",
    "unknown": "未知",
}

_VERSION_RE = re.compile(
    r"\b(2\.\d+\.\d+(?:-(?:p|alpha|beta|rc)\d+)?)\b",
    re.IGNORECASE,
)

# "APSB26-73 CVE-2026-48371" / "APSB26-73:CVE-…" — code-style titles for list display.
_CODE_STYLE_TITLE_RE = re.compile(
    r"^APSB\d{2}-\d+\s*[:：]?\s*CVE-\d{4}-\d+\s*$",
    re.IGNORECASE,
)
_APSB_ONLY_RE = re.compile(r"^APSB\d{2}-\d+$", re.IGNORECASE)
_GENERIC_PRODUCT_TITLE_RE = re.compile(
    r"^(?:adobe\s+commerce\s*/\s*)?"
    r"(?:magento(?:\s+open\s+source)?|adobe\s+commerce(?:\s+b2b)?)\s*"
    r"(?:安全更新|安全修复)$",
    re.IGNORECASE,
)
_CWE_ONLY_RE = re.compile(r"^CWE-(\d+)\s*$", re.IGNORECASE)

# Prefer specific vuln-type labels over generic "Magento 安全更新".
_VULN_TYPE_RULES: List[tuple[re.Pattern[str], str]] = [
    (re.compile(r"stored\s*xss|cross[- ]site scripting\s*\(\s*stored", re.I), "存储型 XSS"),
    (re.compile(r"reflected\s*xss|cross[- ]site scripting\s*\(\s*reflected", re.I), "反射型 XSS"),
    (re.compile(r"dom[- ]based\s*xss|cross[- ]site scripting\s*\(\s*dom", re.I), "DOM 型 XSS"),
    (re.compile(r"cross[- ]site scripting|\bxss\b", re.I), "跨站脚本 (XSS)"),
    (re.compile(r"cross[- ]site request forgery|\bcsrf\b", re.I), "跨站请求伪造 (CSRF)"),
    (re.compile(r"server[- ]side request forgery|\bssrf\b", re.I), "服务端请求伪造 (SSRF)"),
    (re.compile(r"xml\s*external\s*entity|\bxxe\b", re.I), "XML 外部实体 (XXE)"),
    (re.compile(r"sql\s*injection|\bsqli\b", re.I), "SQL 注入"),
    (re.compile(r"os\s*command\s*injection|command\s*injection", re.I), "命令注入"),
    (re.compile(r"code\s*injection", re.I), "代码注入"),
    (re.compile(r"path\s*traversal|directory\s*traversal", re.I), "路径遍历"),
    (re.compile(r"open\s*redirect|url\s*redirection", re.I), "开放重定向"),
    (re.compile(r"unrestricted\s*(?:file\s*)?upload|dangerous\s*type", re.I), "任意文件上传"),
    (re.compile(r"incorrect\s+authorization|improper\s+authorization|missing\s+authorization", re.I), "错误授权"),
    (re.compile(r"improper\s+access\s+control", re.I), "访问控制不当"),
    (re.compile(r"improper\s+authentication|broken\s+authentication", re.I), "身份认证不当"),
    (re.compile(r"improper\s+input\s+validation", re.I), "输入验证不当"),
    (re.compile(r"arbitrary\s+code\s+execution|remote\s+code\s+execution|\brce\b", re.I), "任意代码执行"),
    (re.compile(r"privilege\s+escalation", re.I), "权限提升"),
    (re.compile(r"security\s+feature\s+bypass", re.I), "安全功能绕过"),
    (re.compile(r"denial\s+of\s+service|\bdos\b", re.I), "拒绝服务"),
    (re.compile(r"information\s+(?:disclosure|exposure)|sensitive\s+data", re.I), "信息泄露"),
    (re.compile(r"insecure\s+direct\s+object|\bidor\b", re.I), "不安全直接对象引用"),
    (re.compile(r"deserialization", re.I), "不安全反序列化"),
]

_CWE_TITLE: dict[str, str] = {
    "20": "输入验证不当",
    "22": "路径遍历",
    "78": "命令注入",
    "79": "跨站脚本 (XSS)",
    "89": "SQL 注入",
    "94": "代码注入",
    "200": "信息泄露",
    "269": "权限管理不当",
    "284": "访问控制不当",
    "285": "授权不当",
    "287": "身份认证不当",
    "352": "跨站请求伪造 (CSRF)",
    "434": "任意文件上传",
    "502": "不安全反序列化",
    "601": "开放重定向",
    "862": "授权缺失",
    "863": "错误授权",
    "918": "服务端请求伪造 (SSRF)",
}


def is_code_style_risk_title(title: str) -> bool:
    return bool(_CODE_STYLE_TITLE_RE.match((title or "").strip()))


def is_generic_product_title(title: str) -> bool:
    """True for vague product labels like「Magento 安全更新」."""
    text = _polish_display_title(title or "")
    return bool(_GENERIC_PRODUCT_TITLE_RE.match(text))


def clean_adobe_page_title(title: Optional[str]) -> Optional[str]:
    """Strip site suffixes; return None if only an APSB id / empty."""
    if not title:
        return None
    text = re.sub(r"\s+", " ", str(title)).strip()
    text = re.sub(r"\s*[\|\-–—]\s*Adobe Experience League.*$", "", text, flags=re.I).strip()
    text = re.sub(r"\s*[\|\-–—]\s*Adobe Commerce.*$", "", text, flags=re.I).strip()
    text = re.sub(r"\s*[\|\-–—]\s*Adobe.*$", "", text, flags=re.I).strip()
    if not text or _APSB_ONLY_RE.match(text) or is_code_style_risk_title(text):
        return None
    return text[:160]


def zh_vuln_type_title(
    category: Optional[str] = None,
    impact: Optional[str] = None,
) -> Optional[str]:
    """Map Adobe Vulnerability Category / Impact / CWE → short Chinese title."""
    for raw in (category, impact):
        if not raw:
            continue
        text = re.sub(r"\s+", " ", str(raw)).strip()
        if not text:
            continue
        cwe_only = _CWE_ONLY_RE.match(text)
        if cwe_only:
            mapped = _CWE_TITLE.get(cwe_only.group(1))
            if mapped:
                return mapped
            continue
        for pattern, label in _VULN_TYPE_RULES:
            if pattern.search(text):
                return label
        cwe_m = re.search(r"CWE-(\d+)", text, re.I)
        if cwe_m:
            mapped = _CWE_TITLE.get(cwe_m.group(1))
            if mapped:
                return mapped
    return None


def _page_title_to_zh_base(page_title: Optional[str]) -> str:
    cleaned = clean_adobe_page_title(page_title)
    if not cleaned:
        return "未分类漏洞"
    low = cleaned.lower()
    if re.search(r"[\u4e00-\u9fff]", cleaned):
        polished = _polish_display_title(cleaned)
        if polished and not is_generic_product_title(polished):
            return polished
        return polished or "未分类漏洞"
    # English page titles are almost always generic; do not use as risk labels.
    if "security" in low or "magento" in low or "adobe commerce" in low:
        return "未分类漏洞"
    return "未分类漏洞"


def _polish_display_title(title: str) -> str:
    """Drop 'Adobe Commerce /' prefix and any parenthetical CVE/APSB suffix."""
    text = (title or "").strip()
    text = re.sub(r"(?i)^adobe\s+commerce\s*/\s*", "", text).strip()
    # Strip trailing （CVE-…） / (APSB…) only — keep (XSS)/(CSRF) acronyms.
    text = re.sub(
        r"[（(]\s*(?:CVE-\d{4}-\d+|APSB\d{2}-\d+)\s*[）)]\s*$",
        "",
        text,
        flags=re.I,
    ).strip()
    return text or "未分类漏洞"


def zh_risk_title(
    *,
    bulletin_id: str,
    cve_id: Optional[str] = None,
    page_title: Optional[str] = None,
    vuln_category: Optional[str] = None,
    vuln_impact: Optional[str] = None,
) -> str:
    """Prefer vuln-type Chinese title; CVE/APSB stay in risk_id / columns."""
    _ = bulletin_id, cve_id  # kept for call-site compatibility
    typed = zh_vuln_type_title(vuln_category, vuln_impact)
    if typed:
        return typed
    return _page_title_to_zh_base(page_title)


def display_risk_title(
    title: Optional[str],
    *,
    risk_id: str,
    cve_ids: Optional[List[str]] = None,
    bulletin_id: Optional[str] = None,
    vuln_category: Optional[str] = None,
    vuln_impact: Optional[str] = None,
) -> str:
    """Prefer stored vuln-type title; rewrite legacy APSB+CVE / generic labels."""
    text = (title or "").strip()
    typed = zh_vuln_type_title(vuln_category, vuln_impact)
    if typed:
        return typed
    if text and not is_code_style_risk_title(text) and not is_generic_product_title(text):
        # Keep concrete Chinese titles (e.g. 存储型 XSS); map English Adobe categories.
        if re.search(r"[\u4e00-\u9fff]", text):
            return _polish_display_title(text)
        from_stored = zh_vuln_type_title(text)
        if from_stored:
            return from_stored
        return _polish_display_title(text)
    cve = None
    if cve_ids:
        cve = str(cve_ids[0])
    bid = bulletin_id
    if risk_id and ":" in risk_id:
        left, right = risk_id.split(":", 1)
        bid = bid or left
        if not cve and right.upper().startswith("CVE-"):
            cve = right
    return zh_risk_title(bulletin_id=bid or risk_id or "APSB", cve_id=cve)


def severity_zh(sev: Severity) -> str:
    return _SEVERITY_ZH.get(sev, sev.value)


def status_zh(status: str) -> str:
    return _STATUS_ZH.get(status, status)


def fix_method_zh(method: str) -> str:
    return _FIX_ZH.get(method, method)


def extract_commerce_versions(text: str) -> List[str]:
    if not text:
        return []
    seen: List[str] = []
    for m in _VERSION_RE.finditer(text):
        v = m.group(1)
        if v not in seen:
            seen.append(v)
    return seen


def strip_html(text: str, limit: int = 8000) -> str:
    if not text:
        return ""
    text = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", text)
    text = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def build_risk_report_md(risk_id: str, bulletin_id: str, analysis: RiskItemAnalysis) -> str:
    """Report shell in Chinese; body content comes from AI fields when present."""
    opts = analysis.remediation_options
    lines = [
        f"# 风险条目：{analysis.title}",
        "",
        f"- 编号：`{risk_id}`",
        f"- 公告：`{bulletin_id}`",
        f"- CVE：{', '.join(analysis.cve_ids) or '无'}",
        f"- 危险等级：**{severity_zh(analysis.severity)}**（`{analysis.severity.value}`）",
        f"- 评分：{analysis.score}（{analysis.score_source or 'n/a'}）",
        f"- 有独立补丁：{'是' if opts.has_isolated_patch else '否'}",
        f"- 可升级修复：{'是' if opts.upgrade_available else '否'}",
        f"- 建议最低升级版本：{', '.join(opts.recommended_min_versions) or '材料未提供/待确认'}",
        f"- 修复说明：{opts.notes or '（无）'}",
        f"- 聚合枚举（兼容扫描）：`{analysis.remediation_offer.value}`",
        f"- 置信度：{analysis.confidence}",
        f"- 缺失来源：{', '.join(analysis.source_missing) or '无'}",
        "",
        "## 业务影响（AI）",
        analysis.business_impact or "_未生成（需启用 LLM）_",
        "",
        "## 综合说明（AI）",
        analysis.narrative or "_未生成（需启用 LLM）_",
        "",
        "## 技术摘要",
        analysis.technical_summary or "_无_",
        "",
        "## 包/产品约束",
    ]
    if analysis.packages:
        for p in analysis.packages:
            lines.append(
                f"- `{p.name}` 受影响=`{p.affected_versions}` 修复=`{p.fixed_version}`"
            )
    else:
        lines.append("- （空）")
    lines.extend(["", "## 内容指纹", f"- 数量：{len(analysis.fingerprints)}"])
    for fp in analysis.fingerprints:
        lines.append(f"- `{fp.path}` hunk={fp.hunk_id}")
    lines.extend(["", "## 参考材料"])
    for m in analysis.materials:
        excerpt_hint = (m.excerpt or "")[:120].replace("\n", " ")
        lines.append(f"- {m.kind}: {m.url or m.local_path or ''} {excerpt_hint}")
    return "\n".join(lines) + "\n"
