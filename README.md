# Octopus Workflow

<p align="center">
  <img src="docs/brand/mascot.jpg" alt="Octopus mascot" width="280" />
</p>
<p align="center">
  <img src="docs/brand/lockup.jpg" alt="Octopus" width="560" />
</p>

Octopus 是一个 TypeScript 实现的 AI 辅助软件交付工作流引擎，把研发过程建模为可版本化的 DAG，并持久化节点状态、运行记录和审计事件。

领域分层：

```text
项目（Project）
  └── 需求（Requirement）← 工作流实例 / phase / steps
```

```text
需求分析 → 设计 → 开发 → 测试 → 部署 → 维护
```

核心能力：

- 以 `workflow.yaml` 定义节点、依赖、角色和执行动作。
- 支持手动、命令、AI、外部集成和 Heinrich 标记五类动作。
- 按依赖调度可运行节点，支持并行执行、手动暂停、取消和重试。
- 内置 AI 辅助能力（含 BRD 生成/检查）通过 Claude CLI 执行；BRD 源路径与提示词可按项目配置。
- 项目可绑定 Teambition 项目，需求可绑定任务卡片并读写状态。版本计划对接（仓库 / 版本 / note）方案见 `docs/plans/teambition-version-plan.md`。
- 提供 CLI、本地 Web 界面和 macOS Electron 客户端。

## 快速开始

需要 Node.js 20+ 和 pnpm 9.15.0；运行 AI 节点还需要安装并登录 Claude CLI。

```bash
pnpm install --frozen-lockfile
pnpm -r build

node packages/cli/dist/index.js project create "Acme"
node packages/cli/dist/index.js init "Feature X" --project <projectId> --root .
node packages/cli/dist/index.js status
node packages/cli/dist/index.js node list
```

先创建**项目**，再在项目下 `init` / `requirement init` 创建**需求**（工作流实例）并初始化工作流目录。同一状态库可有多个项目，每个项目下可有多个需求。默认状态目录是 `.octo/`，可用 `OCTOPUS_STORE_DIR` 覆盖。下文用 `octopus` 代表 `node packages/cli/dist/index.js`（仓库不会自动安装全局命令）；多数命令在只有一个需求时可省略 `requirementId`。

声明：本项目使用 Hermes 作为 JavaScript 运行时。

## 核心命令

| 命令 | 用途 |
| --- | --- |
| `octopus project create/list/update/delete` | 管理项目容器 |
| `octopus project bind-tb` / `tb-statuses` | 绑定 Teambition 项目、列出卡片状态 |
| `octopus requirement init/list/delete` | 管理需求（工作流实例） |
| `octopus requirement bind-task` / `tb-status` / `tb-update` | 绑定任务、拉取/更新 Teambition 状态 |
| `octopus milestone list/add/update/reach/delete` | 管理需求级单日里程碑 |
| `octopus init` | `requirement init` 的别名（需 `--project`） |
| `octopus status` | 查看需求与阶段摘要 |
| `octopus phase/task/checklist/heinrich` | 管理阶段、任务、清单与风险记录 |
| `octopus node create/list/show/run/complete` | 定义、查看和执行工作流节点 |
| `octopus node cancel/retry/logs` | 管理节点运行及日志 |
| `octopus workflow validate/sync/run/status` | 校验工作流、同步目录并调度 DAG |
| `octopus stage` / `octopus step` | 管理阶段步骤并执行步骤能力 |
| `octopus ai` | 独立调用 AI 助手 |
| `octopus brd config/prompts/generate/check` | 按项目配置源与提示词，生成或检查 BRD |
| `octopus monitor` | 查看运行事件与集成健康度 |

## 工作流与数据

- `packages/core/src/spec.ts`：内置工作流规格，也是缺少定义时的回退来源。
- `workflow.yaml`：需求级、可版本化的 DAG 定义；初始化不会覆盖已有文件。
- `workflow/nodes/<nodeKey>/`：节点独立工作目录；`workflow/shared/`：节点共享目录。
- `.octo/state.sqlite`：项目、需求状态、运行记录与事件数据库（旧库会自动迁移为「项目 ⊃ 需求」）。
- `.octo/config.json`：可选的本地配置（含 Teambition 凭据）。
- `workflow.overlay.yaml`：可选的节点叠加（增/禁/改），不必复制整份 DAG。
- 自定义节点 `key` 必须是英文 kebab-case，`name` / `description` 也必须使用英文；内部运行态 ID 由 `workflow.yaml` 的 `nodeIdMapping` 维护。

## 项目定制

不同项目用外挂叠加节点并注册 AI / 集成 / 自定义能力，不必改引擎主流程；未配置插件且没有 `workflow.overlay.yaml` 时，行为与原来完全一致。插件引用按顺序合并：`workflow.yaml` 的 `plugins` → `.octo/config.json` 的 `plugins`，最后再应用项目根目录的 `workflow.overlay.yaml`。

```yaml
plugins:
  - ./octopus-plugins/acme-checks.js
```

```yaml
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

插件导出 `default` 或 `octopusPlugin`，在 `activate(ctx)` 里叠加节点、注册新的 AI 模块 id、集成服务或自定义能力名称；不能覆盖内置 12 类 AI 模块，也不能覆盖 `ai` / `heinrich` 能力处理器。路径相对项目根，包名从该项目的 `node_modules` 解析，加载失败则进程退出。测试夹具 `packages/plugin/fixtures/sample-plugin/` 是一份可复制的最小插件，本仓库默认不启用任何插件。

可用环境变量：`OCTOPUS_STORE_DIR`、`OCTOPUS_AI_MODEL`、`OCTOPUS_AI_TIMEOUT`、`OCTOPUS_AI_CLAUDE_PATH`。

Teambition（写入 `.octo/config.json` 的 `teambition` 或环境变量）：

- `OCTOPUS_TB_APP_ID` / `OCTOPUS_TB_APP_SECRET` / `OCTOPUS_TB_ORG_ID`
- `OCTOPUS_TB_OPERATOR_ID`（更新任务状态时的默认操作人）
- 可选：`OCTOPUS_TB_GATEWAY`、`OCTOPUS_TB_REF_STRATEGY`

## 图形界面

启动本地 Web 界面：

```bash
pnpm web
```

访问 `http://127.0.0.1:4173`。服务只监听本机回环地址，默认与 CLI 共享仓库根目录的 `.octo/state.sqlite`；可用 `OCTOPUS_WEB_PORT` 修改端口。界面层级：项目管理中心（含“我的工作”）→ 项目（看板 / 列表 / 表格 / 甘特 / 版本 / 概览 / 设置，可绑定 Teambition）→ 需求工作区（泳道图、任务和版本绑定）。需求可挂单日里程碑（工作区顶栏、卡片徽章、甘特菱形）。项目甘特支持导入导出 OmniPlan `.oplx`，默认目录 `/Users/ben/Documents/OmniPlan/Projects/<项目文件夹>/`。设计见 `docs/archive/teambition-kanban-gantt-omniplan.md`、`docs/archive/requirement-milestones.md`。Teambition 版本列表端点仍需契约探针确认，未确认时 UI 会显示失败原因，详见 `docs/plans/teambition-version-plan.md`。工作台收口设计见 `docs/plans/workbench-table-mywork-overview.md`。

### 需求泳道图（Node Swimlane）

- 以 `workflow.yaml` + `workflow.overlay.yaml` + 插件叠加定义为准，完整展示需求定义图：已激活、可操作和未来未激活节点会同时渲染，便于按阶段查看全局路径。
- 未来节点会标注为“未激活”，默认不可运行/完成，仅在满足前置依赖条件后自动可用。
- 单节点可显示多个参与角色，图上会把参与角色集中展示，便于责任边界与交接确认。
- 依赖连线会按列向量进行布局，减少跨列箭头穿透和混淆，保持同阶段节点顺序更易读。
- 支持在详情区展开查看每个节点的历史日志、产物与当前状态，支持执行、完成、取消、重试等常规生命周期操作。

如果你是第一次接触泳道图，建议先用 `octopus status` 或 Web “项目 → 需求 → 需求工作区”确认当前激活节点，再对比泳道图中的依赖关系与角色信息。

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

## 开发者指南

参与开发前请阅读 [`Agents.md`](Agents.md)，其中包含仓库结构、包边界、代码约定、工作流配置规则以及提交前验证流程。
