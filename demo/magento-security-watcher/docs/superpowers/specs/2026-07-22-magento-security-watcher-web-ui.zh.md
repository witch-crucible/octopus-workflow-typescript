# Magento2 Security Watcher — Web 看板设计规格

**日期：** 2026-07-22  
**状态：** 已批准并实现  
**前置：** [基线设计](2026-07-21-magento-security-watcher-design.zh.md)（方案 2：同一服务层上的 FastAPI 外壳）

## 1. 目标

在内网提供只读 Web 看板，替代直接查 SQLite，便于查看：

- 已配置项目的扫描结论与风险概述
- 已入库的全部 RiskItem（风险项）情报
- 单项目下各风险的修复状态（未修复详展、已修复折叠）
- 扫描跑次与企微通知状态（摘要级）

**不改变**现有 ingest / scan / 判定逻辑；Web 只读展示 Store 与配置中的数据。

## 2. 非目标（v1）

- 登录 / SSO / RBAC
- 页面上触发 ingest / scan / notify
- 导出 Markdown/CSV 的完整实现（仅预留入口）
- React/Vue 等前端构建链、暗黑主题切换、图表大屏
- 修改指纹匹配或告警去重规则

## 3. 技术选型

| 项 | 选择 | 说明 |
|----|------|------|
| 框架 | FastAPI | 与既有 `api.py` 外壳同方向 |
| 页面 | Jinja2 SSR | 无 npm 构建，适合内网运维机 |
| 样式 | 自研 CSS + CSS 变量 | 有设计感；不用 Bootstrap 默认皮 |
| 折叠 | 原生 `<details>` | 已修复区折叠 |
| 进程 | `msw serve` → uvicorn | 与 CLI 同一安装 |

数据流：

```text
浏览器 → IP 白名单中间件 → FastAPI 视图 → Store 查询 / projects.yaml
                              ↓
                         Jinja2 模板 + 静态 CSS → HTML
```

运维写接口（POST ingest/scan）**不挂载**到对外看板应用；继续走 CLI / cron。

## 4. 安全

### 4.1 无登录 + IP 白名单

- 不实现账号体系；访问控制靠网络层 + 应用层 CIDR 白名单。
- `settings.yaml` 增加 `web` 段：

```yaml
web:
  host: "0.0.0.0"
  port: 8080
  allowed_cidrs:
    - "127.0.0.1/32"
    - "::1/128"
    - "192.168.0.0/16"   # 按实际内网调整
  trust_x_forwarded_for: false
```

- 客户端 IP 不在白名单 → **403**。
- `allowed_cidrs` 为空时：默认仅 loopback（防止误绑 `0.0.0.0` 后裸奔）。
- `trust_x_forwarded_for: false`（默认）：只用直连 IP，防止伪造 `X-Forwarded-For`；仅在确有可信反代时再开启。

### 4.2 敏感信息

- `projects.yaml` 的 `git_url` 可能含 token：界面只展示脱敏摘要（如 `https://***@git.example/...` 或 host + path），**禁止**回显明文密钥。
- 报告文件通过受控路由读取，根目录限制在 `data/reports`（或配置的 reports 目录），拒绝路径穿越。

## 5. 数据语义

### 5.1 「最新结论」

`findings` 表为历史追加。列表与项目详情统一使用：

> 每个 `(project_id, risk_id)` 取 `id` 最大的一条作为当前结论，并展示对应 `created_at` / 关联 scan 时间。

### 5.2 JSON 拆开展示

| 来源 | 展示方式 |
|------|----------|
| `evidence_json` | 版本证据块 + hunk 表（path / result / detail）+ warnings 列表 |
| `analysis_json` / `analysis_snapshot_json` | 按 `RiskItemAnalysis` 字段分区（标题、CVE、严重度、业务影响、修复选项、包、指纹、材料、confidence、source_missing、narrative） |
| `raw` 及无法解析的 JSON | `<details>` + `<pre>` 原文 |

中文标签复用 `i18n_zh`（严重度、修复状态、fix_method 等）。

### 5.3 修复选项

展示 `remediation_options`：孤立补丁 / 可升级 **并列**；`recommended_min_versions` 列表；legacy `remediation_offer` 可作次要字段。

## 6. 信息架构与页面

| 路由 | 页面 | 内容要点 |
|------|------|----------|
| `GET /` | 总览 | 库表计数；未修复 finding 数；最近扫描失败；入口导航 |
| `GET /projects` | 项目列表 | 见 §6.1 |
| `GET /projects/{id}` | 项目详情 | 见 §6.2 |
| `GET /projects/{id}/export` | 导出占位 | v1 返回 501 + 说明文案 |
| `GET /risks` | 风险列表 | 见 §6.3 |
| `GET /risks/{risk_id}` | 风险详情 | 完整分析字段 + 报告链接 |
| `GET /bulletins` | 公告列表 | 标题、日期、关联 risk 数、外链 |
| `GET /files/...` | 报告只读 | 限定 reports 目录 |
| `GET /health` | 健康检查 | 可不受白名单或同样受白名单（实现时与白名单策略一致并写明） |

### 6.1 项目列表 `/projects`

每行至少：

| 字段 | 说明 |
|------|------|
| 名称 / id | 来自 `projects.yaml` |
| enabled | 是否参与扫描 |
| owners | 可原文展示邮箱 |
| 分支 | `branch`；git 仅脱敏摘要 |
| 风险概述 | 基于最新 finding 的 status 计数：vulnerable / fixed / unknown / error / not_applicable |
| 最后扫描 | 最近 `scan_runs` 的 finished_at + status（失败则露出 error 摘要） |
| 通知状态 | 该项目相关 `alert_state` 最近 `last_notified_at`，或「有未修复且无通知记录」简标 |

### 6.2 项目详情 `/projects/{id}`

1. **页头**：项目元数据（脱敏）+ 最近一次 scan_run + alert 摘要；导出按钮（禁用或链到 501 占位）。
2. **扫描历史**（区块或短表）：近期 `scan_runs`（时间、commit、status、error）。
3. **Findings**：
   - **需关注**（`vulnerable` / `unknown` / `error`）：默认展开——状态、fix_method、evidence 拆开、analysis 快照关键字段、project_narrative、报告链接。
   - **已处理**（`fixed` / `not_applicable`）：`<details>` 折叠，摘要一行（risk_id、标题、状态、严重度），展开后同结构。

### 6.3 风险列表 `/risks`

列：risk_id、标题、CVE、severity/score、bulletin、补丁/升级标志、建议最低版本、confidence、source_missing、入库/更新时间。

查询参数筛选（v1）：severity、是否有 CVE、是否有 source_missing。

## 7. 视觉设计

### 7.1 调性

**「夜航雷达 / 技术监控台」**：浅色主界面；冷灰蓝背景 + 细网格或径向淡晕；强调色 **青绿（teal）**；严重度 **琥珀 → 砖红** 阶梯。

避免：紫霓虹渐变、奶油衬线 Terracotta、满屏 rounded-full pill、营销大 hero。

顶栏品牌锚点：**Magento Security Watcher**（副标 MSW），字重高于普通导航链接。

### 7.2 字体与色板

- 标题/UI：`IBM Plex Sans`（CDN；内网不通外网时改本地 woff2，README 注明）
- 等宽（路径、指纹、JSON）：`IBM Plex Mono`
- CSS 变量：`--bg`、`--ink`、`--muted`、`--accent`、`--sev-critical|high|medium|low`、`--ok`、`--warn`、`--line`

### 7.3 布局

- 顶栏：品牌 + 导航（总览 / 项目 / 风险 / 公告）
- 总览：少量关键数字 + 近期动态列表（非卡片墙、非营销 stat 贴纸）
- 列表：全宽表格式；行 hover；严重度左侧色条或小矩形色标
- 详情：分区标题 + 定义列表 / 小节表

### 7.4 动效（克制，2～3 个）

1. 主内容短 fade-in（~200ms）
2. 表格行 hover 背景过渡
3. `<details>` 展开内容淡入

## 8. 模块与配置

```text
src/magento_security_watcher/web/
  app.py           # create_app、静态资源、路由挂载
  middleware.py    # IP 白名单
  views.py         # 页面路由
  presenters.py    # JSON 拆开、脱敏、中文标签辅助（命名可调整）
  templates/       # base.html + 各页
  static/app.css   # 设计系统
```

Store 扩展查询（示例职责）：

- 每项目最新 finding 列表 / 按 status 计数
- risk_items 列表与单条（解析 analysis_json）
- scan_runs、alert_state、bulletins

CLI：`msw serve [--host] [--port]`；依赖 `fastapi`、`uvicorn`、`jinja2` 纳入主依赖。

## 9. 测试

- Store「最新 finding」聚合正确性
- IP 白名单：允许 / 拒绝
- 关键页面 HTTP 200；脱敏断言（页面 HTML 不含 git token 明文）
- 导出占位返回 501

## 10. 验收标准

1. 内网浏览器可打开总览、项目列表、风险列表、项目详情、风险详情、公告列表。
2. 非白名单 IP 得到 403。
3. 项目详情：未修复默认展开、已修复默认折叠；evidence / analysis 字段可读分区展示。
4. git 凭据不出现在任何 HTML 响应中。
5. `msw serve` 可启动；文档说明白名单与离线字体改法。
6. 导出入口存在且标明后续实现。

## 11. 后续（非 v1）

- 项目详情导出 Markdown / CSV
- 可信反代下的 `X-Forwarded-For` 策略落地与文档
- 可选：只读 JSON API 供其它系统对接
- 基线设计中的其它 Web 增强（若有）另开规格
