# @octopus/desktop

Octopus 工作流引擎的 **macOS 桌面外壳**（Electron）。

复用与 CLI 相同的引擎入口（`@octopus/context` 的 `loadConfig` +
`createWorkflowEngineFromConfig`），通过 IPC 向渲染进程暴露项目和任务文件能力。
项目状态持久化到 Electron 的 `userData/store` 目录。

## 开发

```bash
pnpm --filter @octopus/desktop start      # 编译并启动窗口
```

## 浏览器界面

Electron 无法启动或只需要本地浏览器展示时，在仓库根目录运行：

```bash
pnpm web
```

然后访问 `http://127.0.0.1:4173`。服务只监听 `127.0.0.1`，默认读取仓库根目录的 `.octo/state.sqlite`；使用 `OCTOPUS_WEB_PORT` 修改端口，使用 `OCTOPUS_STORE_DIR` 修改状态目录。页面复用 Electron renderer，但通过同源 HTTP API 访问真实工作流引擎。

## 打包为 macOS 应用

```bash
pnpm --filter @octopus/desktop dist:mac   # 输出 .dmg 到 packages/desktop/release/
```

> 未配置代码签名/公证（notarize）。分发给其他 Mac 需在 `build.mac` 中补充
> `identity` 与 notarize 配置，否则用户需右键“打开”绕过 Gatekeeper。

## 结构

- `src/main.ts` — 主进程：初始化引擎、注册 IPC、创建窗口。
- `src/preload.cjs` — contextBridge 暴露 `window.octopus`。
- `src/renderer/` — 界面（原生 HTML/JS，无构建步骤）。

## 当前已接能力

- 列出项目（`listProjects`）
- 创建项目（`init`）
- 查看项目状态：阶段进度、任务/清单统计、海因里希三角（`status`）
- 通过系统文件对话框导出版本化任务 JSON（`exportTasks`）
- 确认后按 `stageId` 合并导入任务进度（`importTasks`）

其余 CLI 能力（阶段前进/回退、任务编辑、清单、AI）尚未接入，可按相同的
IPC 模式在 `main.ts` 中逐步扩展。
