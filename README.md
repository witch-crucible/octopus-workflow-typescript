# Octopus Workflow TypeScript

Octopus 是一个 TypeScript 实现的 AI 辅助研发工作流引擎，将软件交付建模为可持久化、可检查和可执行的六个阶段：

```text
需求分析 → 设计 → 开发 → 测试 → 部署 → 维护
```

工作流规格位于 `packages/core/src/spec.ts`，项目级定义保存在 `workflow.yaml`。项目提供 CLI 和 macOS Electron 桌面端。

## 快速开始

需要 Node.js 20+、pnpm 9.15.0。执行 AI 节点还需要安装并登录 Claude CLI。

```bash
pnpm install
pnpm -r build

node packages/cli/dist/index.js init "My Project" --root .
node packages/cli/dist/index.js status
node packages/cli/dist/index.js node list
```

下文使用 `octopus` 代指 `node packages/cli/dist/index.js`。仅有一个项目时，多数命令可以省略 `projectId`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `octopus init <name> --root <path>` | 初始化项目和工作流目录 |
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

桌面端启动命令：

```bash
pnpm --filter @octopus/desktop start
```

## 开发验证

```bash
pnpm build       # TypeScript 类型检查
pnpm test        # Vitest 测试
pnpm lint        # Biome 静态检查
pnpm verify      # 依次执行 build、test、lint
pnpm -r build    # 生成各包 dist
```

SonarQube、Postman 和监控等动作需要注入对应集成服务；默认 CLI 不提供这些外部服务实现。
