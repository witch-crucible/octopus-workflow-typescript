# Agents.md

## 项目概览

Octopus Workflow 是一个基于 TypeScript 的 AI 辅助软件交付工作流引擎。它把研发流程建模为可版本化的 DAG，并持久化项目、需求、节点运行状态和审计事件。

仓库使用 pnpm workspace，运行环境要求 Node.js 20+ 和 pnpm 9.15.0。

## 目录结构

- `packages/core`：领域模型、类型、错误和基础规格。
- `packages/context`：项目/需求上下文、Supabase PostgreSQL 状态库和配置加载。
- `packages/workflow-engine`：工作流解析、同步、调度和运行状态管理。
- `packages/executor`：动作执行和运行时编排。
- `packages/agent-layer`：AI agent 能力和模块注册。
- `packages/task-library`：可复用任务能力。
- `packages/integration`：外部系统集成（包括 Teambition 相关能力）。
- `packages/plugin`：项目级插件和扩展能力。
- `packages/cli`：命令行入口。
- `packages/desktop`：Web 界面和 macOS Electron 外壳。
- `workflow.yaml`：默认的、可版本化的工作流 DAG。
- `workflow/nodes/<nodeKey>/`：节点业务目录，标准结构为 `README.md`、`src/` 和 `test/`；`workflow/shared/`：节点共享目录。
- `docs/`：设计文档、计划和归档资料。
- `.octo/`：本地配置、身份、日志和 worker 运行文件；核心状态只存于 Supabase，不应提交凭据或运行时数据。

包之间通过 `workspace:*` 依赖连接。修改共享类型或 `core` 时，要检查下游包的类型检查和测试。

## 常用命令

```bash
pnpm install --frozen-lockfile  # 安装依赖
pnpm build                     # 全 workspace TypeScript 类型检查
pnpm -r build                  # 编译各包并生成 dist
pnpm test                      # 运行 Vitest 测试
pnpm test:watch                # 监听模式运行测试
pnpm lint                      # Biome 检查 packages/ 和节点 src/test
pnpm lint:fix                  # 自动修复可修复的 lint 问题
pnpm verify                    # build + test + lint
pnpm clean                     # 清理各包 dist 和 tsbuildinfo
pnpm web                       # 构建并启动本地 Web 界面
```

开发 CLI 或桌面/Web 界面前先执行 `pnpm -r build`。提交前至少执行 `pnpm verify`；涉及 native SQLite、Electron 或界面代码时，再执行对应的构建/启动检查。

## 开发约定

- 使用 TypeScript ESM；遵循现有 `tsconfig` 的严格模式、`noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes` 约束。
- 优先复用现有领域类型、错误类型和包边界，不在 CLI、UI 中重复实现领域规则。
- Desktop/Web UI 统一以 React、Tailwind CSS 与官方 shadcn/ui 为组件库标准。基础控件、反馈、确认框和主题能力优先复用 shadcn/ui（Radix）组件与 Tailwind token，不再新增仿制控件或仅复制视觉样式；保留 SVG 工作流图、甘特图等专用可视化实现（由 React 宿主挂载）。
- 新增行为应同时补充测试；包内测试沿用现有同目录结构，工作流节点测试统一放在节点的 `test/` 中；测试文件使用 `*.test.ts`，测试框架为 Vitest。
- 保持导入路径和文件名大小写与现有代码一致。不要通过放宽 TypeScript 配置来规避类型错误。
- 使用 Biome 格式和 lint 规则；修改后运行 `pnpm lint`。
- 对外部集成、AI 调用和文件/数据库操作保留清晰的失败信息，避免吞掉异常。
- 不要提交 `dist/`、`node_modules/`、`.octo/`、本地凭据或生成的发布产物。

## 节点目录规范

- `workflow/nodes/<nodeKey>/src/` 只放该节点拥有的业务逻辑；可跨节点复用的领域类型和公共逻辑放在 `packages/` 的合适包或 `workflow/shared/`，不要复制到 CLI、Desktop 或多个节点中。
- `workflow/nodes/<nodeKey>/test/` 放该节点的 `*.test.ts`，测试通过 `../src/` 导入业务实现；不要把测试文件放入 `src/`，避免被生产构建输出。
- 节点目录不是独立 npm/pnpm 项目或 workspace，不得放置节点级 `package.json`、`tsconfig.json`、`node_modules`、`dist` 或 `tsconfig.tsbuildinfo`。
- 节点源码由外层 `packages/workflow-engine` 统一类型检查、编译和运行，依赖使用外层 workspace 的 `node_modules`；节点测试和 lint 分别由根目录 Vitest、Biome 配置统一发现。
- `packages/workflow-engine` 负责向节点注入项目状态、AIClient、Artifact 持久化等运行时能力；节点目录负责提示词选择、业务分支和节点产出约定等节点业务规则。
- 新增节点运行逻辑时，除创建节点目录外，还要在外层引擎完成显式装配或注册；目录存在本身不代表代码会被自动执行。

## 工作流配置

- 自定义节点 `key` 必须使用英文 kebab-case；`name` 和 `description` 使用英文。
- 修改 `workflow.yaml` 或 `workflow.overlay.yaml` 后运行工作流校验相关命令，并检查依赖图没有环或悬空依赖。
- `workflow.overlay.yaml` 用于项目级增删改节点，不要无必要地复制整份工作流。
- 插件引用按 `workflow.yaml`、`.octo/config.json`、项目根目录 overlay 的顺序合并。插件加载失败应保持明确可诊断。
- 变更节点动作、依赖、角色或执行语义时，同时检查 `packages/core/src/spec.ts` 及 workflow-engine 的调度逻辑。

## 状态与集成

- 默认状态目录为 `.octo/`，可通过 `OCTOPUS_STORE_DIR` 覆盖。
- 不要把 Teambition、AI 或其他集成的密钥写入源码、测试快照或文档示例。
- AI 节点依赖本机已安装并登录的 Claude CLI；集成测试应优先使用 fixtures 或 mock，避免依赖真实外部服务。
- Web 默认监听 `127.0.0.1:4173`；CLI、Web、Electron 和 worker 共享 `DATABASE_URL` 指向的核心状态库。

## 修改流程

1. 先阅读目标包的实现、测试和相关设计文档，确认包边界和现有行为。
2. 以最小范围实现修改，并为可验证的新行为补充回归测试。
3. 运行与改动相关的测试，再运行 `pnpm verify`。
4. 检查 `git diff`，确认没有意外修改生成文件、依赖锁文件或本地状态。
5. 在交付说明中列出修改内容和实际执行过的验证命令；若某项验证因环境原因未执行，要明确说明。

## 相关文档

- `README.md`：完整启动方式、CLI 命令和产品能力说明。
- `docs/plans/`：当前设计和版本计划。
- `docs/archive/`：已归档的设计资料。
