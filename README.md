# Octopus Workflow

Octopus 是一个 TypeScript 实现的 AI 辅助软件交付工作流引擎。它把研发过程建模为可版本化的 DAG，并持久化节点状态、运行记录和审计事件。

```text
需求分析 → 设计 → 开发 → 测试 → 部署 → 维护
```

核心能力：

- 以 `workflow.yaml` 定义节点、依赖、角色和执行动作。
- 支持手动、命令、AI、外部集成和 Heinrich 标记五类动作。
- 按依赖调度可运行节点，支持并行执行、手动暂停、取消和重试。
- 内置 12 类 AI 辅助能力，通过 Claude CLI 执行。
- 提供 CLI、本地 Web 界面和 macOS Electron 客户端。

## 快速开始

需要 Node.js 20+ 和 pnpm 9.15.0；运行 AI 节点还需要安装并登录 Claude CLI。

```bash
pnpm install --frozen-lockfile
pnpm -r build

node packages/cli/dist/index.js init "My Project" --root .
node packages/cli/dist/index.js status
node packages/cli/dist/index.js node list
```

`init` 会创建项目状态并初始化工作流目录；一个状态库只允许初始化一个项目，已有项目时请直接执行 `status`。默认状态目录是 `.octo/`，可用 `OCTOPUS_STORE_DIR` 覆盖。

下文用 `octopus` 代表 `node packages/cli/dist/index.js`；仓库不会自动安装全局命令。多数命令在只有一个项目时可省略 `projectId`。

## 核心命令

| 命令 | 用途 |
| --- | --- |
| `octopus status` | 查看项目与阶段摘要 |
| `octopus phase/task/checklist/heinrich` | 管理阶段、任务、清单与风险记录 |
| `octopus node create/list/show/run/complete` | 定义、查看和执行工作流节点 |
| `octopus node cancel/retry/logs` | 管理节点运行及日志 |
| `octopus workflow validate/sync/run/status` | 校验工作流、同步目录并调度 DAG |
| `octopus stage` / `octopus step` | 管理阶段步骤并执行步骤能力 |
| `octopus ai` | 独立调用 AI 助手 |
| `octopus monitor` | 查看运行事件与集成健康度 |

使用 `octopus --help` 或 `octopus <command> --help` 查看完整参数。

## 工作流与数据

- `packages/core/src/spec.ts`：内置六阶段工作流规格，也是缺少项目定义时的回退来源。
- `workflow.yaml`：项目级、可版本化的 DAG 定义；初始化不会覆盖已有文件。
- `workflow/nodes/<nodeKey>/`：节点独立工作目录；`workflow/shared/`：节点共享目录。
- `.octo/state.sqlite`：CLI 和 Web 默认使用的项目状态、运行记录与事件数据库。
- `.octo/config.json`：可选的本地配置。
- `workflow.overlay.yaml`：可选的项目级节点叠加（增/禁/改），不必复制整份 DAG。

自定义节点的 `key` 必须是英文 kebab-case，`name` 和 `description` 也必须使用英文；内部运行态 ID 由 `workflow.yaml` 的 `nodeIdMapping` 维护。

## 项目定制

未配置插件且没有 `workflow.overlay.yaml` 时，行为与原来完全一致。不同项目用外挂叠加节点并注册 AI / 集成 / 自定义能力，不必改引擎主流程。

插件引用按顺序合并：`workflow.yaml` 的 `plugins` → `.octo/config.json` 的 `plugins`；最后再应用项目根目录的 `workflow.overlay.yaml`。

```yaml
# workflow.yaml 片段
plugins:
  - ./octopus-plugins/acme-checks.js
```

```yaml
# workflow.overlay.yaml
disable:
  - weekly-feature-demo
add:
  - key: extra-qa-gate
    phase: Testing
    name: Extra QA Gate
    description: Project-specific QA gate
    responsibleRoles: [QA]
    dependsOn: [smoke-demo-validation]
    actions:
      - type: custom
        name: acme.qaGate
```

插件导出 `default` 或 `octopusPlugin`，在 `activate(ctx)` 里叠加节点、注册新的 AI 模块 id、集成服务或自定义能力名称。不能覆盖内置 12 类 AI 模块，也不能覆盖 `ai` / `heinrich` 能力处理器。路径相对项目根，包名从该项目的 `node_modules` 解析。加载失败则进程退出。

测试夹具 `packages/plugin/fixtures/sample-plugin/` 是一份可复制的最小插件。本仓库默认不启用任何插件。

可用环境变量：`OCTOPUS_STORE_DIR`、`OCTOPUS_AI_MODEL`、`OCTOPUS_AI_TIMEOUT`、`OCTOPUS_AI_CLAUDE_PATH`。

## 图形界面

启动本地 Web 界面：

```bash
pnpm web
```

访问 `http://127.0.0.1:4173`。服务只监听本机回环地址，默认与 CLI 共享仓库根目录的 `.octo/state.sqlite`；可用 `OCTOPUS_WEB_PORT` 修改端口。

启动 macOS Electron 客户端：

```bash
pnpm --filter @octopus/desktop start
```

Electron 默认使用系统 `userData/store/state.sqlite`，不会自动与 CLI/Web 共享状态；如需共享，请为它们设置相同的 `OCTOPUS_STORE_DIR`。

## 开发验证

```bash
pnpm build       # TypeScript 类型检查，不生成 dist
pnpm test        # Vitest 测试
pnpm lint        # Biome 静态检查
pnpm verify      # 依次执行 build、test、lint
pnpm -r build    # 编译各包并生成 dist
```

运行 CLI 或图形界面前需先执行 `pnpm -r build`。SonarQube、Postman、监控等外部集成只有接口定义，默认 CLI 未注入服务实现。
