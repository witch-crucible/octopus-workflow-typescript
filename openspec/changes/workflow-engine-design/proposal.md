## Why

工作流引擎当前只实现了阶段级（Phase）的状态机，但流程文档定义了更细粒度的步骤级（Stage）依赖、AI 自动化辅助、海因里希三角条数语义、Checklist 继承机制等丰富语义。代码与流程文档之间存在明显落差，导致流程文档中的关键协作规范无法被系统执行和跟踪。

## What Changes

- 引入 Stage 级任务生命周期，支持步骤依赖、前置完成检查
- 增加 AI 门控能力，支持阶段前进前自动触发 AI 预检查
- 扩展 Heinrich 模型，支持条数阈值触发的质量审计
- 实现 Checklist 继承与 AI 增量推荐机制
- 增加轻量角色权限校验，确保责任链可执行

## Capabilities

### New Capabilities
- `stage-lifecycle`: Stage 级别任务依赖、完成检查和进度跟踪
- `ai-gated-phases`: 阶段前进前自动调用 AI 进行预检查（技术方案审核、SQL 风险检测等）
- `heinrich-audit-triggers`: 海因里希条数阈值触发的质量审计
- `checklist-inheritance`: Checklist 继承 + AI 增量推荐
- `role-permissions`: 轻量角色权限，确保 responsibleRole 可执行对应操作

### Modified Capabilities
- `workflow-engine-core`: 阶段状态机扩展为阶段+步骤双层状态管理

## Impact

- `packages/workflow-engine/src/index.ts`：WorkflowEngine 扩展 Stage 级 API
- `packages/core/src/*.ts`：WorkflowState、Task、Checklist、HeinrichRecord 模型扩展
- `packages/cli/src/commands/*.ts`：新增 stage 子命令组
- `openspec/specs/workflow-engine-design/spec.md`：新增 delta spec
