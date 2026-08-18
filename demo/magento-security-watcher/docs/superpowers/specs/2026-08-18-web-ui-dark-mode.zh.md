# Magento Security Watcher — Web 看板黑/白模式（暗色主题）设计规格

**日期：** 2026-08-18  
**状态：** 已批准并实现  
**前置：** [Web 看板设计规格](2026-07-22-magento-security-watcher-web-ui.zh.md)

## 1. 目标

为 Magento Security Watcher Web 看板（FastAPI + Jinja2 SSR，单 CSS 文件）增加**黑白模式（浅色/深色主题）**支持：

- **自动跟随系统**：默认跟随 `prefers-color-scheme`，纯 CSS 响应，无 JS 参与
- **手动三态切换**：`自动 / 浅色 / 深色`，点击顶栏按钮循环切换
- **localStorage 持久化**：键名 `msw-theme`（值 `light` / `dark`；auto 时删除或置空）
- **深蓝灰低饱和暗色配色**：与现有 teal 强调色协调，severity / ok / warn 状态色使用亮化版本
- **打印恒为浅色**：`@media print` 压过暗色变量

**不改变**现有公开行为：所有既有测试断言保持不变，后端逻辑、视图、路由零改动。

## 2. 非目标

- 不引入构建链 / 框架 / 图标库（保持无 npm、无打包）
- 不做暗色下的图片反色、自定义滚动条主题等进阶样式
- 不做每用户独立主题（无登录体系，主题仅存浏览器 localStorage）
- 不向后端上报主题偏好
- 不支持 JS 时仍提供跟随系统的降级（可接受，不做静态回退开关）

## 3. 技术选型

| 项 | 选择 | 说明 |
|----|------|------|
| 主题机制 | CSS 变量 + `data-theme` 属性 | 单入口变量层，无需 JS 做样式替换 |
| 自动跟随 | `@media (prefers-color-scheme: dark)` | 纯 CSS；`auto` 态不设 `data-theme` |
| 手动锁定 | `:root[data-theme="dark"]` / `:root[data-theme="light"]` | JS 写/删属性与 localStorage |
| 持久化 | `localStorage` 键 `msw-theme` | 值 `light` / `dark`；auto 删除 |
| 防 FOUC | `<head>` 内联脚本 | 渲染前同步 `data-theme`，早于样式表加载 |
| 切换逻辑 | 原生 JS IIFE（沿用现有脚本风格） | 无现代语法糖，兼容旧浏览器 |
| 打印 | `@media print` 变量覆盖 | 选择器写 `:root, :root[data-theme="dark"]` 保证压过暗色块 |

## 4. 设计

### 4.1 三态模型

| 模式 | `<html>` 属性 | `localStorage["msw-theme"]` | 生效样式来源 |
|------|--------------|-----------------------------|--------------|
| 自动 | 无 `data-theme` | 删除 | `@media (prefers-color-scheme: dark)` 媒体查询 |
| 浅色 | `data-theme="light"` | `"light"` | `:root` 默认变量 |
| 深色 | `data-theme="dark"` | `"dark"` | `:root[data-theme="dark"]` 变量块 |

### 4.2 暗色变量表（关键色值）

深蓝灰低饱和色板：

| 变量 | 浅色（默认） | 深色 |
|------|--------------|------|
| `--bg` | `#e8eef3` | `#0d1524` |
| `--bg-elevated` | `#f7fafc` | `#151f31` |
| `--ink` | `#1a2332` | `#e2eaf4` |
| `--muted` | `#5c6b7a` | `#8ea0b5` |
| `--accent` | `#0d9488` | `#2dd4bf`（提亮） |
| `--accent-soft` | `rgba(13,148,136,.12)` | `rgba(45,212,191,.12)` |
| `--sev-critical` | `#b91c1c` | `#f87171`（亮化） |
| `--sev-high` | `#c2410c` | `#fb923c` |
| `--sev-medium` | `#d97706` | `#fbbf24` |
| `--sev-low` | `#64748b` | `#94a3b8` |
| `--ok` | `#0f766e` | `#2dd4bf` |
| `--warn` | `#b45309` | `#fbbf24` |
| `--line` | `#c5d0da` | `#2a3950` |
| `--shadow` | `0 1px 0 rgba(26,35,50,.04)` | `0 1px 0 rgba(2,6,12,.3)`（更淡） |
| `--header-bg` | `rgba(247,250,252,.92)` | `rgba(21,31,49,.92)` |
| `--thead-bg` | `rgba(232,238,243,.65)` | `rgba(42,57,80,.55)` |
| `--head-soft` | `rgba(232,238,243,.45)` | `rgba(42,57,80,.4)` |
| `--bg-glow-accent` | `rgba(13,148,136,.14)` | `rgba(45,212,191,.08)` |
| `--bg-glow-blue` | `rgba(30,64,120,.08)` | `rgba(59,130,246,.06)` |
| `--grid-line` | `rgba(26,35,50,.03)` | `rgba(140,160,181,.05)` |
| `--field-bg` | `#ffffff` | `#0f1829` |

说明：

- `pre.raw`（`#1a2332` 背景 / `#e8eef3` 文字）本身即深色代码块，暗色下保持协调，未改动。
- severity / status badge 的半透明背景 rgba 保持不变（叠加在深色底上自然协调），仅文字色经由变量亮化。
- 两个暗色入口（`:root[data-theme="dark"]` 与 `@media (prefers-color-scheme: dark)` 下的 `:root:not([data-theme="light"])`）变量值必须逐项一致，文件内以注释互相标注。

### 4.3 硬编码色提取

为让暗色变量完整生效，将原硬编码色提取为变量（浅色默认值保持视觉不变）：

- `.site-header` 背景 → `var(--header-bg)`
- `table.data th` 背景 → `var(--thead-bg)`
- `.finding-head` 背景 → `var(--head-soft)`
- `body` 渐变 / 网格线三处 rgba → `var(--bg-glow-accent)`、`var(--bg-glow-blue)`、`var(--grid-line)`
- `.filters select` 背景 → `var(--field-bg)`

### 4.4 防 FOUC

`<head>` 内 `<link rel="stylesheet">` 之前插入约 4 行内联脚本（try/catch 包裹）：

```html
<script>
(function () {
  var t = null;
  try { t = localStorage.getItem("msw-theme"); } catch (e) { t = null; }
  if (t === "light" || t === "dark") {
    document.documentElement.setAttribute("data-theme", t);
  }
})();
</script>
```

浏览器在样式表加载前先同步属性，避免首帧闪烁。

### 4.5 切换按钮与逻辑

- 顶栏 `.site-header` 内 `.nav` 之后新增 `<button type="button" class="theme-toggle" data-theme-toggle …>`。
- 按钮样式复用 `.btn` 视觉风格（`var(--bg-elevated)` 背景、`var(--line)` 边框、`var(--muted)` 文字），浅/暗两色下均可读；hover 转 accent。
- 底部既有 IIFE 内追加逻辑（ES5 风格）：
  - `THEME_MODES = ["auto","light","dark"]` 循环数组与中文标签映射
  - `currentThemeMode()`：读 localStorage，非 `light`/`dark` 一律视为 `auto`
  - `applyThemeMode(mode)`：设置/移除 `data-theme`、写/删 localStorage、同步按钮 `aria-label`/`title`/文本
  - 页面加载时同步按钮状态；点击循环到下一态
  - `matchMedia("(prefers-color-scheme: dark)")` 监听系统变化，仅当当前为 auto 时重刷（保守、try/catch 包裹；纯 CSS 本已自动响应，此为可选增强）
  - 无 localStorage（隐私模式）时 try/catch 兜底，静默退化

### 4.6 打印处理

- `@media print` 选择器改为 `:root, :root[data-theme="dark"]`，覆盖浅色所需全部颜色变量并设 `color-scheme: light`，压过暗色块（该选择器在源文件末尾，同特异性下后声明者胜出）。
- `body` 原有 `background: #fff !important; background-image: none !important` 保留，双重保证打印为浅色。

## 5. 无 JS 降级

- 禁用 JS 时：无 `data-theme` 属性 → 自动跟随系统（纯 CSS `@media`），主题可正常使用；仅无法手动切换与持久化。

## 6. 验证

- 页面断言：全部页面（除 `/health` JSON）含 `data-theme-toggle` 与 `msw-theme` 标记。
- 静态资源断言：`/static/app.css` 含 `color-scheme`、`[data-theme="dark"]`、`prefers-color-scheme: dark`、`:root[data-theme="dark"]`。
- 回归：demo 全量测试套件通过。