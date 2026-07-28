# 企微通知聚合 + 手动发送 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or implement inline. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 扫描/补发按项目一条企微；入库按公告一条；详情页可强制推送。

**Architecture:** `notify.py` 提供 `notify_project` / `notify_bulletin`（`force` 绕过去重）；scan/ingest/notify-pending 改调聚合接口；Web `POST …/notify` + 确认按钮。

**Tech Stack:** Python、FastAPI、Jinja、现有 `alert_state` / WeCom webhook。

**Spec:** `docs/superpowers/specs/2026-07-24-wecom-aggregate-manual-notify.zh.md`

## Global Constraints

- 文案用「通知」
- 公告消息不列 CVE
- 手动强制发送 + confirm
- 不触发 Web ingest/scan

---

### Task 1: notify 聚合核心

**Files:** Modify `src/magento_security_watcher/notify.py`; `tests/test_notify.py`

- [ ] `alert_key_project` / `alert_key_bulletin`、`format_project_summary`、`format_bulletin_summary`
- [ ] `notify_project(..., force=False)` / `notify_bulletin(..., force=False)`
- [ ] `notify_pending` 按项目聚合
- [ ] 测试：聚合去重、force 重发、Critical @all、pending 按项目计 1

### Task 2: scan / ingest 接线

**Files:** `scan.py`, `ingest.py`; 相关测试

- [ ] scan 成功后对 latest findings 调 `notify_project`
- [ ] ingest `--notify-new`：公告有新建 risk 时，在 bulletin analysis 写入后调 `notify_bulletin`

### Task 3: Web 手动发送

**Files:** `web/views.py`, `project_detail.html`, `bulletin_detail.html`, `base.html`, `test_web.py`

- [ ] `POST /projects/{id}/notify`、`POST /bulletins/{id}/notify`（JSON，force）
- [ ] 按钮 + confirm + fetch
- [ ] 测试：强制发送更新 alert_state

### Task 4: README 简述 + 全量 pytest

- [ ] 更新 README 通知粒度说明
- [ ] `pytest` 全绿
