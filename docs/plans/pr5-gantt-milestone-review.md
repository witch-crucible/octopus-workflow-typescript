# PR5 甘特里程碑审查报告

## 修复轮 1

**修改文件：**
- `packages/desktop/src/renderer/gantt.js` — 添加 `requirementId` 到模型与里程碑行；在里程碑行状态列新增「达成」按钮（未达成且非只读时显示），绑定 click + `event.stopPropagation()` 防止触发行选中。
- `packages/desktop/src/renderer/renderer.js` — `onSelectMilestone` 改为先 `openWorkspace(expandedScheduleId)` 再 `openMilestoneForm(m)`，确保表单在可见工作区打开；`onReach` 使用回调传入的 `requirementId` 而非 `expandedScheduleId`；`renderHubGantt` 传递 `requirementId` 给甘特渲染。
- `packages/desktop/src/renderer/index.html` — 新增 `.gantt-reach-btn` 样式（小文本按钮，primary 色边框，hover 高亮）。
- `packages/desktop/src/web.test.ts` — 新增 5 条断言覆盖达成按钮、requirementId 传递、onSelectMilestone 工作区切换、renderHubGantt requirementId、index.html 达成按钮样式。

**验证结果：**
- `pnpm test`：405 passed, 1 failed（失败为预存路由测试 `legacyProject` 哈希兼容，与本次改动无关）
- `git diff --check`：通过（无空白错误）
- `git status --short`：4 文件变更（gantt.js / renderer.js / index.html / web.test.ts）
