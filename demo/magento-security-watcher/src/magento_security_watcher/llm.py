from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from magento_security_watcher.models import ContentFingerprint

logger = logging.getLogger(__name__)


class LlmClient:
    """OpenAI-compatible chat client; logs full prompts when log_dir is set."""

    def __init__(
        self,
        api_base: str,
        api_key: Optional[str],
        model: str,
        timeout: float = 120.0,
        enabled: bool = True,
        client: Optional[httpx.Client] = None,
        log_dir: Optional[Path] = None,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.enabled = enabled and bool(api_key)
        self.client = client or httpx.Client(timeout=timeout)
        self.log_dir = Path(log_dir) if log_dir else None
        if self.log_dir:
            self.log_dir.mkdir(parents=True, exist_ok=True)

    def chat(self, system: str, user: str, *, purpose: str = "chat") -> Optional[str]:
        self._log_prompt(purpose, system, user)
        if not self.enabled:
            logger.warning("LLM disabled or missing API key; skip purpose=%s", purpose)
            return None
        resp = self.client.post(
            f"{self.api_base}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": self.model,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
        )
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        self._log_response(purpose, content)
        return content

    def _log_prompt(self, purpose: str, system: str, user: str) -> None:
        # Always log to application logger (may be long).
        logger.info(
            "LLM prompt purpose=%s model=%s\n===SYSTEM===\n%s\n===USER===\n%s",
            purpose,
            self.model,
            system,
            user,
        )
        if not self.log_dir:
            return
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = self.log_dir / f"{ts}_{purpose}.txt"
        path.write_text(
            f"purpose: {purpose}\nmodel: {self.model}\nenabled: {self.enabled}\n\n"
            f"=== SYSTEM ===\n{system}\n\n=== USER ===\n{user}\n",
            encoding="utf-8",
        )

    def _log_response(self, purpose: str, content: str) -> None:
        logger.info("LLM response purpose=%s\n===ASSISTANT===\n%s", purpose, content)
        if not self.log_dir:
            return
        # Prefer appending to the matching prompt file; else write a sibling response file.
        candidates = sorted(self.log_dir.glob(f"*_{purpose}.txt"), reverse=True)
        prompt_files = [p for p in candidates if not p.name.endswith("_response.txt")]
        if prompt_files:
            with prompt_files[0].open("a", encoding="utf-8") as fh:
                fh.write(f"\n=== ASSISTANT ===\n{content or ''}\n")
            return
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = self.log_dir / f"{ts}_{purpose}_response.txt"
        path.write_text(content or "", encoding="utf-8")

    def draft_fingerprints(self, patch_text: str) -> List[ContentFingerprint]:
        content = self.chat(
            system=(
                "You extract content fingerprints from unified diffs for Magento security patches. "
                "Return ONLY JSON list of objects with keys: path, before, after, hunk_id, critical. "
                "before/after must be distinctive code snippets present in the diff minus/plus lines."
            ),
            user=patch_text[:12000],
            purpose="draft_fingerprints",
        )
        if not content:
            return []
        return _parse_fingerprint_json(content)

    def analyze_risk_item_zh(self, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Feed official + NVD (+ patch meta) to the model; expect structured Chinese analysis.
        """
        system = (
            "你是 Magento / Adobe Commerce 安全分析专家。根据用户提供的【官方公告材料】与【NVD 材料】"
            "（以及可选的补丁元信息）进行综合理解，用简体中文输出分析结果。\n"
            "要求：\n"
            "1. 不要编造 CVE、分数、版本号；材料里没有的信息就明确写「材料未提供」。\n"
            "2. 补丁与升级是两件独立的事，可以同时成立。\n"
            "   - recommended_min_versions 只填可 Composer 安装/对照的基线（如 2.4.8-p5、2.4.7-p10），"
            "不要填「2.4.8-2026-jul」这类日期后缀——那是打完 Isolated patch 后的状态标签，不是独立发版号。\n"
            "   - remediation_notes：若有独立补丁，写成「先升级/确认已在安全基线（如 2.4.8-p5），"
            "再打对应 Isolated patch（如 2-4-8-p5-jul-2026.zip）」；"
            "不要写成「升级到 2.4.8-2026-jul」这种误导表述。\n"
            "3. business_impact 要写清对电商业务的具体影响（例如后台会话、订单、客户数据、结账等），"
            "不要空泛套话。\n"
            "4. title 用简体中文「漏洞类型」短标题（如「存储型 XSS」「错误授权」「SSRF」「路径遍历」）；"
            "不要用「Magento 安全更新」这类泛称；不要加「Adobe Commerce /」前缀；"
            "也不要在标题里写括号 CVE/APSB（编号已在 risk_id 中）。\n"
            "5. 只返回一个 JSON 对象（不要 Markdown 围栏），字段如下：\n"
            "{\n"
            '  "title": "string 中文短标题",\n'
            '  "business_impact": "string 中文",\n'
            '  "narrative": "string 中文综合说明",\n'
            '  "technical_summary_zh": "string 中文技术摘要（可引用英文要点）",\n'
            '  "has_isolated_patch": true/false,\n'
            '  "upgrade_available": true/false,\n'
            '  "recommended_min_versions": ["2.4.8-p5", "2.4.7-p10"],\n'
            '  "remediation_notes": "string 中文，按「先基线再补丁」或「仅升级」路径写"\n'
            "}\n"
        )
        user = json.dumps(payload, ensure_ascii=False, indent=2)[:16000]
        content = self.chat(system, user, purpose="analyze_risk_zh")
        if not content:
            return None
        return _parse_json_object(content)

    def analyze_bulletin_zh(self, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Bulletin-level Chinese summary (impact scope + remediation options)."""
        system = (
            "你是 Magento / Adobe Commerce 安全分析专家。根据【公告材料】与【已入库风险摘要】"
            "用简体中文给出整份安全公告的综合分析。\n"
            "要求：\n"
            "1. 不要编造 CVE、版本号；材料没有的写「材料未提供」。\n"
            "2. 区分「独立补丁」与「升级到 Composer -pN」；二者可同时成立。\n"
            "3. business_impact_scope 写清业务影响范围（结账、后台、客户数据等）。\n"
            "4. remediation_summary 必须分路径写清楚步骤，例如：\n"
            "   「路径 A（推荐）：先升级/确认已在安全基线 2.4.8-p5（或对应线的最新 -pN），"
            "再打 Isolated patch（如 2-4-8-p5-jul-2026.zip）。"
            "路径 B：若公告另有可 Composer 安装的安全版本则写升级到该 -pN。」\n"
            "   严禁把「2.4.8-2026-jul / 2.4.9-2026-jul」写成可直接升级安装的版本号；"
            "那是打补丁后的状态标签。\n"
            "5. recommended_min_versions 只列安全基线（2.4.x-pN 或 2.4.9 GA），不要列 YYYY-mon 标签。\n"
            "6. 只返回一个 JSON 对象（不要 Markdown 围栏）：\n"
            "{\n"
            '  "summary": "string 综合说明",\n'
            '  "business_impact_scope": "string",\n'
            '  "remediation_summary": "string",\n'
            '  "has_isolated_patch": true/false,\n'
            '  "upgrade_available": true/false,\n'
            '  "recommended_min_versions": ["2.4.8-p5", "2.4.7-p10"],\n'
            '  "affected_version_summary": "string",\n'
            '  "severity_overview": "string"\n'
            "}\n"
        )
        user = json.dumps(payload, ensure_ascii=False, indent=2)[:16000]
        content = self.chat(system, user, purpose="analyze_bulletin_zh")
        if not content:
            return None
        return _parse_json_object(content)

    def narrate_project_finding(self, payload: Dict[str, Any]) -> Optional[str]:
        return self.chat(
            system=(
                "你是 Magento 项目安全顾问。请用简体中文撰写针对该项目的说明。"
                "必须尊重 remediation_status 与 evidence，不得与核验结论矛盾。"
                "结合项目画像说明业务影响与优先处置建议。"
            ),
            user=json.dumps(payload, ensure_ascii=False, indent=2)[:14000],
            purpose="project_finding_zh",
        )

    def assist_structure(self, bulletin_text: str) -> List[Dict[str, Any]]:
        content = self.chat(
            system=(
                "从 Magento/Adobe 安全公告文本中抽取风险条目。"
                "只返回 JSON 数组，元素字段：title, cve_ids, severity, "
                "packages (name, affected_versions, fixed_version), "
                "has_isolated_patch, upgrade_available, recommended_min_versions, "
                "technical_summary。"
                "title 必须是简体中文漏洞类型短标题（如「存储型 XSS」「错误授权」「CSRF」），"
                "不要用「Magento 安全更新」这类泛称，不要加「Adobe Commerce /」前缀，"
                "不要在标题里写括号 CVE/APSB，也不要只用 APSB+CVE 当作 title。"
            ),
            user=bulletin_text[:14000],
            purpose="assist_structure",
        )
        if not content:
            return []
        return _parse_json_list(content)


def _extract_json_block(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _parse_json_list(text: str) -> List[Dict[str, Any]]:
    raw = _extract_json_block(text)
    data = json.loads(raw)
    if isinstance(data, dict):
        data = data.get("items") or data.get("risk_items") or [data]
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict)]


def _parse_json_object(text: str) -> Dict[str, Any]:
    raw = _extract_json_block(text)
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("LLM did not return a JSON object")
    return data


def _parse_fingerprint_json(text: str) -> List[ContentFingerprint]:
    items = _parse_json_list(text)
    out: List[ContentFingerprint] = []
    for item in items:
        try:
            out.append(ContentFingerprint.model_validate(item))
        except Exception:
            continue
    return out
