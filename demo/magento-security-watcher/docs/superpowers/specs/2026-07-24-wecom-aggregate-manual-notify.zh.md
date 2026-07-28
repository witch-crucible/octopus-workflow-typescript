# 企微通知聚合 + 详情页手动发送

日期：2026-07-24

## 目标

1. 降低企微噪音：扫描结果按**项目**一条；入库情报按**公告**一条（不列 CVE）。
2. 项目详情 / 公告详情可**手动强制推送**到企微（二次确认）。

## 行为

### 项目通知（scan --notify / notify / notify-pending）

- 每个项目最多 **1** 条企微消息（不再按 risk 逐条）。
- 内容建议：
  - 项目名、未修数、未知数、已修数（本轮纳入通知的状态）
  - 按公告分组的摘要行：`APSB…` · 未修/未知数 · 最高等级
  - 不逐条展开 CVE 标题（避免过长）
- 纳入状态：与现网一致 — `vulnerable` / `unknown` / `fixed`（`not_applicable` 不发）。
- 去重 key：`project:{project_id}`  
  指纹：该项目本轮参与汇总的 finding 的 `(risk_id, status, evidence_fingerprint)` 排序后哈希。
- `@all`：`mention_all_on_critical` 且项目内存在 **Critical** 且状态为 `vulnerable`/`unknown` 时开启。
- 扫描失败通知不变：`scan_error:{project_id}`。

### 公告通知（ingest --notify-new）

- 本轮某公告下有**新建** RiskItem 时，该公告发 **1** 条（不按 risk）。
- 内容：公告 ID/标题、等级概览、业务影响摘要、支持的修复方式摘要（来自 `bulletins.analysis_json`）；**不列 CVE / risk 列表**。
- 去重 key：`bulletin:{external_id}`  
  指纹：可由公告 analysis 关键字段 + 本轮新建 risk 数量等组成哈希。
- `@all`：公告分析或关联新建风险中含 Critical 且开启配置时。

### 详情页手动发送

- 项目详情、公告详情各加「发送通知」按钮。
- 浏览器 `confirm` 二次确认后：
  - `POST /projects/{project_id}/notify`
  - `POST /bulletins/{external_id}/notify`
- **强制发送**：绕过 `should_notify` 去重；成功后仍写入/更新对应 `alert_state`。
- 消息体与自动通知同模板（项目汇总 / 公告摘要）。
- 企微未启用、缺 webhook、HTTP 失败：返回 JSON/页面可展示的错误；不静默成功。
- 白名单：与现有 Web 一致（`web.allowed_cidrs`）。

## CLI / API 影响

| 入口 | 变化 |
|------|------|
| `msw scan --notify` / `msw notify` | 改为项目级聚合发送 |
| `msw notify-pending` | 同上，不扫代码 |
| `msw ingest --notify-new` | 改为公告级一条 |
| Web POST notify | 新增；不触发 ingest/scan |

## 实现要点（预期文件）

- `notify.py`：聚合格式化、`notify_project` / `notify_bulletin`、强制发送参数
- `scan.py` / `ingest.py`：调用聚合接口，去掉逐 risk 发送
- `web/views.py` + 详情模板 + 少量 JS：按钮与 POST
- 测试：`test_notify*` / `test_web` 覆盖聚合与强制发送

## 非目标

- 不按「项目 × 公告」拆条。
- Web 不触发 ingest / scan。
- 不清理历史 `finding:…` / `ingest:…` 旧 alert_state（可并存忽略）。
- 不改 PDF 导出、不改扫描增量逻辑。

## 决策记录

- 项目粒度：A（每项目一条汇总）
- 公告粒度：B（情报摘要，不列 CVE）
- 手动按钮：C（强制发送 + confirm）
