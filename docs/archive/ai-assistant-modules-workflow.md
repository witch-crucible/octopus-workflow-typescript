# PlantUML 核心 AI 节点模块化与工作流编排

## 总结

以 `project-process-AI.puml` 中的 12 类 AI 辅助节点为核心模块粒度。每个模块提供统一、可独立调用和独立测试的代码接口；现有六阶段工作流继续以 `DEFAULT_WORKFLOW_SPEC` 为唯一编排来源，通过能力注册表把步骤关联到对应模块。

保持现有 CLI、工作流状态、`.octo/` 持久化结构和 `AIClient.callAssistant(type, input)` 调用方式向后兼容，不引入新的 CLI 命令，不改动非 AI 业务步骤、外部集成或 Heinrich 逻辑。

## 实现变更

- 在 `packages/agent-layer` 中定义统一的 `AIAssistantModule` 契约：

  - 每个模块具有唯一的 `AIAssistantType`、名称及 `execute(input, client)` 方法。
  - 输入为调用方显式传入的文本；工作流没有提供输入时，兼容性回退为当前的“步骤名称：步骤描述”。
  - 输出继续使用现有 `AIResponse`，底层统一复用 `AIClient.ask()` 的 Claude CLI、超时、重试和 `AICallError` 行为。
  - 模块不得直接依赖工作流状态或持久化层，保证可以单独导入、执行和测试。

- 将 12 类能力拆成独立实现并由注册表集中装配：

  - 会议纪要总结
  - 需求分析
  - PRD 工时提取
  - Setup Checklist 校验
  - 技术方案审核
  - 技术文档同步
  - Checklist 增量推荐
  - 智能 Code Review
  - 自动化测试脚本生成
  - SQL 风险检测
  - 发布风险预评估
  - 技术债务量化

- 迁移当前已经存在的专用提示词和行为，保持输出意图不变；补齐当前落入通用提示词兜底的能力：

  - Setup Checklist 校验需覆盖图中明确列出的域名、CDN/WAF/SLB/ECS、Nginx、PHP、支付、Magento 和第三方接口配置检查。
  - 技术文档同步需根据代码或变更内容生成 API、ER 图、架构图等需要更新的文档建议及产出。
  - 测试脚本生成需根据接口资料生成 Postman Collection、断言和环境变量建议。
  - Checklist 增量推荐沿用 JSON 数组输出契约，以便现有工作流继续解析并写入 Checklist。

- 把 `AIClient.callAssistant()` 改为从模块注册表按 `AIAssistantType` 查找并执行，同时保留原方法签名：

  - 12 个枚举值必须全部注册；缺少注册视为开发错误，不再静默使用通用提示词。
  - 保留现有 `analyzeRequirements()`、`reviewCode()` 等公开便捷方法，并让它们委托给对应模块，避免破坏既有调用方。
  - 导出按类型获取和独立执行模块的代码 API，满足单模块开发和调用需求。

- 扩展工作流能力执行接口：

  - `runStepCapabilities(projectId, stepId, input?)` 新增可选显式输入参数，旧的两参数调用保持有效。
  - 显式输入传递给该步骤声明的 AI 模块；未提供时使用步骤元数据回退。
  - AI 结果仍按现有规则写入 Artifact；Checklist 推荐仍写入当前阶段 Checklist；`capabilityRuns` 继续记录类型、引用、成功状态、时间和摘要。
  - 一个步骤包含多个能力时，只有 AI 能力消费显式文本，Integration 和 Heinrich 的行为保持不变。
  - 继续由 `packages/core/src/spec.ts` 中的 `capabilities` 关联模块，不在引擎中硬编码阶段或步骤判断。

## 公共接口与兼容性

- 新增 `AIAssistantModule`、模块注册表查询及单模块执行 API。
- `WorkflowEngine.runStepCapabilities()` 的第三个输入参数为可选参数，因此现有调用无需修改。
- `AIAssistantType` 的 12 个现有枚举值、`AIClient.callAssistant()`、专业助手便捷方法和 `AIResponse` 保持兼容。
- 不新增 CLI 命令；现有 `ai`、`step run` 和其他命令行为不主动扩展。
- 不修改工作流阶段顺序、步骤 ID、依赖关系、状态文件结构、Artifact 基本结构或 Checklist JSON 解析契约。

## 测试与验收

- 为每个 AI 子模块添加独立单元测试：

  - 验证类型与注册项一一对应，12 个枚举值无遗漏、无重复。
  - 验证模块生成对应领域的 system prompt 和用户输入。
  - 验证显式输入原样传入，不实际调用 Claude CLI。
  - 验证底层调用异常继续按现有错误类型传播。

- 为兼容层添加测试：

  - 现有专业助手方法仍调用正确模块。
  - `callAssistant()` 对全部 12 类能力均走专用模块，不再走通用提示词。
  - 注册缺失时产生明确错误。

- 扩展工作流集成测试：

  - 显式输入能够从 `runStepCapabilities()` 到达指定模块并生成 Artifact。
  - 不传输入时仍使用步骤名称和描述，证明旧调用兼容。
  - Checklist 推荐的合法 JSON 能新增清单项；非法 JSON 不破坏状态，并保留能力执行记录。
  - 未配置 `AIClient`、无 capability、Integration、Heinrich 以及多 capability 步骤保持现有行为。
  - 六阶段 spec 中所有 AI capability 都能解析到已注册模块。

- 完成后运行：

  - `pnpm build`
  - `pnpm test`
  - `pnpm -r build`
  - `git diff --check`

  测试使用假客户端，不调用真实 Claude、不访问网络；若测试生成 `.octo_cap_test` 等运行态目录，只清理测试产生的未跟踪状态，不改动用户已有文件。

## 假设与边界

- “核心节点”确定为 PlantUML 中的 12 类 AI 辅助能力，而不是六个阶段或约 54 个普通业务步骤。
- “单独实现”指每个能力具备独立代码 API、实现和测试，不要求第一期增加专用 CLI。
- 第一阶段的“真实逻辑”是完整的领域提示词、输入输出契约和工作流落库行为；不会虚构外部录音、Excel、Postman、Sonar、代码仓库或文档平台连接器。
- 显式输入首期为单段文本；文件读取、Artifact 自动选择、多个输入合并和外部系统抓取不在本次范围内。
- 工作区当前没有检测到待保护的已有修改；实施时仍需在修改前重新确认工作区状态。
