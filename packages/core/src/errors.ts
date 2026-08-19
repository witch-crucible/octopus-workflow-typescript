/**
 * 自定义错误类型 —— 区分不同场景的失败原因。
 *
 * 所有错误继承 OctopusError，便于上层统一 catch 并按 code 路由。
 */

/** 错误码枚举——覆盖所有可能的失败场景 */
export type ErrorCode =
  | "INVALID_PHASE_TRANSITION"
  | "PHASE_LOCKED"
  | "TASK_NOT_FOUND"
  | "AGENT_CALL_FAILED"
  | "AGENT_TIMEOUT"
  | "CONFIG_INVALID"
  | "CONFIG_NOT_FOUND"
  | "WORKFLOW_INVALID_STATE"
  | "WORKFLOW_STUCK"
  | "ARTIFACT_NOT_FOUND"
  | "STORE_LOAD_FAILED"
  | "STORE_SAVE_FAILED"
  | "PROJECT_NOT_FOUND"
  | "INVALID_INPUT"
  | "INTERNAL_ERROR"

/** 基类 —— 所有错误的父类 */
export class OctopusError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = "OctopusError"
  }
}

/** 阶段相关错误 —— 非法转换、锁定、前置条件不满足 */
export class PhaseError extends OctopusError {
  constructor(message: string, cause?: unknown) {
    super("INVALID_PHASE_TRANSITION", message, cause)
    this.name = "PhaseError"
  }
}

/** Agent 调用错误 —— AI Agent 执行失败或超时 */
export class AgentError extends OctopusError {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
    cause?: unknown,
  ) {
    super("AGENT_CALL_FAILED", message, cause)
    this.name = "AgentError"
  }
}

/** 配置错误 —— 配置文件缺失、格式错误或校验失败 */
export class ConfigError extends OctopusError {
  constructor(
    message: string,
    public readonly filePath: string,
    cause?: unknown,
  ) {
    super("CONFIG_INVALID", message, cause)
    this.name = "ConfigError"
  }
}

/** AI 调用错误 —— AI 代理调用过程中的失败（超时、模型错误、解析失败） */
export class AICallError extends OctopusError {
  constructor(message: string, cause?: unknown) {
    super("AGENT_CALL_FAILED", message, cause)
    this.name = "AICallError"
  }
}

/** 阶段锁定错误 —— 尝试对已锁定的阶段执行操作 */
export class PhaseLockedError extends OctopusError {
  constructor(
    public readonly phase: string,
    public readonly reasons: string[],
  ) {
    super("PHASE_LOCKED", `阶段 ${phase} 已锁定: ${reasons.join("; ")}`)
    this.name = "PhaseLockedError"
  }
}

/** 非法阶段转换错误 —— 不允许的阶段跃迁 */
export class InvalidPhaseTransitionError extends OctopusError {
  constructor(
    public readonly fromPhase: string,
    public readonly toPhaseOrDir: string,
    message: string,
  ) {
    super("INVALID_PHASE_TRANSITION", message)
    this.name = "InvalidPhaseTransitionError"
  }
}

/** 存储错误 —— 状态持久化读写失败 */
export class StoreError extends OctopusError {
  constructor(
    code: "STORE_LOAD_FAILED" | "STORE_SAVE_FAILED",
    message: string,
    cause?: unknown,
  ) {
    super(code, message, cause)
    this.name = "StoreError"
  }
}

/** 工作流错误 —— 工作流状态非法或流程卡住 */
export class WorkflowError extends OctopusError {
  constructor(message: string, cause?: unknown) {
    super("WORKFLOW_INVALID_STATE", message, cause)
    this.name = "WorkflowError"
  }
}

/**
 * 穷举匹配辅助 —— 确保 switch/case 覆盖所有分支。
 * 当新的变体加入联合类型时，未处理的 case 会导致编译错误。
 *
 * @example
 *   switch (phase) {
 *     case Phase.DESIGN: return "designing"
 *     case Phase.IMPLEMENTATION: return "developing"
 *     // ...
 *     default: return assertNever(phase)
 *   }
 */
export function assertNever(value: never): never {
  throw new OctopusError(
    "INTERNAL_ERROR",
    `不应到达的分支: ${String(value)}`,
  )
}
