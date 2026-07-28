# Magento2 Security Watcher — 设计规格

**日期：** 2026-07-21  
**状态：** 已批准的基线

## 目标

- 接入 Adobe/Magento 安全公告，并按每条 **RiskItem**（风险项）分析，而非以整份公告为单位。
- 多源情报（v1）：官方公告 + NVD（按 CVE）+ 补丁/diff 代码。
- 从 git 扫描已配置的 Magento 项目（使用配置的分支；假定 vendor 已存在）。
- 基于确定性的版本匹配与内容指纹匹配，判定修复状态。
- 企业微信告警（带去重）；本地 SQLite + 报告文件留存历史。
- 混合式 AI：叙述文案、可选的结构化辅助、指纹*草稿*；扫描时 AI 永不判定 fixed/vulnerable。

## 架构

Python 模块化 CLI + cron + SQLite（方案 1）。同一服务层后续可加 FastAPI 外壳（方案 2）。

### 模块

| 模块 | 职责 |
|------|------|
| AdvisoryIngest | 公告 → RiskItems、NVD、补丁、报告 |
| GitWorkspace | 远程拉取/检出已配置分支 |
| MagentoInventory | 从 composer.lock / 产品版本提取信息 |
| FingerprintBuilder | 基于规则 + AI 草稿，从补丁生成指纹 |
| VersionAndContentMatcher | 确定性的修复结论判定 |
| LLM_Reporter | RiskItem / 项目叙述（可选） |
| Store | SQLite 持久化 |
| WeComNotifier | 告警投递，基于 alert_state 去重 |
| CLI | `ingest` / `scan` / `notify` / `status` |

### 数据模型

```text
Bulletin（公告）
  └── RiskItem（风险项，主要分析与告警单元）
        └── Finding（发现：项目 × 风险项）
```

Finding 字段额外包含：`remediation_status`、`fix_method`、`evidence`。

### 修复判定规则（保守）

- 版本 ≥ 已修复版本 → `fixed` / `upgrade`
- 版本受影响 + 内容 after 匹配 → `fixed` / `patch_content`
- 版本受影响 + 内容 before 匹配 → `vulnerable`
- 文件缺失 / 均不匹配 / 需要补丁却无指纹 → `unknown`
- 无证据时永不自动标为 `fixed`；v1 不做声明层（composer-patches）检测

### 指纹

每个 hunk：文件路径 + before 片段 + after 片段。多 hunk：所有关键 hunk 均须呈现已修复，才算 `patch_content` 成功。

### 不在范围内（v1）

Web UI、声明层检测、NVD 以外的社区情报源、AI 扫描结论、默认高并发。

## 运维

- Debian 服务器；密钥走环境变量；项目/配置用 YAML。
- Cron：先 `ingest`，再 `scan --notify`；默认串行扫描各项目。
