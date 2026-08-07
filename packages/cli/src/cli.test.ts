/**
 * CLI 命令验证测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Command } from "commander"
import { buildInitCommand } from "./commands/init.js"
import { buildStatusCommand } from "./commands/status.js"
import { buildPhaseCommands } from "./commands/phase.js"
import { buildAiCommands } from "./commands/ai.js"
import { buildTaskCommands } from "./commands/task.js"
import { buildNodeCommands } from "./commands/node.js"
import { createStateStore } from "@octopus/context/index.js"
import { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { TaskStatus } from "@octopus/core/task.js"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const TEST_STORE_DIR = ".octo_cli_test"
const temporaryProjectRoots: string[] = []

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

  afterEach(() => {
    for (const directory of temporaryProjectRoots.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
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

  it("task export/import 应通过文件跨项目合并任务进度", () => {
    const engine = createEngine()
    const source = engine.initProject("导出源项目")
    const target = engine.initProject("导入目标项目")
    const sourceTask = engine.getTasks(source.projectId)[0]!
    engine.setTaskStatus(source.projectId, sourceTask.id, TaskStatus.COMPLETED)
    const exportPath = `${TEST_STORE_DIR}/tasks.json`

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const exportProgram = new Command()
    buildTaskCommands(exportProgram, engine)
    exportProgram.parse([
      "node",
      "octopus",
      "task",
      "export",
      source.projectId,
      "--output",
      exportPath,
      "--json",
    ])

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(existsSync(exportPath)).toBe(true)
    expect(JSON.parse(readFileSync(exportPath, "utf-8"))).toMatchObject({
      format: "octopus.tasks",
      version: 1,
    })

    const importProgram = new Command()
    buildTaskCommands(importProgram, engine)
    importProgram.parse(["node", "octopus", "task", "import", exportPath, target.projectId, "--json"])

    const imported = engine.getTasks(target.projectId).find((task) => task.stageId === sourceTask.stageId)!
    expect(imported.status).toBe(TaskStatus.COMPLETED)
    const result = JSON.parse(consoleLogSpy.mock.calls.at(-1)?.[0])
    expect(result).toMatchObject({ projectId: target.projectId, updated: 1 })

    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("task export 默认拒绝覆盖，--force 允许覆盖", () => {
    const engine = createEngine()
    const state = engine.initProject("覆盖测试项目")
    const exportPath = `${TEST_STORE_DIR}/existing.json`
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const firstProgram = new Command()
    buildTaskCommands(firstProgram, engine)
    firstProgram.parse(["node", "octopus", "task", "export", state.projectId, "-o", exportPath])

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit")
    })
    const secondProgram = new Command()
    buildTaskCommands(secondProgram, engine)
    expect(() => {
      secondProgram.parse(["node", "octopus", "task", "export", state.projectId, "-o", exportPath])
    }).toThrow("process.exit")
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("导出文件已存在"))
    exitSpy.mockRestore()

    const forceProgram = new Command()
    buildTaskCommands(forceProgram, engine)
    forceProgram.parse(["node", "octopus", "task", "export", state.projectId, "-o", exportPath, "--force"])
    expect(existsSync(exportPath)).toBe(true)

    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("task import 拒绝非法 JSON 且不修改项目", () => {
    const engine = createEngine()
    const state = engine.initProject("非法导入测试项目")
    const importPath = `${TEST_STORE_DIR}/invalid.json`
    writeFileSync(importPath, "{ invalid", "utf-8")
    const before = engine.getState(state.projectId)
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit")
    })

    const program = new Command()
    buildTaskCommands(program, engine)
    expect(() => {
      program.parse(["node", "octopus", "task", "import", importPath, state.projectId])
    }).toThrow("process.exit")

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("导入任务失败"))
    expect(engine.getState(state.projectId)).toEqual(before)

    consoleErrorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it("node create 创建可立即使用的 AI 文档节点", () => {
    const engine = createEngine()
    const projectRoot = mkdtempSync(join(tmpdir(), "octopus-cli-node-"))
    temporaryProjectRoots.push(projectRoot)
    const state = engine.initProject("节点创建测试", undefined, projectRoot)
    const program = new Command()
    buildNodeCommands(program, engine)
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    program.parse([
      "node",
      "octopus",
      "node",
      "create",
      "10.doc",
      "AI 生成文档",
      state.projectId,
      "--role",
      "AI",
      "--depends-on",
      "10.1",
      "--type",
      "ai",
      "--assistant",
      "DOCUMENT_SYNC",
      "--input",
      "生成技术文档",
      "--output",
      "documentation.md",
      "--if-exists",
      "extend",
      "--json",
    ])

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    const created = engine.getState(state.projectId).steps.find((step) => step.id === "10.doc")
    expect(created?.responsibleRole).toBe("AI")
    expect(created?.actions).toEqual([expect.objectContaining({
      type: "ai",
      outputFile: "documentation.md",
      ifExists: "extend",
    })])
    expect(existsSync(`${projectRoot}/workflow/nodes/10.doc`)).toBe(true)
    expect(readFileSync(`${projectRoot}/workflow.yaml`, "utf8")).toContain("10.doc")

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
