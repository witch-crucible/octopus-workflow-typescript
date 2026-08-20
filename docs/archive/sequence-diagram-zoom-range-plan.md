# 泳道时序图缩放范围扩展 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把需求泳道时序图缩放范围从 90%~220% 扩到 20%~500%，步进改等比（按钮 ×1.2/÷1.2，滚轮按 intensity 等比），内容小于视口时居中。

**Architecture:** 纯前端改动，两个文件：`renderer.js` 改 clamp、步进、居中类切换；`index.html` 加一条 CSS 规则。不改缩放锚点算法与默认倍率。

**Tech Stack:** Electron 33 + 原生 JS renderer（无框架、无测试框架）。

## Global Constraints

- 仅修改 `packages/desktop/src/renderer/renderer.js` 与 `packages/desktop/src/renderer/index.html`。
- 不触碰用户未提交改动：`README.md`、`packages/desktop/package.json`、`packages/workflow-engine/tsconfig.json`。
- 不做本地 commit / push（本仓库工作区有用户 WIP，且本任务未获 commit 授权）。
- 不改默认初始倍率（宽屏 1.4 / 窄屏 1）、不改 `defaultGraphZoom()`、不改 `transform-origin: 0 0`。
- 验证：`pnpm --filter @octopus/desktop build` 必须通过。

---

### Task 1: 扩大缩放范围 + 等比步进 + 居中类切换

**Files:**
- Modify: `packages/desktop/src/renderer/renderer.js:1292`（clamp）
- Modify: `packages/desktop/src/renderer/renderer.js:1279-1288`（applyGraphZoom 居中类）
- Modify: `packages/desktop/src/renderer/renderer.js:1308-1320`（滚轮等比）
- Modify: `packages/desktop/src/renderer/renderer.js:2136-2137`（按钮等比）
- Modify: `packages/desktop/src/renderer/index.html:793-797`（.graph-scaler 规则后加居中 CSS）

**Interfaces:**
- Consumes: 现有 `setGraphZoom(next, anchor)`、`applyGraphZoom()`、`graphWrapEl`、`graphScalerEl`、`graphEl`、`zoomLabelEl`（均已存在，不新增符号）。
- Produces: `graphWrapEl` 新增 `is-centered` class 切换；`graphZoom` 取值范围变为 `[0.2, 5]`。

- [ ] **Step 1: 放宽 clamp**

`renderer.js:1292` 修改：

```js
  const clamped = Math.min(5, Math.max(0.2, Math.round(next * 100) / 100))
```

- [ ] **Step 2: 按钮改等比步进**

`renderer.js:2136-2137` 修改：

```js
document.getElementById("zoomIn").onclick = () => setGraphZoom(graphZoom * 1.2)
document.getElementById("zoomOut").onclick = () => setGraphZoom(graphZoom / 1.2)
```

- [ ] **Step 3: 滚轮改等比步进**

`renderer.js:1308-1320` 修改（`intensity` 与 `direction` 语义不变，向下滚缩小、向上滚放大）：

```js
function setupGraphWheelZoom() {
  if (!graphWrapEl) return
  graphWrapEl.addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    const intensity = Math.min(0.35, Math.abs(event.deltaY) / 240)
    const direction = event.deltaY > 0 ? -1 : 1
    setGraphZoom(direction > 0
      ? graphZoom * (1 + Math.max(0.08, intensity))
      : graphZoom / (1 + Math.max(0.08, intensity)), {
      clientX: event.clientX,
      clientY: event.clientY,
    })
  }, { passive: false })
}
```

- [ ] **Step 4: applyGraphZoom 切换居中类**

`renderer.js:1279-1288` 修改，在设置 scaler 宽高后追加居中判断：

```js
function applyGraphZoom() {
  if (zoomLabelEl) zoomLabelEl.textContent = `${Math.round(graphZoom * 100)}%`
  if (!graphScalerEl || !graphEl) return
  const width = Number(graphEl.getAttribute("width") || 0)
  const height = Number(graphEl.getAttribute("height") || 0)
  graphScalerEl.style.transform = `scale(${graphZoom})`
  // 放大用 transform，同时撑开布局尺寸，保证滚动条能滚到全部内容
  graphScalerEl.style.width = width ? `${Math.ceil(width * graphZoom)}px` : "auto"
  graphScalerEl.style.height = height ? `${Math.ceil(height * graphZoom)}px` : "auto"
  // 内容小于可视区时居中（减去 wrap 内边距，避免贴死边缘）
  if (graphWrapEl && width > 0 && height > 0) {
    const padX = 16 // 左右 padding
    const padY = 28 // 12(上) + 16(下)
    const centered = width * graphZoom < graphWrapEl.clientWidth - padX ||
      height * graphZoom < graphWrapEl.clientHeight - padY
    graphWrapEl.classList.toggle("is-centered", centered)
  }
}
```

- [ ] **Step 5: 添加居中 CSS**

`index.html` 在 `.graph-scaler` 规则（L793-797）之后追加：

```css
      .graph-wrap.is-centered {
        display: flex;
        align-items: safe center;
        justify-content: safe center;
      }
      .graph-wrap.is-centered .graph-scaler {
        min-width: 0;
        flex-shrink: 0;
      }
```

说明：`safe center` 在内容溢出对应轴时退化为起点对齐（该轴仍可滚动）；`flex-shrink: 0` 防止 flex 收缩把宽图压扁导致右侧滚不到。

- [ ] **Step 6: 构建验证**

Run: `pnpm --filter @octopus/desktop build`
Expected: `tsc -b` 通过，无类型错误。构建产物不含 renderer 变更（renderer 是原样拷贝的静态 JS/CSS），但 tsc 能覆盖 `main.ts` 等 TS 侧，避免意外破坏。

- [ ] **Step 7: 代码复查**

逐行核对五个改动点与 Global Constraints：
- clamp 为 `[0.2, 5]`；
- 按钮/滚轮为等比，未残留 `+ 0.15` / `direction *` 线性写法；
- 居中类切换只依赖 `graphWrapEl` 已存在，未引入新 DOM 元素；
- 未触碰用户 WIP 文件。

---

## Self-Review

**1. Spec coverage**（对照 `docs/archive/sequence-diagram-zoom-range.md`）：
- clamp 20%~500% → Step 1 ✅
- 按钮等比 ×1.2/÷1.2 → Step 2 ✅
- 滚轮等比（×1+i / ÷1+i）→ Step 3 ✅
- 内容小于视口居中（含 padding 扣除）→ Step 4 ✅
- CSS flex safe center + min-width 覆盖 → Step 5 ✅
- 构建验证 → Step 6 ✅
- 默认倍率/重置/锚点/坐标换算不变 → 无改动，Global Constraints 覆盖 ✅

**2. Placeholder scan**：无 TBD/TODO，所有代码块为完整实现。✅

**3. Type consistency**：仅改既有函数体，未新增/改名任何符号；`setGraphZoom`、`applyGraphZoom`、`graphWrapEl` 等名字与现状一致。✅
