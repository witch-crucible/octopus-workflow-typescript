# Octopus Workflow TypeScript

Octopus 是一个以 TypeScript 实现的 AI 辅助软件项目流程引擎。项目将 `project-process-AI.puml` 中 PM、BA、SA、AI、DEV、QA、OP 与 Heinrich 审计角色参与的完整研发流程，转化为可持久化、可检查、可通过 CLI 操作的阶段、步骤（Stage）、任务、Checklist 和风险记录。

> 当前版本为本地 CLI 与领域模型实现。SonarQube、Postman、监控等外部系统目前只提供集成接口；CLI 下的 AI 子命令仍以接入提示为主，AI 专业能力已在 `@octopus/agent-layer` 中实现，但尚未全部连通到 CLI。

## 流程来源

本项目依据以下 PlantUML 时序图建模：

```text
/Users/ben/Documents/UML/PlantUML/Software Engineering/project-process-AI.puml
```

流程覆盖六个连续阶段：

```text
需求分析 → 设计 → 开发 → 测试 → 部署 → 维护
```

| 阶段 | PlantUML 中的主要活动 | 主要产出或门控 |
| --- | --- | --- |
| 需求分析 | BRD/PRD、需求调研、功能拆分、估时、AI 需求分析 | PRD、功能点、估时确认 |
| 设计 | Kick Off、需求复述、影响范围评估、前后端技术方案 | 技术方案、影响范围、会议共识 |
| 开发 | 方案审核、数据与接口设计、开发、联调、自测、质量检查 | 可测试功能、自测表、更新后的文档与用例 |
| 测试 | 冒烟、功能/性能测试、UAT、发布准备 | UAT 结果、发布计划、预发布分支 |
| 部署 | Setup、Checklist、Code Review、SQL/配置检查、发布与回归 | 发布结果、回归结果、回滚与风险记录 |
| 维护 | AB/逆向验证、持续监控、技术债务量化 | 监控结果、有效性分析、技术债务清单 |

PlantUML 是业务流程蓝图；代码中的权威阶段与 Stage 定义位于 `packages/core/src/phase.ts`。

## 核心能力

- 六阶段顺序流转，并支持回退到任一前置阶段。
- 将流程活动建模为带依赖、负责人和状态的 Stage。
- 根据阶段定义生成任务，并跟踪任务生命周期。
- 阶段前进前校验未完成任务、未核验 Checklist 和 Stage 依赖。
- 阶段转换时继承已验证或标记为不适用的 Checklist 项。
- 记录 Heinrich 重大、轻微、未遂风险，并按 `1:29:300` 进行质量评估。
- 记录流程图关键节点的 Heinrich marker；达到阈值时创建审计任务。
- 提供可选的角色权限与 AI 门控机制。
- 使用本地 JSON 文件持久化项目状态。

## 角色

| 角色 | 职责 |
| --- | --- |
| PM | 需求分析、BRD、排期、发布确认与效果验证 |
| BA | PRD、边界与逆向设计、需求讲解与反馈更新 |
| SA | 技术调研、拆分估时、方案/数据/接口审核、部署与发布把关 |
| AI | 会议总结、需求分析、方案审查、SQL/发布风险检查、文档与 Checklist 建议 |
| DEV | 技术方案、功能开发、联调、自测、演示与发布支持 |
| QA | 测试用例、功能/性能测试、UAT 与回归 |
| OP | 发布计划、环境和配置检查、运维协作 |
| HEI | Heinrich 质量审计与风险记录 |

## 架构

```text
CLI
 └─ Workflow Engine（阶段转换、门控、任务、Stage、Checklist、风险）
     ├─ Core（领域模型和流程定义）
     ├─ Task Library（阶段任务模板）
     ├─ Context（.octo JSON 状态存储）
     ├─ Agent Layer（Claude CLI 适配与专业 AI 助手）
     └─ Integration（Git、SonarQube、Postman、监控等接口）
```

| 包 | 作用 |
| --- | --- |
| `@octopus/core` | Phase、Stage、Task、Role、Checklist、Artifact、Risk、Agent 等领域模型 |
| `@octopus/workflow-engine` | 工作流操作、阶段门控、状态转换与质量审计 |
| `@octopus/task-library` | 从阶段定义生成默认任务 |
| `@octopus/context` | 配置加载和 `.octo/` JSON 状态持久化 |
| `@octopus/agent-layer` | 通过 `claude -p` 调用 AI，并封装专业助手方法 |
| `@octopus/integration` | 外部工具与平台的集成契约 |
| `@octopus/cli` | `octopus` 命令行入口 |

## 环境要求

- Node.js 20 或更高版本
- pnpm 9.15.0
- 可选：已安装并登录的 Claude CLI（仅 AI 调用需要）

## 安装与验证

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

常用开发命令：

```bash
pnpm test:watch   # 监听测试
pnpm lint:fix     # 自动修复可修复的 Biome 问题
pnpm verify       # 执行项目综合验证脚本（若当前分支提供 scripts/verify.sh）
```

构建完成后，可直接运行 CLI：

```bash
node packages/cli/dist/index.js --help
```

下文使用 `octopus` 代表该入口；在未全局链接 CLI 时，可将其替换为 `node packages/cli/dist/index.js`。

## 快速开始

```bash
# 1. 创建项目；输出中会给出 projectId
octopus init "示例项目" --description "演示完整研发流程"

# 2. 查看当前状态、任务和步骤
octopus status
octopus task list
octopus stage list

# 3. 推进工作
octopus task complete <taskId>
octopus stage update 10.1 COMPLETED
octopus checklist add "需求" "PRD 已评审"
octopus checklist show
octopus checklist verify <itemId>

# 4. 检查并推进阶段
octopus phase list
octopus phase advance
```

如果只存在一个本地项目，多数命令可省略 `projectId`；否则建议显式传入，避免操作错误的项目。

项目运行状态默认保存在当前工作目录：

```text
.octo/
├── config.json          # 可选配置
├── index.json           # projectId 到项目名的索引
└── projects/
    └── <projectId>.json # 完整工作流状态
```

## CLI 命令

```text
octopus init <projectName> [--description <desc>] [--json]
octopus status [projectId] [--json]

octopus phase list [projectId]
octopus phase show <phase> [projectId]
octopus phase advance [projectId]
octopus phase rollback <phase> [projectId]

octopus stage list [phase] [projectId]
octopus stage status <stageId> [projectId]
octopus stage update <stageId> <status> [projectId]

octopus task list [phase] [projectId] [--all]
octopus task complete <taskId> [projectId]
octopus task set-status <taskId> <status> [projectId]

octopus checklist show [phase] [projectId]
octopus checklist add <category> <description> [phase] [projectId]
octopus checklist verify <itemId> [projectId]
octopus checklist remove <itemId> [projectId]

octopus heinrich show [projectId] [--observations]
octopus heinrich log <MAJOR|MINOR|TRIVIAL> <description> [phase] [projectId]
octopus heinrich resolve <observationId> [projectId]
octopus heinrich marker [phase] [projectId] [--description <text>]
octopus heinrich assess [projectId]

octopus ai ask <prompt>
octopus ai review [projectId]
octopus ai estimate [projectId]
octopus ai check-sql <sql>
octopus ai debt [projectId]
```

阶段名称使用代码值：`RequirementsAnalysis`、`Design`、`Development`、`Testing`、`Deployment`、`Maintenance`。任务与 Stage 状态可使用 `PENDING`、`IN_PROGRESS`、`COMPLETED`、`BLOCKED`、`SKIPPED`。

所有主要命令均支持 `--json`，便于脚本或其他 Agent 消费输出。

## 阶段门控

调用 `phase advance` 时，引擎按以下顺序检查：

1. 当前阶段不是最终阶段。
2. 当前阶段任务全部为 `COMPLETED` 或 `SKIPPED`。
3. 当前阶段 Checklist 不存在 `PENDING` 项。
4. 当前阶段 Stage 的依赖均已完成。
5. 启用 AI 门控时，已注册的处理器没有否决本次转换。

转换成功后，引擎会激活下一阶段、生成下一阶段任务和 Stage，并继承上一阶段已验证或不适用的 Checklist 项。

## Heinrich 质量模型

项目保留两类互不混淆的质量数据：

- 风险观测：`MAJOR`、`MINOR`、`TRIVIAL` 缺陷计数，用于与 `1:29:300` 理想比例比较。
- 流程 marker：对应 PlantUML 中“海因里希三角条数 = 1/2”的关键质量节点；累计达到配置阈值后触发审计任务。

这使系统既能评估实际缺陷分布，也能跟踪是否按流程执行了必要的质量检查。

## 配置

默认配置位于 `packages/context/src/config.ts`。运行时可在 `.octo/config.json` 覆盖 AI 配置；以下环境变量具有更高优先级：

| 环境变量 | 作用 |
| --- | --- |
| `OCTOPUS_STORE_DIR` | 状态存储目录 |
| `OCTOPUS_AI_MODEL` | Claude 默认模型 |
| `OCTOPUS_AI_TIMEOUT` | AI 调用超时，单位毫秒 |
| `OCTOPUS_AI_CLAUDE_PATH` | Claude CLI 可执行文件路径 |

默认 AI 配置使用 `claude`、`haiku`、120 秒超时和两次重试。AI 客户端通过子进程执行 `claude -p`；使用前需确保该命令在当前进程的 `PATH` 中可见并已完成认证。

## 当前边界

- 这是本地单机工作流工具，不包含 Web UI、多项目协同服务或完整团队权限系统。
- 外部平台目前以接口和适配层为主，没有端到端实现 SonarQube、Postman、监控或项目管理平台同步。
- CLI 的 `ai` 子命令当前展示接入要求，尚未把 Agent Layer 的全部专业方法接入真实输入与输出。
- PlantUML 中的组织流程比自动化引擎更细；新增或调整流程时，应同步维护 PlantUML、`packages/core/src/phase.ts`、任务模板和测试。

## 开发约定

- 使用 TypeScript strict mode 和 ESM。
- 使用 pnpm workspace 管理多包依赖。
- 使用 Vitest 测试，Biome 进行静态检查和格式校验。
- 保持核心引擎与具体 AI、存储和外部平台实现解耦。
- 行为变更应同步添加或更新测试，并确保 `pnpm build && pnpm test && pnpm lint` 通过。
