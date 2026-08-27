# Requirements Analysis and BRD Design

PM analyzes requirements and completes the BRD. Octopus can **generate**, **check**, or use a project-local Hermes Agent Skill to **automatically optimize** the BRD from current requirements, historical BRDs, and project code.

| 节点编号 (Node ID) | 10.1 |
| --- | --- |
| Phase | Intention |
| Responsible Roles | PM |
| Depends On | None |
| Actions | Manual（完成前用 CLI/Web 配置并跑 `brd optimize`，或使用兼容入口 `brd generate` / `brd check`） |

## 实现位置

- `src/index.ts`：本节点拥有的 BRD 生成/检查业务编排、提示词选择和产出约定。
- `src/context.ts`：本节点拥有的源上下文采集与提示词渲染。
- `test/`：本节点业务逻辑的 Vitest 测试，与生产源码分离。
- `.hermes/skills/brd-generator/SKILL.md`：Hermes 项目级 Skill，负责起草、内部审查与最多三轮自动修订。
- 节点目录不是独立 npm/pnpm 项目，不放置 `package.json`、`tsconfig.json`、`node_modules` 或 `dist`。
- `packages/core`：复用的配置、领域枚举和 Artifact 类型。
- `packages/workflow-engine`：统一编译并调用 `workflow/nodes/*/src`，提供项目状态、AIClient 与 Artifact 持久化，并保留公开 API 兼容入口；节点依赖使用其外层 `node_modules`。
- `packages/cli`、`packages/desktop`：CLI/Web 入口与展示层，不重复节点业务规则。

## 能力

结合小程序、官网、前端代码、后端代码（及展示信息）和持续增加的历史 BRD 生成当前 BRD，或检查已有 BRD 的完善性。历史文档只复用结构、术语和表达习惯，不作为当前项目事实。

## 项目配置（by 项目）

配置持久化在项目 `metadata.brdDesign`（JSON）。可用 Web「项目 → 设置 → BRD 设计」或 CLI：

```bash
octopus brd config set <projectId> \
  --miniprogram apps/mini \
  --website-code apps/www \
  --frontend apps/web \
  --backend apps/api \
  --miniprogram-artifact dist/mini \
  --website-url https://example.com \
  --history docs/brd-history docs/approved/example-brd.md \
  --spec docs/brd-spec.md \
  --output workflow/nodes/requirements-analysis-and-brd-design/brd.md

octopus brd config <projectId>
```

| 分类 | 字段 | CLI 选项 |
| --- | --- | --- |
| 代码 | 小程序 / 官网 / 前端 / 后端路径 | `--miniprogram` `--website-code` `--frontend` `--backend` |
| 展示 | 小程序编译产物、官网域名 | `--miniprogram-artifact` `--website-url` |
| 历史 | 历史 BRD 文件或目录（可多个） | `--history`；清除用 `--clear-history` |
| 规范 | BRD 规范文件 | `--spec`（缺省用内置默认规范） |
| 产出 | BRD 地址 | `--output`（缺省本节点目录 `brd.md`） |

未配置代码源时仍可仅凭需求描述 + 规范生成/检查，CLI 会给出警告。

## 提示词（可配置）

内置一组提示词：`summarize-sources`、`generate`、`check`。项目可覆盖任意一条：

```bash
octopus brd prompt-set <projectId> --id generate --system-file gen.system.md --user-file gen.user.md
octopus brd prompts <projectId> [requirementId] --mode generate|check|all [--write] [--json]
```

模板支持占位符：`{{requirementName}}` `{{requirementDescription}}` `{{brdSpec}}` `{{sourcesSummary}}` `{{existingBrd}}` `{{historicalBrds}}` `{{websiteUrl}}` `{{miniprogramBuildArtifact}}`。

`--write` 会把渲染结果落到本节点 `prompts/` 目录，便于人工审阅。

## 生成 / 检查

```bash
octopus brd generate [requirementId] [--dry-run] [--json]
octopus brd optimize [requirementId] [--dry-run] [--json]
octopus brd check [requirementId] [--dry-run] [--json]
```

- `generate`：写入配置的 BRD 产出路径，并登记 `ArtifactType.BRD`
- `optimize`：以 `hermes --oneshot` 无头模式预加载 `brd-generator` Skill；基于最新历史 BRD 与当前代码完成起草、审查和自动修订，只将最终 Markdown 写入产出路径并登记 `ArtifactType.BRD`
- `check`：要求已有 BRD；报告写到同目录 `brd-check-report.md`，**不覆盖** BRD 正文
- `--dry-run`：只渲染提示词，不调用 AI/Hermes

## Hermes 无头模式准备

本节点不启动 Hermes TUI 或交互会话。运行时调用形态为：

```bash
hermes --in <projectRoot> --skills brd-generator --toolsets skills --oneshot <prompt>
```

Hermes 项目级 Skill 首次使用前需要在仓库内完成一次信任（这是 Hermes 的安全要求，不由 Octopus 自动修改用户配置）：

```bash
hermes skills trust
```

默认从 `PATH` 查找 `hermes`。如安装位置不同，可设置 `OCTOPUS_AI_HERMES_PATH`，或在 `.octo/config.json` 的 `ai.hermesPath` 中配置。无头任务只启用 `skills` toolset，不让 Hermes 直接修改项目文件；落盘仍由本节点完成。

历史 BRD 有界采集仅支持 `md`、`markdown`、`txt`、`adoc`，最多读取 20 个文件；缺失、不支持或截断均返回明确警告。每次 `optimize` 都重新读取配置路径，因此新增历史文档无需重新配置或训练模型。

确认 `brd.md` 后，用 `octopus node complete requirements-analysis-and-brd-design`（或 UI）标记本节点完成。
