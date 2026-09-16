# Octopus Workflow

<p align="center">
  <img src="docs/brand/mascot.jpg" alt="Octopus mascot" width="280" />
</p>
<p align="center">
  <img src="docs/brand/lockup.jpg" alt="Octopus" width="560" />
</p>

Octopus 是一个 TypeScript 实现的 AI 辅助软件交付工作流引擎：把研发流程（需求分析 → 设计 → 开发 → 测试 → 部署 → 维护）建模为可版本化的 DAG，按 **项目 → 需求（工作流实例）** 组织，并在本地 SQLite 中持久化节点状态、运行记录和审计事件。

## 核心能力

- **DAG 工作流**：`workflow.yaml` 定义节点、依赖、角色和动作；按依赖调度可运行节点，支持并行、暂停、取消和重试。
- **六类动作**：`manual`、`command`、`ai`、`integration`、`heinrich`、`custom`。
- **AI 辅助**：内置 14 个 AI 模块，通过 Claude CLI 执行；BRD 优化使用 Hermes Agent 无头模式；代码评审并行调用 `ocr`、`commandcode`、`codex` 交叉审查。
- **Teambition 集成**：项目绑定 Teambition 项目，需求绑定任务卡片并读写状态。
- **项目定制**：通过插件与 `workflow.overlay.yaml` 增删改节点，无需修改引擎。
- **三种入口**：CLI、本地 Web 界面、macOS Electron 客户端。

## 快速开始

依赖：Node.js 20+、pnpm 9.15.0。运行 AI 节点需安装并登录 Claude CLI；`brd optimize` 需 Hermes Agent CLI；默认代码评审需 `ocr`、`commandcode`、`codex` CLI。

```bash
pnpm install --frozen-lockfile
pnpm -r build                  # 编译各包，运行 CLI 前必需
```

仓库不安装全局命令，下文 `octopus` 即 `node packages/cli/dist/index.js`：

```bash
octopus project create "Acme"
octopus init "Feature X" --project <projectId> --root .
octopus status
octopus node list
```

只有一个需求时，多数命令可省略 `requirementId`。

## 命令概览

| 命令 | 用途 |
| --- | --- |
| `project` | 项目增删改查、绑定 Teambition、OmniPlan 导入导出 |
| `requirement` / `init` | 创建和管理需求，绑定 Teambition 任务并同步状态 |
| `milestone` | 需求级单日里程碑 |
| `status` / `mine` | 需求与阶段摘要 / 我的工作 |
| `workflow` | 校验、同步、运行 DAG 并查看状态 |
| `node` | 节点创建、查看、运行、完成、取消、重试、指派、日志 |
| `phase` / `stage` / `step` / `task` / `checklist` / `heinrich` | 阶段、步骤、任务、清单与风险记录 |
| `ai` | 独立调用 AI 助手（ask / review / estimate / check-sql / debt） |
| `brd` | 按项目配置生成、优化、检查 BRD，并查看快照、历史和追踪 |
| `monitor` | 运行事件与集成健康度 |
| `storage` | 查看本地同步状态 / 显式同步到 CloudBase |

各命令的完整参数用 `octopus <command> --help` 查看。

## 图形界面

```bash
pnpm web                                  # 本地 Web：http://127.0.0.1:4173（OCTOPUS_WEB_PORT 可改端口）
pnpm --filter @octopus/desktop start      # macOS Electron 客户端
```

两条命令都会自动构建。界面层级为：项目管理中心（含“我的工作”）→ 项目（看板 / 列表 / 表格 / 甘特 / 版本 / 日志 / 概览 / 设置）→ 需求工作区。需求工作区的泳道图完整展示定义图（含未激活节点）、多角色与依赖关系，并在详情区提供节点日志、产物和生命周期操作。

## 数据与存储

- **本地为主**：所有读写走本地 SQLite。CLI/Web 使用 `.octo/octopus.sqlite`，Electron 使用 `userData/store/octopus.sqlite`；`OCTOPUS_STORE_DIR` 可覆盖目录。无需网络即可离线使用。
- **显式同步**：`octopus storage sync` 通过 CloudBase PostgREST RPC，在一个事务内替换远端的项目与需求快照。运行记录、事件和健康状态只保留在本地；同步失败不影响本地数据。`octopus storage status` 查看同步状态，不访问网络。
- **远端初始化**：首次同步前需执行 `drizzle/` 迁移（`pnpm db:migrate`，或在 CloudBase 控制台 SQL 编辑器中执行）。

相关文件：

| 路径 | 说明 |
| --- | --- |
| `workflow.yaml` | 可版本化的 DAG 定义；缺失时回退到 `packages/core/src/spec.ts` |
| `workflow.overlay.yaml` | 可选的节点叠加（增 / 禁 / 改） |
| `workflow/nodes/<nodeKey>/` | 节点工作目录（`README.md`、`src/`、`test/`）；`workflow/shared/` 为共享目录 |
| `.octo/config.json` | 可选本地配置（插件、Teambition 凭据、OmniPlan 根目录等） |

自定义节点的 `key` 必须是英文 kebab-case，`name` / `description` 必须使用英文。

## 项目定制

插件按顺序合并：`workflow.yaml` 的 `plugins` → `.octo/config.json` 的 `plugins` → 项目根目录的 `workflow.overlay.yaml`。未配置时行为与默认一致。

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

插件导出 `default` 或 `octopusPlugin`，在 `activate(ctx)` 中叠加节点，或注册 AI 模块、集成服务和自定义能力；不能覆盖已注册的 AI 模块和内置能力处理器。插件加载失败时进程退出。最小示例见 `packages/plugin/fixtures/sample-plugin/`。

## 环境变量

| 用途 | 变量 |
| --- | --- |
| 存储 | `OCTOPUS_STORE_DIR` |
| AI | `OCTOPUS_AI_MODEL`、`OCTOPUS_AI_TIMEOUT`、`OCTOPUS_AI_CLAUDE_PATH`、`OCTOPUS_AI_HERMES_PATH`、`OCTOPUS_AI_OCR_PATH`、`OCTOPUS_AI_COMMANDCODE_PATH`、`OCTOPUS_AI_CODEX_PATH` |
| Teambition | `OCTOPUS_TB_APP_ID`、`OCTOPUS_TB_APP_SECRET`、`OCTOPUS_TB_ORG_ID`、`OCTOPUS_TB_OPERATOR_ID`；可选 `OCTOPUS_TB_GATEWAY`、`OCTOPUS_TB_REF_STRATEGY` |
| CloudBase 同步 | `CLOUDBASE_ENV_ID`、`CLOUDBASE_APIKEY`（`service_role`，仅限后端进程，禁止提交或传给渲染器） |
| 数据库迁移 | 依次读取 `CLOUDBASE_MIGRATION_URL`、`CLOUDBASE_DATABASE_URL`、`DATABASE_MIGRATION_URL`、`DATABASE_URL` |
| 其他 | `OCTOPUS_WEB_PORT`、`OCTOPUS_OMNIPLAN_ROOT`、`OCTOPUS_ME` |

开发时读取仓库根目录的 `.env`；打包后的 Electron 读取进程环境或 `userData/store/.env`。

## 开发

```bash
pnpm build     # TypeScript 类型检查（不生成 dist）
pnpm test      # Vitest
pnpm lint      # Biome
pnpm verify    # build + test + lint
```

SonarQube、Postman、监控等外部集成只定义了接口，CLI 默认未注入实现。仓库结构、包边界和代码约定见 [`Agents.md`](Agents.md)。

## 延伸阅读

- BRD 节点与 Hermes 运行记录：[`workflow/nodes/requirements-analysis-and-brd-design/README.md`](workflow/nodes/requirements-analysis-and-brd-design/README.md)
- Teambition 版本计划：[`docs/plans/teambition-version-plan.md`](docs/plans/teambition-version-plan.md)
- 工作台设计：[`docs/plans/workbench-table-mywork-overview.md`](docs/plans/workbench-table-mywork-overview.md)
- 看板 / 甘特 / OmniPlan：[`docs/archive/teambition-kanban-gantt-omniplan.md`](docs/archive/teambition-kanban-gantt-omniplan.md)
- 需求里程碑：[`docs/archive/requirement-milestones.md`](docs/archive/requirement-milestones.md)
