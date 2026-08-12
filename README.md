# Octopus Workflow TypeScript

Octopus 是一个 TypeScript 实现的 AI 辅助研发工作流引擎，将软件交付建模为可持久化、可检查和可执行的六个阶段：

```text
需求分析 → 设计 → 开发 → 测试 → 部署 → 维护
```

工作流规格位于 `packages/core/src/spec.ts`，项目级定义保存在 `workflow.yaml`。项目提供 CLI 和 macOS Electron 桌面端。

## 快速开始

需要 Node.js 20+、pnpm 9.15.0。执行 AI 节点还需要安装并登录 Claude CLI。

```bash
pnpm install --frozen-lockfile
pnpm -r build
```

如果当前状态库已经包含项目，禁止再次执行 `init`，直接使用现有项目：

```bash
node packages/cli/dist/index.js status
node packages/cli/dist/index.js node list
```

只有当前状态库还没有项目时，才允许初始化；空的 `state.sqlite` 不会阻止初始化：

```bash
node packages/cli/dist/index.js init "My Project" --root .
node packages/cli/dist/index.js status
```

`init` 会检查状态库中是否已有项目；已有项目时命令会直接失败且不会创建新项目。初始化成功时会在本地状态库中创建项目，并以 `--root` 指定的目录作为项目源码根目录。`OCTOPUS_STORE_DIR` 可覆盖默认的 `.octo` 状态目录。

`pnpm -r build` 会重新生成各包的 `dist/`；拉取新代码或依赖变化后，不要直接复用旧的编译产物。

下文使用 `octopus` 代指 `node packages/cli/dist/index.js`，它不是已安装的 shell 命令；实际执行时请使用完整的 Node.js 命令，除非已经自行配置别名或链接。仅有一个项目时，多数命令可以省略 `projectId`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `octopus init <name> --root <path>` | 自动检查状态库，仅在尚无项目时初始化 |
| `octopus status` | 查看项目和阶段进度 |
| `octopus phase list/advance/rollback` | 管理阶段 |
| `octopus task list/complete/set-status` | 管理任务 |
| `octopus checklist show/add/check/remove` | 管理检查清单 |
| `octopus node create/list/show/run/complete` | 创建和执行节点 |
| `octopus workflow validate/sync/run/status` | 校验、同步和调度 DAG |
| `octopus task export/import` | 导出或合并任务进度 |
| `octopus monitor status/check/watch` | 查看运行记录和集成状态 |

使用 `octopus --help` 或 `octopus <command> --help` 查看完整参数。

## 创建 AI 文档节点

节点使用英文 kebab-case `key`；名称和描述也必须使用英文。`nodes` 不保存内部 ID，稳定映射统一维护在 `workflow.yaml` 的 `nodeIdMapping`。

```bash
octopus node create generate-documentation "Generate Documentation" \
  --role AI \
  --depends-on requirements-analysis-and-brd-design \
  --type ai \
  --assistant DOCUMENT_SYNC \
  --input "Generate complete technical documentation from the project source code. Preserve valid existing content and extend changed sections." \
  --output documentation.md \
  --if-exists extend
```

节点工作目录为 `workflow/nodes/<nodeKey>/`，公共文件目录为 `workflow/shared/`。未来阶段的节点会在流程推进到对应阶段时加入运行态。

## 数据与配置

- `workflow.yaml`：可版本化的节点、依赖、动作和 ID mapping。
- `workflow/nodes/`：节点独立工作目录。
- `.octo/state.sqlite`：项目状态、执行记录和事件。
- `.octo/config.json`：可选本地配置。

环境变量 `OCTOPUS_STORE_DIR`、`OCTOPUS_AI_MODEL`、`OCTOPUS_AI_TIMEOUT` 和 `OCTOPUS_AI_CLAUDE_PATH` 会覆盖文件配置。

浏览器界面启动命令：

```bash
pnpm web
```

启动后访问 `http://127.0.0.1:4173`。浏览器版只监听本机回环地址，默认读取仓库根目录的 `.octo/state.sqlite`，并复用桌面端的项目状态、DAG、运行历史和任务导入导出界面。可通过 `OCTOPUS_WEB_PORT` 修改端口，通过 `OCTOPUS_STORE_DIR` 修改状态目录。完整的工作区命令为 `pnpm --filter @octopus/desktop web`。

桌面端启动命令：

```bash
pnpm --filter @octopus/desktop start
```

## 开发验证

```bash
pnpm build       # TypeScript 类型检查，不生成 dist
pnpm test        # Vitest 测试
pnpm lint        # Biome linter（不批量格式化或重排导入）
pnpm verify      # 依次执行 build、test、lint
pnpm -r build    # 编译各包并生成可运行的 dist
```

运行 CLI 或桌面端前应先执行 `pnpm -r build`。根目录的 `pnpm build` 使用 `tsc --noEmit`，只验证类型，不能代替可运行产物的构建。

SonarQube、Postman 和监控等动作需要注入对应集成服务；默认 CLI 不提供这些外部服务实现。
