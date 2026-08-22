# @octopus/desktop

Octopus 工作流引擎的 **macOS 桌面外壳**（Electron）与本机 Web 界面。

复用与 CLI 相同的引擎入口（`@octopus/context` 的 `loadConfig` +
`createWorkflowEngineFromConfig`），通过 IPC / HTTP API 向渲染进程暴露项目和任务能力。
项目状态持久化到 Electron 的 `userData/store` 目录（Web 默认读仓库根 `.octo`）。

## 界面技术栈

- React + Vite（`src/renderer/`）
- Tailwind CSS v4 + 官方 shadcn/ui
- 自研 SVG 角色泳道图与甘特图（`visualizations/`）

## 开发

```bash
pnpm --filter @octopus/desktop start      # 编译、为 Electron 重建原生模块并启动窗口
```

`better-sqlite3` 是原生模块，必须按 **Electron 的 Node ABI** 编译（与系统 Node 的 ABI 不同）。
`start` / `dist:mac` 会自动跑 `rebuild:native`。

## 浏览器界面

```bash
pnpm web
```

然后访问 `http://127.0.0.1:4173`。默认进入项目管理中心。服务只监听 `127.0.0.1`；
使用 `OCTOPUS_WEB_PORT` 修改端口，使用 `OCTOPUS_STORE_DIR` 修改状态目录。

Hash 路由：

- `#hub` 项目管理中心
- `#hub/mine` 我的工作
- `#project/:id/:tab` 项目工作台（board / table / gantt / versions / logs / overview / settings）
- `#requirement/:id` 需求工作区（角色泳道图）

## 打包为 macOS 应用

```bash
pnpm --filter @octopus/desktop dist:mac   # 输出 .dmg 到 packages/desktop/release/
```

## 结构

- `src/main.ts` — 主进程：初始化引擎、注册 IPC、创建窗口。
- `src/preload.cjs` — contextBridge 暴露 `window.octopus`。
- `src/web.ts` — 本机 HTTP 服务 + 同源 API，静态资源来自 `dist/renderer`。
- `src/renderer/` — React SPA（Vite 构建到 `dist/renderer`，`base: "./"` 以支持 Electron `loadFile`）。
