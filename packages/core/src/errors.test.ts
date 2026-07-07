import { describe, it, expect } from "vitest"
import {
  OctopusError,
  PhaseError,
  AgentError,
  ConfigError,
  WorkflowError,
  assertNever,
} from "./errors.js"

describe("OctopusError", () => {
  it("创建基础错误", () => {
    const err = new OctopusError("INTERNAL_ERROR", "test error")
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("INTERNAL_ERROR")
    expect(err.message).toBe("test error")
    expect(err.name).toBe("OctopusError")
  })
  it("支持 cause 参数", () => {
    const cause = new Error("root cause")
    const err = new OctopusError("INVALID_INPUT", "bad input", cause)
    expect(err.cause).toBe(cause)
  })
})

describe("PhaseError", () => {
  it("创建阶段错误", () => {
    const err = new PhaseError("设计阶段锁定，无法前进")
    expect(err).toBeInstanceOf(OctopusError)
    expect(err.code).toBe("INVALID_PHASE_TRANSITION")
    expect(err.name).toBe("PhaseError")
  })
})

describe("AgentError", () => {
  it("创建 AI Agent 错误", () => {
    const err = new AgentError("调用超时", 1, "timeout")
    expect(err.code).toBe("AGENT_CALL_FAILED")
    expect(err.exitCode).toBe(1)
    expect(err.stderr).toBe("timeout")
    expect(err.name).toBe("AgentError")
  })
})

describe("ConfigError", () => {
  it("创建配置错误", () => {
    const err = new ConfigError("配置文件格式错误", "/path/to/config.json")
    expect(err.code).toBe("CONFIG_INVALID")
    expect(err.filePath).toBe("/path/to/config.json")
    expect(err.name).toBe("ConfigError")
  })
})

describe("WorkflowError", () => {
  it("创建工作流状态错误", () => {
    const err = new WorkflowError("工作流卡住")
    expect(err.code).toBe("WORKFLOW_INVALID_STATE")
    expect(err.name).toBe("WorkflowError")
  })
})

describe("assertNever", () => {
  it("抛出 INTERNAL_ERROR", () => {
    expect(() => assertNever("unreachable" as never)).toThrow(OctopusError)
    expect(() => assertNever("unreachable" as never)).toThrow("不应到达的分支")
  })
})
