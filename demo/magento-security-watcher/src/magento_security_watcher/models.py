from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class Severity(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    NONE = "none"
    UNKNOWN = "unknown"


class RemediationOffer(str, Enum):
    """Legacy aggregate for matcher; prefer remediation_options for display."""

    UPGRADE_ONLY = "upgrade_only"
    PATCH_ONLY = "patch_only"
    UPGRADE_OR_PATCH = "upgrade_or_patch"
    UNKNOWN = "unknown"


class RemediationOptions(BaseModel):
    """Patch and upgrade are independent; both may be true."""

    has_isolated_patch: bool = False
    upgrade_available: bool = False
    recommended_min_versions: List[str] = Field(default_factory=list)
    notes: Optional[str] = None

    def to_offer(self) -> RemediationOffer:
        if self.has_isolated_patch and self.upgrade_available:
            return RemediationOffer.UPGRADE_OR_PATCH
        if self.has_isolated_patch:
            return RemediationOffer.PATCH_ONLY
        if self.upgrade_available:
            return RemediationOffer.UPGRADE_ONLY
        return RemediationOffer.UNKNOWN


class RemediationStatus(str, Enum):
    NOT_APPLICABLE = "not_applicable"
    VULNERABLE = "vulnerable"
    FIXED = "fixed"
    UNKNOWN = "unknown"
    ERROR = "error"


class FixMethod(str, Enum):
    NONE = "none"
    UPGRADE = "upgrade"
    PATCH_CONTENT = "patch_content"
    UPGRADE_AND_PATCH = "upgrade_and_patch"
    UNKNOWN = "unknown"


class ContentFingerprint(BaseModel):
    path: str
    before: Optional[str] = None
    after: Optional[str] = None
    hunk_id: Optional[str] = None
    critical: bool = True


class PackageConstraint(BaseModel):
    name: str
    affected_versions: Optional[str] = None
    fixed_version: Optional[str] = None


class SourceMaterial(BaseModel):
    kind: str  # official | nvd | patch
    url: Optional[str] = None
    local_path: Optional[str] = None
    excerpt: Optional[str] = None


class RiskItemAnalysis(BaseModel):
    title: str
    cve_ids: List[str] = Field(default_factory=list)
    severity: Severity = Severity.UNKNOWN
    score: Optional[float] = None
    score_source: Optional[str] = None
    business_impact: Optional[str] = None
    technical_summary: Optional[str] = None
    remediation_offer: RemediationOffer = RemediationOffer.UNKNOWN
    remediation_options: RemediationOptions = Field(default_factory=RemediationOptions)
    packages: List[PackageConstraint] = Field(default_factory=list)
    fingerprints: List[ContentFingerprint] = Field(default_factory=list)
    materials: List[SourceMaterial] = Field(default_factory=list)
    confidence: float = 0.0
    source_missing: List[str] = Field(default_factory=list)
    narrative: Optional[str] = None
    raw: Dict[str, Any] = Field(default_factory=dict)


class BulletinAnalysis(BaseModel):
    """LLM (+ deterministic) summary for an entire APSB bulletin."""

    summary: Optional[str] = None
    business_impact_scope: Optional[str] = None
    remediation_summary: Optional[str] = None
    has_isolated_patch: bool = False
    upgrade_available: bool = False
    recommended_min_versions: List[str] = Field(default_factory=list)
    affected_version_summary: Optional[str] = None
    cve_ids: List[str] = Field(default_factory=list)
    severity_overview: Optional[str] = None
    reference_links: List[Dict[str, str]] = Field(default_factory=list)
    source_missing: List[str] = Field(default_factory=list)
    raw: Dict[str, Any] = Field(default_factory=dict)


class BulletinRecord(BaseModel):
    external_id: str
    title: str
    published_at: Optional[datetime] = None
    url: Optional[str] = None
    raw_text: Optional[str] = None
    analysis: Optional[BulletinAnalysis] = None


class RiskItemRecord(BaseModel):
    risk_id: str
    bulletin_external_id: str
    analysis: RiskItemAnalysis
    report_path: Optional[str] = None


class HunkVerdict(BaseModel):
    path: str
    hunk_id: Optional[str] = None
    result: str
    detail: str


class FindingEvidence(BaseModel):
    version: Dict[str, Any] = Field(default_factory=dict)
    content: List[HunkVerdict] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)


class FindingRecord(BaseModel):
    project_id: str
    risk_id: str
    remediation_status: RemediationStatus
    fix_method: FixMethod
    evidence: FindingEvidence = Field(default_factory=FindingEvidence)
    analysis_snapshot: Optional[RiskItemAnalysis] = None
    project_narrative: Optional[str] = None
    report_path: Optional[str] = None
    evidence_fingerprint: str = ""


class ProjectConfig(BaseModel):
    id: str
    name: Optional[str] = None
    git_url: str
    branch: str = "main"
    enabled: bool = True
    owners: List[str] = Field(default_factory=list)
    profile: Dict[str, Any] = Field(default_factory=dict)
