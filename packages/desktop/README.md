# @octopus/desktop

Octopus 工作流引擎的 **macOS 桌面外壳**（Electron）。

复用与 CLI 相同的引擎入口（`@octopus/context` 的 `loadConfig` +
`createWorkflowEngineFromConfig`），通过 IPC 向渲染进程暴露项目和任务文件能力。
项目状态持久化到 Electron 的 `userData/store` 目录。

## 开发

```bash
pnpm --filter @octopus/desktop start      # 编译、为 Electron 重建原生模块并启动窗口
```

`better-sqlite3` 是原生模块，必须按 **Electron 的 Node ABI** 编译（与系统 Node 的 ABI 不同）。
`start` / `dist:mac` 会自动跑 `rebuild:native`。若只跑了 `pnpm install` 或用系统 Node
测过 CLI/单测，再开桌面端时若出现 `NODE_MODULE_VERSION` 报错，重新 `start` 即可；
之后若 CLI/测试又报同样错误，在仓库根目录执行 `pnpm rebuild better-sqlite3`。

## 浏览器界面

Electron 无法启动或只需要本地浏览器展示时，在仓库根目录运行：

```bash
pnpm web
```

然后访问 `http://127.0.0.1:4173`。默认进入项目管理中心，可创建、打开、编辑、删除项目，或在卡片上点「排期」展开该项目的节点甘特图（左侧树表 + 右侧时间条，支持日/周/月、只读、拖拽排期）。打开项目后进入角色泳道图（上方角色、左侧阶段）。服务只监听 `127.0.0.1`，默认读取仓库根目录的 `.octo/state.sqlite`；使用 `OCTOPUS_WEB_PORT` 修改端口，使用 `OCTOPUS_STORE_DIR` 修改状态目录。页面复用 Electron renderer，但通过同源 HTTP API 访问真实工作流引擎。删除项目只清状态库记录，不会删除 `workflow.yaml`。

## 打包为 macOS 应用

```bash
pnpm --filter @octopus/desktop dist:mac   # 输出 .dmg 到 packages/desktop/release/
```

> 未配置代码签名/公证（notarize）。分发给其他 Mac 需在 `build.mac` 中补充
> `identity` 与 notarize 配置，否则用户需右键“打开”绕过 Gatekeeper。

## 结构

- `src/main.ts` — 主进程：初始化引擎、注册 IPC、创建窗口。
- `src/preload.cjs` — contextBridge 暴露 `window.octopus`。
- `src/renderer/` — 界面（原生 HTML/JS，无构建步骤）；`app-icon.png` 为窗口 / favicon / 打包图标。

## 当前已接能力

- 项目管理中心：列出 / 创建 / 打开 / 改名 / 删除项目；卡片可展开节点甘特图排期
- 工作台：角色泳道图（节点依赖与执行状态；拖拽平移、Ctrl/⌘+滚轮缩放，卡片中英双语，详情可跳转脚本目录；可收起左右侧栏）
- 查看项目状态：阶段进度、任务/清单统计、海因里希三角（`status`）
- 通过系统文件对话框导出版本化任务 JSON（`exportTasks`）
- 确认后按 `stageId` 合并导入任务进度（`importTasks`）

其余 CLI 能力（阶段前进/回退、任务编辑、清单、AI）尚未接入，可按相同的
IPC 模式在 `main.ts` 中逐步扩展。
