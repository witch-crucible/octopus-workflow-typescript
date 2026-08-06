# Octopus Workflow TypeScript

Octopus 是一个 TypeScript 实现的 AI 辅助研发工作流引擎，将软件交付过程建模为可持久化、可检查、可通过 CLI 操作的阶段与步骤。

```text
需求分析 → 设计 → 开发 → 测试 → 部署 → 维护
```

当前项目提供本地 CLI 和 macOS Electron 桌面外壳。工作流定义以 [`packages/core/src/spec.ts`](packages/core/src/spec.ts) 为准，运行状态默认保存在当前目录的 `.octo/`。

## 核心能力

- 以统一的 Step 模型记录负责人、依赖、状态和产出，Task 与 Stage 是其派生视图。
- 阶段推进前检查未完成步骤、Checklist 和步骤依赖，并支持回退。
- 通过统一模块契约注册并调度 12 类 AI 助手，以及外部集成和 Heinrich 质量能力。
- 按 `1:29:300` 记录和评估重大、轻微、未遂风险。
- 使用本地 JSON 持久化状态，主要命令支持 `--json` 输出。

## 快速开始

要求 Node.js 20+、pnpm 9.15.0；AI 能力还需要已安装并登录的 Claude CLI。

```bash
pnpm install
pnpm -r build

node packages/cli/dist/index.js init "示例项目"
node packages/cli/dist/index.js status
node packages/cli/dist/index.js task list
node packages/cli/dist/index.js stage list
```

构建后可将 `node packages/cli/dist/index.js` 视为下文的 `octopus`。如果本地只有一个项目，多数命令可省略 `projectId`。

常用操作：

```bash
octopus task complete <taskId>
octopus stage update <stageId> COMPLETED
octopus checklist add "发布" "回滚方案已确认"
octopus checklist check <itemId>
octopus step run <stageId>
octopus phase advance
```

使用 `octopus --help` 或 `octopus <command> --help` 查看完整参数。

## 命令概览

| 命令 | 用途 |
| --- | --- |
| `init`、`status` | 创建项目、查看项目状态 |
| `phase` | 查看、推进或回退阶段 |
| `task`、`stage` | 查看和更新步骤的任务/阶段视图 |
| `checklist` | 添加、核验和删除检查项 |
| `step run` | 调度步骤声明的 AI、集成或 Heinrich 能力 |
| `heinrich` | 记录风险、流程标记和质量评估 |
| `ai` | AI 问答、审查、估时、SQL 检查和技术债务入口 |

阶段值为 `RequirementsAnalysis`、`Design`、`Development`、`Testing`、`Deployment`、`Maintenance`；步骤状态为 `PENDING`、`IN_PROGRESS`、`COMPLETED`、`BLOCKED`、`SKIPPED`。

## AI 助手模块

`@octopus/agent-layer` 将 12 类 AI 能力按统一的 `AIAssistantModule` 契约独立实现，并由注册表与 `AIAssistantType` 一一对应：

- 会议纪要、需求分析、估时提取；
- Setup Checklist 校验、技术方案审核、文档同步；
- Checklist 增量推荐、Code Review、测试脚本生成、SQL 风险检测、发布风险评估、技术债务量化。

`AIClient.callAssistant(type, input)` 保持原有调用方式；代码也可通过 `getAIAssistantModule()` 获取单个模块，或使用 `executeAIAssistantModule()` 独立执行。工作流根据 `packages/core/src/spec.ts` 中步骤声明的 AI capability 选择模块：普通结果写入 Artifact，Checklist 推荐结果解析后写入当前阶段清单。

`WorkflowEngine.runStepCapabilities(projectId, stepId, input?)` 可向 AI 模块传入显式文本；省略时使用步骤名称和描述作为兼容性输入。CLI 的 `step run` 当前未开放该输入参数。

## 项目结构

| 包 | 职责 |
| --- | --- |
| `@octopus/core` | 工作流规格与领域模型 |
| `@octopus/workflow-engine` | 状态转换、门控和能力调度 |
| `@octopus/task-library` | 从规格生成运行时步骤 |
| `@octopus/context` | 配置与 `.octo/` 状态存储 |
| `@octopus/agent-layer` | Claude CLI 客户端、AI 助手模块与注册表 |
| `@octopus/integration` | Git、Teambition、安全监控及外部集成契约 |
| `@octopus/cli` | `octopus` 命令行入口 |
| `@octopus/desktop` | macOS Electron 外壳，详见 [`packages/desktop/README.md`](packages/desktop/README.md) |

状态目录：

```text
.octo/
├── config.json
├── index.json
└── projects/
    └── <projectId>.json
```

## 配置

`.octo/config.json` 可覆盖默认配置，以下环境变量优先级更高：

| 环境变量 | 用途 |
| --- | --- |
| `OCTOPUS_STORE_DIR` | 状态存储目录 |
| `OCTOPUS_AI_MODEL` | Claude 模型 |
| `OCTOPUS_AI_TIMEOUT` | AI 调用超时（毫秒） |
| `OCTOPUS_AI_CLAUDE_PATH` | Claude CLI 路径 |

## 开发

```bash
pnpm build   # TypeScript 类型检查，不生成 dist
pnpm test
```

需要生成各包的 `dist` 时运行 `pnpm -r build`。

## 当前边界

- CLI 的 `ai` 子命令目前仅输出接入提示；步骤上的 AI capability 由 `step run` 调用 Agent Layer。
- AI 模块当前只接收调用方提供的单段文本，不会自动读取录音、Excel、代码仓库或外部文档平台。
- SonarQube、Postman、监控等能力需要注册对应集成服务；默认 CLI 未注入这些实现。
- 桌面端目前只支持列出、创建和查看项目。
- 调整流程时应同步更新工作流规格及相关测试；README 不重复维护完整步骤清单。
