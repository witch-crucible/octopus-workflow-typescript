# 项目默认颜色设置

> 给实现代理的可执行设计。
>
> 日期：2026-08-19  
> 状态：Draft  
> 范围：packages/desktop + packages/workflow-engine  
> 约束：最小改动；沿用现有项目 metadata 与 OmniPlan 设置模式；暂不绑定任何界面元素。

---

## 1. 目标与成功标准

让每个项目（Project 容器）能够设置并持久化一个**默认颜色**，通过 Web / Electron 设置页配置，后端与前端 API 可读写。

用户已确认的范围：

- 入口仅限 **Web / 桌面设置页**（`项目 → 设置`），不新增 CLI 能力。
- **暂不关联界面元素**：看板卡片、甘特条形图、泳道图等不消费该颜色，留作后续扩展。
- 未设置默认颜色时，项目行为与现在完全一致。

成功标准（全部满足才算完成）：

- 项目设置页出现「默认颜色」面板，可用取色器选择颜色并保存；保存后 `getProject` 返回的 `metadata.defaultColor` 为该色值。
- 提供「清除默认颜色」操作，清除后 `metadata.defaultColor` 不存在（或为空），界面回到未设置状态。
- 非法色值（非 `#rrggbb` 六位十六进制）被拒绝并返回可读错误，不写入 metadata。
- 未设置默认颜色的项目：`metadata` 不含 `defaultColor` 键，所有现有行为不变。
- 验证：`pnpm -r build`（类型检查）、相关单测（`packages/desktop`、`packages/workflow-engine`）通过；Web 设置页手动验证通过。

### 非目标

- 不新增 CLI 命令或参数（`project update` 不加 `--color`）。
- 看板 / 甘特 / 泳道图 / 列表等界面元素不消费默认颜色。
- 不改全局主题色（`index.html` 的 `--el-color-primary`）。
- 不做色板预设或多项目批量设置。

---

## 2. 现状（实现前必须对照的事实）

| 项 | 现在 | 文件:行 |
| --- | --- | --- |
| Project 实体 | `metadata?: Record<string, string>` 已有 | `packages/core/src/project.ts:19-27` |
| OmniPlan 设置存储 | 写入 `metadata["omniplanFolder"]` 等键 | `packages/workflow-engine/src/index.ts:2185-2209` |
| 引擎校验模式 | `setProjectOmniPlanMeta` 校验允许键 | `packages/workflow-engine/src/index.ts:2189-2193` |
| Web API 路由 | `setProjectOmniPlanMeta` case 转发引擎 | `packages/desktop/src/web.ts:440-447` |
| Electron IPC | `octopus:setProjectOmniPlanMeta` handler | `packages/desktop/src/main.ts:273-275` |
| preload 桥接 | `setProjectOmniPlanMeta: (projectId, patch) => ipcRenderer.invoke(...)` | `packages/desktop/src/preload.cjs:12`（同区段） |
| 浏览器 API | `setProjectOmniPlanMeta: (projectId, patch) => invoke(...)` | `packages/desktop/src/renderer/browser-api.js:107` |
| 设置页渲染 | `renderProjectSettings()` 两个 panel-card（Teambition / OmniPlan） | `packages/desktop/src/renderer/renderer.js:1332-1371` |
| 保存后刷新 | `setProjectOmniPlanMeta` 后 `getProject` 更新 `currentProject` | `packages/desktop/src/renderer/renderer.js:1434` |
| 现有测试 | 引擎 `setProjectOmniPlanMeta` 键校验测试 | `packages/workflow-engine/src/index.test.ts:855-866` |

---

## 3. 变更点

### 3.1 `packages/workflow-engine/src/index.ts` — 新增引擎方法

在 `setProjectOmniPlanMeta`（L2185）附近新增：

```ts
/**
 * 设置项目默认颜色（`#rrggbb`）。传入空字符串/null 表示清除。
 */
setProjectDefaultColor(projectId: string, color: string | null): Project {
  const normalized = color === null || color === "" ? "" : color
  if (normalized !== "" && !/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`默认颜色必须是 #rrggbb 格式，收到：${color}`)
  }
  return this.store.updateProject(projectId, (current) => {
    if (!current.metadata) current.metadata = {}
    if (normalized === "") {
      delete current.metadata["defaultColor"]
    } else {
      current.metadata["defaultColor"] = normalized
    }
    return current
  })
}
```

清除语义：删除键（而非写空字符串），使「未设置」与「无键」一致。

### 3.2 `packages/desktop/src/web.ts` — 新增 API 路由

在 `setProjectOmniPlanMeta` case（L440-447）附近新增：

```ts
case "setProjectDefaultColor": {
  const color = args[1] === null || typeof args[1] === "string" ? (args[1] as string | null) : null
  return engine.setProjectDefaultColor(projectId(), color)
}
```

### 3.3 `packages/desktop/src/main.ts` — 新增 IPC handler

在 OmniPlan IPC 区段（L273-275）后新增：

```ts
ipcMain.handle("octopus:setProjectDefaultColor", (_e, projectId: string, color: string | null) => {
  return engine.setProjectDefaultColor(projectId, color ?? null)
})
```

### 3.4 `packages/desktop/src/preload.cjs` — 暴露桥接方法

在 `updateProjectMeta` 附近新增：

```js
setProjectDefaultColor: (projectId, color) =>
  ipcRenderer.invoke("octopus:setProjectDefaultColor", projectId, color),
```

### 3.5 `packages/desktop/src/renderer/browser-api.js` — 浏览器桥接

在 OmniPlan 区段（L104-107）附近新增：

```js
setProjectDefaultColor: (projectId, color) => invoke("setProjectDefaultColor", projectId, color),
```

### 3.6 `packages/desktop/src/renderer/renderer.js` — 设置页面板

在 `renderProjectSettings()`（L1332）的 panel 列表末尾新增「默认颜色」panel-card：

```js
const defaultColor = currentProject?.metadata?.defaultColor || "#6d28d9"
```

HTML 结构（沿用 `.panel-card` / `.field` / `.help` 样式）：

```html
<div class="panel-card">
  <h3>默认颜色</h3>
  <p class="help">项目级默认颜色，暂用于后续扩展；未设置时不影响现有界面。</p>
  <div class="field">
    <label for="settingsDefaultColor">默认颜色</label>
    <input id="settingsDefaultColor" type="color" value="${escapeHtml(defaultColor)}" />
  </div>
  <div class="tb-actions">
    <button id="settingsSaveColor" type="button">保存默认颜色</button>
    <button id="settingsClearColor" class="secondary" type="button">清除</button>
  </div>
</div>
```

事件绑定（放在现有 `settingsSaveOmniplan` 监听器附近）：

- 保存：`settingsSaveColor` → 取 `#settingsDefaultColor` 的值，调用 `window.octopus.setProjectDefaultColor(selectedProjectId, value)`，成功后 `currentProject = await window.octopus.getProject(selectedProjectId)`，`statusEl` 提示「默认颜色已保存」。
- 清除：`settingsClearColor` → 调用 `setProjectDefaultColor(selectedProjectId, null)`，成功后刷新 `currentProject`，并把 `#settingsDefaultColor` 的值重置为 `#6d28d9`（默认展示值），提示「已清除默认颜色」。
- 错误：复用现有 `showError` / `readableError`。

`#6d28d9` 是当前主题主色（`index.html:15`），仅作为取色器默认展示值，不是持久化默认值。

---

## 4. 测试

### 4.1 引擎单测（`packages/workflow-engine/src/index.test.ts`）

在 `setProjectOmniPlanMeta` 测试（L855-866）附近新增：

1. 设置合法色值 `#ff8800` → `metadata.defaultColor === "#ff8800"`。
2. 传入 `null` / `""` → `metadata` 不含 `defaultColor` 键（清除语义）。
3. 非法色值（`red`、`#fff`、`#12345g`）→ 抛错，`metadata` 不变。

### 4.2 Web API 测试（`packages/desktop/src/web.test.ts`）

参照现有 `updateProjectMeta` 测试（L371），新增：

1. `setProjectDefaultColor` 返回最新 Project，含 `metadata.defaultColor`。
2. 非法色值返回 4xx 可读错误。

### 4.3 构建验证

```bash
pnpm -r build        # 类型检查（不生成 dist）
pnpm test            # Vitest 全量测试
```

---

## 5. 变更清单（实现后核对）

- `packages/workflow-engine/src/index.ts`（新增方法）
- `packages/workflow-engine/src/index.test.ts`（新增测试）
- `packages/desktop/src/web.ts`（新增 case）
- `packages/desktop/src/main.ts`（新增 IPC）
- `packages/desktop/src/preload.cjs`（新增桥接）
- `packages/desktop/src/renderer/browser-api.js`（新增桥接）
- `packages/desktop/src/renderer/renderer.js`（设置页 panel + 事件）
- `packages/desktop/src/web.test.ts`（新增测试）

不做本地 commit / push（本仓库工作区有用户 WIP，且本任务未获 commit 授权）。