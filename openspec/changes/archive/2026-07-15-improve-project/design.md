## Context

项目已有核心工作流引擎与 CLI 骨架，但本地可用性不足：测试覆盖不足、CLI 错误处理与机器可读输出不完整、配置与 Git 集成仍偏弱。本次改进以“本地开发者工具”为核心目标，优先补齐可靠性、可测试性与脚本化能力。

## Goals / Non-Goals

**Goals:**
- 提升核心包可测试性与可靠性
- CLI 提供一致的 `--json` 输出与错误退出码
- 提供基础配置读取与本地 Git 能力
- 保护本地运行时目录不被提交

**Non-Goals:**
- 外部系统深度集成（如 SonarQube/Postman/Monitoring）
- 多用户/远程协作能力
- 分布式或服务化部署

## Decisions

- **CLI 错误处理**：在命令入口捕获已知错误并统一输出错误信息，失败时调用 `process.exit(1)`；未知错误仅记录兜底信息。
- **配置系统**：保留现有优先级（环境变量 > 配置文件 > 默认值），支持 `storeDir` / `ai.model` / `ai.timeout`。
- **Git 集成**：先补齐基础只读能力（版本、仓库根目录、当前分支），再视需要扩展写操作。
- **测试策略**：优先在 `workflow-engine` 补充单测，保持 `createEngine()` 辅助函数用于隔离状态目录。

## Risks / Trade-offs

- [CLI 输出格式变化] → Mitigation：仅新增 `--json` 开关，默认人读输出不变。
- [配置文件路径依赖] → Mitigation：所有路径解析使用 `path.join`，避免硬编码分隔符。
- [Git 命令依赖本地环境] → Mitigation：健康检查前置，失败时返回明确错误。

## Migration Plan

1. 修复 `.gitignore` 保护本地目录
2. 扩展 `workflow-engine` 单测
3. 统一 CLI 错误处理与 `--json` 输出
4. 增强配置与 Git 基础能力
5. 运行 `pnpm build` / `pnpm test` 验证

## Open Questions

- 是否需要 CLI 全局 `--config <path>` 参数？
- Git 集成是否仅支持当前仓库检测，还是需要多仓库管理？
