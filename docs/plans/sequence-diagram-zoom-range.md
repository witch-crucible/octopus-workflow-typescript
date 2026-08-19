# 泳道时序图缩放范围扩展

> 给实现代理的可执行设计。
>
> 日期：2026-08-19  
> 状态：Draft  
> 范围：packages/desktop（renderer.js + index.html）  
> 约束：最小改动；沿用现有 vanilla renderer 与现有缩放机制。

---

## 1. 目标与成功标准

扩大需求泳道时序图的缩放能力，当前范围为 90% ~ 220%，目标为 **20% ~ 500%**，并配合等比步进与「内容小于视口时居中」。

成功标准（全部满足才算完成）：

- 缩放范围放宽到 **20%（0.2）~ 500%（5）**，按钮与 Ctrl/⌘+滚轮都能到达两端。
- 缩放步进改为**等比**：按钮 ×1.2 / ÷1.2；滚轮按 intensity 等比（放大 ×(1+i)，缩小 ÷(1+i)，i ∈ [0.08, 0.35]）。
- 缩放后内容小于可视区域时，图在可视区**居中**显示；内容大于可视区域时仍可正常滚动，行为与现在一致。
- 重置按钮恢复到默认倍率（宽屏 1.4 / 窄屏 1），默认倍率不变。
- 点击节点坐标换算、拖拽平移、缩放锚点修正、百分比 label 在任意倍率下仍正确。
- `pnpm --filter @octopus/desktop build` 通过；应用内手动验证通过。

### 非目标

- 不改默认初始倍率（1.4 / 1）与重置逻辑。
- 不做「适应窗口」一键缩放。
- 不改缩放锚点算法（transform-origin: 0 0 + 滚动偏移修正）。
- 不引入测试框架；renderer 为纯 JS 无单元测试，以构建 + 手动验证为准。

---

## 2. 现状（实现前必须对照的事实）

| 项 | 现在 | 文件:行 |
| --- | --- | --- |
| 缩放状态 | `let graphZoom = window.innerWidth < 900 ? 1 : 1.4` | `renderer.js:63` |
| 缩放 clamp | `Math.min(2.2, Math.max(0.9, Math.round(next * 100) / 100))` | `renderer.js:1292` |
| 应用缩放 | CSS `transform: scale()` + 撑开 scaler 宽高 | `renderer.js:1279-1288` |
| 锚点修正 | 按 `graphZoom / before` 比例修正 scrollLeft/Top | `renderer.js:1290-1306` |
| 滚轮缩放 | 线性：`graphZoom + direction * Math.max(0.08, intensity)` | `renderer.js:1308-1320` |
| 按钮 | `setGraphZoom(graphZoom + 0.15)` / `- 0.15` | `renderer.js:2136-2137` |
| 重置 | `setGraphZoom(defaultGraphZoom())` | `renderer.js:2138` |
| 默认倍率 | 宽屏 1.4 / 窄屏 1 | `renderer.js:2132-2134` |
| scaler CSS | `transform-origin: 0 0; min-width: 100%` | `index.html:793-797` |
| wrap CSS | `overflow: auto` 滚动容器 | `index.html:776-785` |

---

## 3. 变更点

### 3.1 `packages/desktop/src/renderer/renderer.js`

1. **clamp 放宽**（L1292）：
   ```js
   const clamped = Math.min(5, Math.max(0.2, Math.round(next * 100) / 100))
   ```

2. **按钮等比步进**（L2136-2137）：
   ```js
   document.getElementById("zoomIn").onclick = () => setGraphZoom(graphZoom * 1.2)
   document.getElementById("zoomOut").onclick = () => setGraphZoom(graphZoom / 1.2)
   ```

3. **滚轮等比步进**（L1308-1320）：intensity 仍为 `Math.min(0.35, Math.abs(deltaY)/240)`，
   `direction` 由 `deltaY` 符号决定（`deltaY > 0 ? -1 : 1`，与现状一致：向下滚缩小、向上滚放大），改为：
   ```js
   setGraphZoom(direction > 0
     ? graphZoom * (1 + Math.max(0.08, intensity))
     : graphZoom / (1 + Math.max(0.08, intensity)), { clientX, clientY })
   ```

4. **`applyGraphZoom` 切换居中类**（L1279-1288）：计算缩放后内容尺寸与视口尺寸，
   内容小于视口时给 `graphWrapEl` 加 `is-centered` 类，否则移除：
   ```js
   const contentW = width * graphZoom
   const contentH = height * graphZoom
   if (graphWrapEl) {
     const centered = contentW < graphWrapEl.clientWidth - padX || contentH < graphWrapEl.clientHeight - padY
     graphWrapEl.classList.toggle("is-centered", centered)
   }
   ```
   `graphWrapEl.clientWidth/Height` 含 padding，比较时减去 wrap 的左右 padding（16px）
   与上下 padding（12+16=28px），避免边缘贴死。

### 3.2 `packages/desktop/src/renderer/index.html`

在 `.graph-wrap` 规则附近新增：

```css
.graph-wrap.is-centered {
  display: flex;
  align-items: safe center;
  justify-content: safe center;
}
.graph-wrap.is-centered .graph-scaler {
  min-width: 0;
}
```

说明：`safe center` 在内容溢出时自动退化为起点对齐，滚动与拖拽平移不受影响；
居中模式下去掉 `min-width:100%`，否则 scaler 不会收缩到视口以下。

---

## 4. 不变项与兼容性

- 初始倍率（1.4/1）、重置逻辑、`defaultGraphZoom()` 不变。
- `transform-origin: 0 0` 不变；缩放锚点修正（L1290-1306）是纯比例运算，任意倍率有效。
- 节点点击坐标换算（L512-513）、`scrollCurrentNodeIntoView`（L505-525）为比例运算，不变。
- 拖拽平移（`graphPan`）不变；居中模式下内容小于视口时 scroll 范围为 0，平移自然无效果。
- 工作区中 `packages/desktop/package.json`、`packages/workflow-engine/tsconfig.json`
  的未提交改动与本需求无关，不触碰。

---

## 5. 边界情况

| 场景 | 预期 |
| --- | --- |
| 500% 放大 | SVG 矢量渲染清晰；节点文字可读；滚动区域足够大 |
| 20% 缩小 | 图居中显示，可视区滚动量为 0 |
| 跨「居中 ↔ 非居中」阈值缩放 | 锚点修正可能有极小跳动，可接受 |
| 窗口 resize | flex 居中自动重排，无需额外 JS 监听 |
| 快速连滚/连点 | clamp + 四舍五入兜底，不越界 |

---

## 6. 验证

1. `pnpm --filter @octopus/desktop build` 通过（tsc -b 类型检查）。
2. 应用内手动验证：
   - 按钮连点放大可到 500%、缩小可到 20%，label 显示对应百分比。
   - Ctrl/⌘+滚轮缩放：方向正确，能到达两端。
   - 重置按钮回到 140%（宽屏）/ 100%（窄屏）。
   - 缩小到 20% 图居中；放大后居中类移除、可正常滚动。
   - 缩放过程中鼠标锚点位置不漂移（滚轮缩放时指针所指内容保持）。
   - 窗口 resize 后居中状态正确。
   - 点击节点仍能选中/高亮，坐标换算正确。
