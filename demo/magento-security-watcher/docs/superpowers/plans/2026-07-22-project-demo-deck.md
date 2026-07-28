# Project Demo Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付单文件 `docs/demo.html`，11 屏键盘翻页演示，覆盖价值、流程、架构、AI、量化。

**Architecture:** 纯静态 HTML + 内嵌 CSS/JS；分屏用 `.slide` 全屏切换；架构图用内联 SVG；数字按实现当日库快照写死。

**Tech Stack:** HTML5、CSS、Vanilla JS；无构建、无 npm。

## Global Constraints

- 文案用「通知」，不用「告警」
- 优势第三条：「引入 AI 分析」
- 无数据脚注
- 不展示 git token / API Key
- 视觉对齐看板冷灰蓝 + teal（`--accent: #0d9488`）
- 无法量化处用形容词，不编造「省 X 小时」

**Metrics snapshot (实现写入):**

| 指标 | 值 |
|------|-----|
| 配置项目（启用） | 1（corpsales） |
| 公告 | 2 |
| RiskItem | 2 |
| Finding | 0（标「尚未产生」） |
| 扫描跑次 | 0（标「尚未产生」） |

---

### Task 1: 创建 `docs/demo.html` 完整演示页

**Files:**
- Create: `docs/demo.html`

**Interfaces:**
- Consumes: 规格 `docs/superpowers/specs/2026-07-22-project-demo-deck-design.zh.md`
- Produces: 可双击打开的 11 屏演示

- [ ] **Step 1: 写入完整 `docs/demo.html`**

单文件包含：

1. CSS：`:root` 色板（对齐 `app.css`）、`.deck` / `.slide` 全屏、页码/圆点、架构 SVG 样式、2～3 个克制动效（fade）
2. 11 个 `<section class="slide">` 按规格大纲
3. 第 5 屏内联 SVG 架构图（Adobe/NVD/补丁 → Ingest+LLM → Store ← Git/Inventory → Finding → 企微通知 / Web 看板）
4. JS：`ArrowLeft`/`ArrowRight`/Space 翻页；圆点跳转；`hash` 可选同步页码
5. 量化屏：上表实数；Finding/扫描写「尚未产生」；定性一句

- [ ] **Step 2: 浏览器或本地抽查**

Run: `open docs/demo.html`（macOS）或目视确认文件存在且含 11 个 `class="slide"`、含「引入 AI 分析」、含「通知」、不含「告警」、不含 `s7Cysn` 等 token。

Expected: 文件可读；文案约束满足。

- [ ] **Step 3: Commit（若仓库可用）**

当前工作区若无 `.git` 则跳过。若有 git：

```bash
git add docs/demo.html docs/superpowers/plans/2026-07-22-project-demo-deck.md
git commit -m "docs: add static project demo slide deck"
```

---

## Spec coverage

| 规格项 | 任务 |
|--------|------|
| 11 屏大纲 | Task 1 |
| 架构图 | Task 1 第 5 屏 |
| 通知 / 引入 AI 分析 | Task 1 文案 |
| 真实量化 | Task 1 快照表 |
| 无脚注、无密钥 | Task 1 验收 |
| 键盘翻页 | Task 1 JS |
