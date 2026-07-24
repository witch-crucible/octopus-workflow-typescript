## Context

当前 `packages/workflow-engine/src/index.ts` 实现了阶段级（Phase）状态机，但流程文档定义了更细粒度的 Stage 依赖、AI 自动化门控、Heinrich 条数语义、Checklist 继承等。代码与文档存在落差，导致流程协作规范无法被系统执行。

## Goals / Non-Goals

**Goals:**
- Stage 级任务依赖和完成检查
- AI 门控（阶段前进前自动触发预检查）
- Heinrich 条数阈值触发质量审计
- Checklist 继承 + AI 增量推荐
- 轻量角色权限校验

**Non-Goals:**
- 外部系统深度集成（Sonar/Postman/Monitoring 保持接口层）
- Web UI 或可视化界面
- 多项目/团队协作权限体系

## Decisions

### D1: Stage 作为 Task 的元数据而非独立状态机

**Decision:** 引入 `StageStatus` 枚举（PENDING/IN_PROGRESS/COMPLETED/BLOCKED），Task 增加 `stageId` 和 `stageStatus` 字段。阶段前进前检查当前阶段所有 Stage 是否 COMPLETED。

**Rationale:** 保持现有 Phase 状态机不变，避免破坏性重构。Stage 状态是 Phase 状态的补充，而非替代。

**Alternatives considered:**
- 独立 Stage 状态机：过于复杂，与现有 Phase 状态机耦合度低
- 仅记录 Stage 完成时间，不阻塞阶段前进：失去流程控制能力

### D2: AI 门控采用事件驱动订阅模式

**Decision:** 引入 `AIEventHandler` 接口，WorkflowEngine 在阶段前进前触发 `onPhaseAdvance` 事件，由外部注册的 handler 执行 AI 检查。

**Rationale:** 保持核心引擎无依赖，AI 调用可插拔。避免核心流程阻塞在 AI 响应上。

**Alternatives considered:**
- 引擎内硬编码 AI 调用：耦合度高，难以测试
- 纯手动触发：无法利用流程文档中的自动化语义

### D3: Heinrich 条数 = 关键节点通过计数

**Decision:** 新增 `HeinrichAuditTrigger` 记录条数，每条记录关联阶段和触发原因。条数达到阈值（如 3）时自动生成质量评估任务。

**Rationale:** 条数在流程文档中是"质量门控触发次数"，与缺陷计数解耦。缺陷计数保留原有用途。

**Alternatives considered:**
- 条数 = 缺陷计数：语义混淆，无法区分主动审计与被动缺陷
- 条数完全手动：失去自动化门控能力

### D4: Checklist 继承在阶段转换时自动执行

**Decision:** `advancePhase` 时，将上一阶段 Checklist 中 `status === VERIFIED || NA` 的项复制到新阶段，标记 `inherited: true`。AI 增量推荐通过 `AIClient.callAssistant('CHECKLIST_RECOMMENDATION', ...)` 触发。

**Rationale:** 流程文档明确要求"继承历史 Checklist"，自动继承减少重复劳动。

**Alternatives considered:**
- 纯手动复制：增加操作负担，容易遗漏
- 全部复制并重置状态：失去已验证项的延续性

### D5: 轻量权限基于 Role + responsibleRole

**Decision:** 新增 `requireRole(projectId, taskId, role)` 校验，只有 Task.responsibleRole 对应的角色可以标记完成/核验清单。本地工具场景下，权限校验可通过配置关闭。

**Rationale:** 流程文档有明确责任链，但本地工具应保持灵活性。可关闭设计避免过度工程。

**Alternatives considered:**
- 硬权限不可关闭：本地开发场景过于严格
- 无权限校验：责任链无法执行，流程文档语义丢失

## Risks / Trade-offs

- [Stage 状态增加复杂度] → 提供 `getPhaseProgress` 聚合视图，保持 CLI 输出简洁
- [AI 门控延迟阶段前进] → 支持 `--skip-ai-gates` 强制前进，记录审计日志
- [Checklist 继承可能携带不适用项] → 继承后允许标记 NA，不影响前进门控
