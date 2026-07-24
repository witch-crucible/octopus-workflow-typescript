/**
 * CLI 命令验证测试
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Command } from "commander"
import { buildInitCommand } from "./commands/init.js"
import { buildStatusCommand } from "./commands/status.js"
import { buildPhaseCommands } from "./commands/phase.js"
import { buildAiCommands } from "./commands/ai.js"
import { createStateStore } from "@octopus/context/index.js"
import { WorkflowEngine } from "@octopus/workflow-engine/index.js"

const TEST_STORE_DIR = ".octo_cli_test"

function createEngine() {
  return new WorkflowEngine({
    store: createStateStore({ storeDir: TEST_STORE_DIR }),
  })
}

describe("CLI 命令验证", () => {
  beforeEach(async () => {
    // 清理测试目录
    try {
      const fs = await import("node:fs")
      if (fs.existsSync(TEST_STORE_DIR)) {
        fs.rmSync(TEST_STORE_DIR, { recursive: true })
      }
    } catch {
      // ignore
    }
  })

  it("init 命令应正确创建项目", () => {
    const engine = createEngine()
    const program = new Command()
    buildInitCommand(program, engine)

    // 模拟命令行参数
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    program.parse(["node", "octopus", "init", "测试项目", "-d", "测试描述"])

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("init --json 应输出 JSON 格式", () => {
    const engine = createEngine()
    const program = new Command()
    buildInitCommand(program, engine)

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    program.parse(["node", "octopus", "init", "JSON测试项目", "--json"])

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    const jsonOutput = consoleLogSpy.mock.calls[0]?.[0]
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(jsonOutput)
    expect(parsed.projectName).toBe("JSON测试项目")
    expect(parsed.projectId).toBeDefined()
    expect(parsed.currentPhase).toBeDefined()

    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("status 命令应在无项目时返回错误", () => {
    const engine = createEngine()
    const program = new Command()
    buildStatusCommand(program, engine)

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit")
    })

    expect(() => {
      program.parse(["node", "octopus", "status"])
    }).toThrow("process.exit")

    expect(consoleErrorSpy).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(1)

    consoleErrorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it("phase advance 应正确前进阶段", () => {
    const engine = createEngine()
    const state = engine.initProject("阶段测试项目")
    
    // 完成所有任务
    const tasks = engine.getTasks(state.projectId, { phase: state.currentPhase })
    for (const task of tasks) {
      if (task.status !== "COMPLETED") {
        engine.completeTask(state.projectId, task.id)
      }
    }

    const program = new Command()
    buildPhaseCommands(program, engine)

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    program.parse(["node", "octopus", "phase", "advance"])

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(consoleLogSpy).toHaveBeenCalled()

    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("ai ask --json 应输出 JSON 格式", () => {
    const engine = createEngine()
    const program = new Command()
    buildAiCommands(program, engine)

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    program.parse(["node", "octopus", "ai", "ask", "你好", "--json"])

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    const jsonOutput = consoleLogSpy.mock.calls[0]?.[0]
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(jsonOutput)
    expect(parsed.prompt).toBe("你好")
    expect(parsed.result).toBeDefined()

    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })
})
