## Why

当前项目已具备核心领域模型、工作流引擎、CLI 骨架和本地状态持久化，但距离“本地开发者工具”的可用目标仍有明显缺口：缺少测试安全网、CLI 错误处理与输出体验不足、外部集成与配置体系尚未完善。现在补齐这些基础能力，可显著提升可维护性和本地可用性。

## What Changes

- 完善 `.gitignore`，确保 `.octo/` 等本地状态目录不被提交
- 扩充 `workflow-engine` 单测覆盖核心场景，建立质量安全网
- 改进 CLI 错误处理与退出码，统一失败反馈
- 增加 CLI `--json` 输出，支持脚本化/管道使用
- 实现配置系统，支持 `storeDir` / `ai.model` / `ai.timeout` 等基础配置
- 增强 Git integration 基础操作，支持本地仓库信息读取与状态感知

## Capabilities

### New Capabilities

- `project-hardening`: 覆盖 gitignore、基础配置、集成与 CLI 可靠性改进

### Modified Capabilities

- （无）

## Impact

- `packages/workflow-engine` 新增测试
- `packages/cli` 调整错误处理与输出格式
- `packages/integration` 新增 git 基础能力
- `packages/context` 增加配置读取能力
- 根目录 `.gitignore` 更新
