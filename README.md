# Octopus Workflow TypeScript

Octopus 是一个 TypeScript 实现的 AI 辅助研发工作流引擎，将交付过程建模为可持久化、可检查的阶段与步骤：

```text
需求分析 → 设计 → 开发 → 测试 → 部署 → 维护
```

项目以 [`packages/core/src/spec.ts`](packages/core/src/spec.ts) 为工作流定义，提供本地 CLI 和 macOS Electron 桌面端；CLI 状态默认保存在当前目录的 `.octo/`。

## 快速开始

要求 Node.js 20+、pnpm 9.15.0。AI 步骤还需要已安装并登录的 Claude CLI。

```bash
pnpm install
pnpm -r build

node packages/cli/dist/index.js init "示例项目"
node packages/cli/dist/index.js status
node packages/cli/dist/index.js task list
```

下文以 `octopus` 代指 `node packages/cli/dist/index.js`。只有一个项目时，多数命令可省略 `projectId`。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `octopus init <name>`、`octopus status` | 创建项目、查看状态 |
| `octopus phase list/advance/rollback` | 查看、推进或回退阶段 |
| `octopus task list/complete/set-status` | 查看和更新任务 |
| `octopus stage list/update` | 查看和更新步骤视图 |
| `octopus checklist show/add/check/remove` | 管理阶段清单 |
| `octopus step run <stageId>` | 执行步骤声明的 AI、集成或质量能力 |
| `octopus heinrich ...` | 记录和评估质量风险 |

使用 `octopus --help` 或 `octopus <command> --help` 查看完整参数。

## 任务导入导出

```bash
octopus task export [projectId] --output tasks.json
octopus task import tasks.json [projectId]
```

任务文件是版本化 JSON。导入按 `stageId` 合并状态、实际负责人、备注和完成时间；任一任务校验失败时不修改目标项目。导出默认不覆盖文件，可用 `--force` 覆盖；两条命令均支持 `--json`。

该文件用于传递任务进度，不是完整项目备份，不包含阶段锁、Checklist、Artifact 内容或 AI 门控结果。

## 桌面端

```bash
pnpm --filter @octopus/desktop start
```

桌面端支持创建和查看项目，并通过系统文件对话框导入、导出任务；数据保存在 Electron `userData/store`。任务编辑和阶段操作仍以 CLI 为主。

## 配置与数据

`.octo/config.json` 可覆盖默认配置，环境变量优先级更高：

| 环境变量 | 用途 |
| --- | --- |
| `OCTOPUS_STORE_DIR` | 状态目录 |
| `OCTOPUS_AI_MODEL` | Claude 模型 |
| `OCTOPUS_AI_TIMEOUT` | AI 超时（毫秒） |
| `OCTOPUS_AI_CLAUDE_PATH` | Claude CLI 路径 |

核心包：

- `@octopus/core`、`@octopus/task-library`、`@octopus/workflow-engine`：规格、步骤生成与状态机。
- `@octopus/context`：配置与 `.octo/` JSON 持久化。
- `@octopus/agent-layer`、`@octopus/integration`：AI 模块和外部集成。
- `@octopus/cli`、`@octopus/desktop`：命令行与 Electron 入口。

## 开发

```bash
pnpm build       # TypeScript 类型检查，不生成 dist
pnpm test
pnpm -r build    # 生成各包 dist
```

## 当前边界

- CLI 的 `ai` 子命令目前仅输出接入提示；步骤 AI 能力由 `step run` 调用。
- SonarQube、Postman、监控等能力需要注册对应集成服务，默认 CLI 未注入实现。
- 调整流程时应同步更新工作流规格及相关测试。
