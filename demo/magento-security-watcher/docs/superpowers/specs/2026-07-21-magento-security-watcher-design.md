# Magento2 Security Watcher — Design Spec

**Date:** 2026-07-21  
**Status:** Approved baseline

## Goals

- Ingest Adobe/Magento security bulletins and analyze each **RiskItem** (not the bulletin as a whole).
- Multi-source intel (v1): official bulletin + NVD (by CVE) + patch/diff code.
- Scan configured Magento projects from git (configured branch; vendor assumed present).
- Deterministic version + content-fingerprint matching for remediation status.
- WeCom alerts with dedupe; local SQLite + report files for history.
- Hybrid AI: narratives, optional structuring help, fingerprint *drafts*; AI never decides fixed/vulnerable at scan time.

## Architecture

Python modular CLI + cron + SQLite (Scheme 1). Same service layer can later gain a FastAPI shell (Scheme 2).

### Modules

| Module | Role |
|--------|------|
| AdvisoryIngest | Bulletin → RiskItems, NVD, patches, reports |
| GitWorkspace | Remote fetch/checkout of configured branch |
| MagentoInventory | composer.lock / product version extraction |
| FingerprintBuilder | Rule + AI draft fingerprints from patches |
| VersionAndContentMatcher | Deterministic remediation verdicts |
| LLM_Reporter | RiskItem / project narrative (optional) |
| Store | SQLite persistence |
| WeComNotifier | Alert delivery with alert_state dedupe |
| CLI | `ingest` / `scan` / `notify` / `status` |

### Data model

```text
Bulletin
  └── RiskItem  (primary analysis & alert unit)
        └── Finding (project × risk_item)
```

Finding fields add: `remediation_status`, `fix_method`, `evidence`.

### Remediation rules (conservative)

- Version ≥ fixed → `fixed` / `upgrade`
- Version affected + content after-match → `fixed` / `patch_content`
- Version affected + content before-match → `vulnerable`
- Missing file / neither match / no fingerprint when patch needed → `unknown`
- Never auto-`fixed` without evidence; no declaration-layer (composer-patches) in v1

### Fingerprint

Per hunk: file path + before snippet + after snippet. Multi-hunk: all critical hunks must show fixed for patch_content success.

### Out of scope (v1)

Web UI, declaration-layer detection, community sources beyond NVD, AI scan verdicts, high default concurrency.

## Ops

- Debian server; secrets via env; YAML for projects/settings.
- Cron: `ingest` then `scan --notify`; serial project scans by default.
