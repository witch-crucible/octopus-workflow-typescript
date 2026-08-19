/**
 * CLI 命令验证测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Command } from "commander"
import { buildInitCommand } from "./commands/init.js"
import { buildProjectCommands } from "./commands/project.js"
import { buildRequirementCommands } from "./commands/requirement.js"
import { buildStatusCommand } from "./commands/status.js"
import { buildPhaseCommands } from "./commands/phase.js"
import { buildAiCommands } from "./commands/ai.js"
import { buildTaskCommands } from "./commands/task.js"
import { buildNodeCommands } from "./commands/node.js"
import { buildWorkflowCommands } from "./commands/workflow.js"
import { createStateStore } from "@octopus/context/index.js"
import { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { TaskStatus } from "@octopus/core/task.js"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadWorkflowDefinition } from "@octopus/context/workflow.js"

const TEST_STORE_DIR = ".octo_cli_test"
const temporaryProjectRoots: string[] = []

function createEngine() {
  return new WorkflowEngine({
    store: createStateStore({ storeDir: TEST_STORE_DIR }),
  })
}

function seedRequirement(
  engine: WorkflowEngine,
  name: string,
  description?: string,
  projectRoot?: string,
) {
  const project = engine.createProject(name, description)
  return engine.initRequirement(project.projectId, name, description, projectRoot)
}

describe("CLI 命令验证", () => {
  beforeEach(async () => {
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
    rmSync(TEST_STORE_DIR, { recursive: true, force: true })
    for (const directory of temporaryProjectRoots.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("project create 后 init 应创建需求", () => {
    const engine = createEngine()
    const project = engine.createProject("容器项目")
    const program = new Command()
    buildInitCommand(program, engine)
    const projectRoot = mkdtempSync(join(tmpdir(), "octopus-cli-init-"))
    temporaryProjectRoots.push(projectRoot)

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    program.parse([
      "node",
      "octopus",
      "init",
      "测试需求",
      "--project",
      project.projectId,
      "-d",
      "测试描述",
      "--root",
      projectRoot,
    ])

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(engine.listRequirements(project.projectId)).toHaveLength(1)
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("init --json 应输出 JSON 格式", () => {
    const engine = createEngine()
    const project = engine.createProject("JSON容器")
    const program = new Command()
    buildInitCommand(program, engine)
    const projectRoot = mkdtempSync(join(tmpdir(), "octopus-cli-json-init-"))
    temporaryProjectRoots.push(projectRoot)

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    program.parse([
      "node",
      "octopus",
      "init",
      "JSON测试需求",
      "--project",
      project.projectId,
      "--root",
      projectRoot,
      "--json",
    ])

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    const jsonOutput = consoleLogSpy.mock.calls[0]?.[0]
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(jsonOutput)
    expect(parsed.requirementName).toBe("JSON测试需求")
    expect(parsed.requirementId).toBeDefined()
    expect(parsed.projectId).toBe(project.projectId)
    expect(parsed.currentPhase).toBeDefined()

    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("init 应允许在同一项目下创建第二个需求", () => {
    const engine = createEngine()
    const project = engine.createProject("共享项目")
    engine.initRequirement(project.projectId, "已存在需求")
    const program = new Command()
    buildInitCommand(program, engine)
    const projectRoot = mkdtempSync(join(tmpdir(), "octopus-cli-second-requirement-"))
    temporaryProjectRoots.push(projectRoot)

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    program.parse([
      "node",
      "octopus",
      "init",
      "第二个需求",
      "--project",
      project.projectId,
      "--root",
      projectRoot,
      "--json",
    ])

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    const parsed = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0]))
    expect(parsed.requirementName).toBe("第二个需求")
    expect(parsed.projectId).toBe(project.projectId)
    expect(engine.listRequirements(project.projectId)).toHaveLength(2)
    expect(existsSync(join(projectRoot, "workflow.yaml"))).toBe(true)

    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("requirement init/list/delete 应管理需求生命周期", () => {
    const engine = createEngine()
    const project = engine.createProject("需求容器")
    const program = new Command()
    buildRequirementCommands(program, engine)
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    program.parse([
      "node",
      "octopus",
      "requirement",
      "init",
      "生命周期需求",
      "--project",
      project.projectId,
      "--json",
    ])
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    const created = JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0]))
    expect(created.requirementId).toBeDefined()

    consoleLogSpy.mockClear()
    program.parse([
      "node",
      "octopus",
      "requirement",
      "list",
      "--project",
      project.projectId,
      "--json",
    ])
    const listed = JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0]))
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ requirementId: created.requirementId }),
    ]))

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit")
    })
    expect(() => {
      program.parse(["node", "octopus", "requirement", "delete", created.requirementId])
    }).toThrow("process.exit")
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("--yes"))
    expect(engine.listRequirements()).toContain(created.requirementId)
    exitSpy.mockRestore()
    consoleErrorSpy.mockClear()

    program.parse([
      "node",
      "octopus",
      "requirement",
      "delete",
      created.requirementId,
      "--yes",
    ])
    expect(engine.listRequirements()).not.toContain(created.requirementId)

    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("project list 在空库时应提示暂无项目", () => {
    const engine = createEngine()
    const program = new Command()
    buildProjectCommands(program, engine)
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    program.parse(["node", "octopus", "project", "list"])

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("暂无项目"))
    consoleLogSpy.mockRestore()
  })

  it("project create/update/delete 应管理项目容器", () => {
    const engine = createEngine()
    const program = new Command()
    buildProjectCommands(program, engine)
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    program.parse([
      "node",
      "octopus",
      "project",
      "create",
      "待更新项目",
      "--desc",
      "原始描述",
      "--json",
    ])
    const created = JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0]))
    expect(created.projectId).toBeDefined()
    expect(engine.listProjects()).toContain(created.projectId)

    consoleLogSpy.mockClear()
    program.parse([
      "node",
      "octopus",
      "project",
      "update",
      created.projectId,
      "--name",
      "新名称",
      "--desc",
      "新描述",
      "--json",
    ])
    const updated = JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0]))
    expect(updated.name).toBe("新名称")
    expect(updated.description).toBe("新描述")

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit")
    })
    expect(() => {
      program.parse(["node", "octopus", "project", "delete", created.projectId])
    }).toThrow("process.exit")
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("--yes"))
    expect(engine.listProjects()).toContain(created.projectId)
    exitSpy.mockRestore()

    program.parse(["node", "octopus", "project", "delete", created.projectId, "--yes"])
    expect(engine.listProjects()).not.toContain(created.projectId)

    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("project delete 会一并删除其下需求", () => {
    const engine = createEngine()
    const state = seedRequirement(engine, "连带删除需求")
    expect(engine.listRequirements()).toContain(state.requirementId)

    const program = new Command()
    buildProjectCommands(program, engine)
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    program.parse(["node", "octopus", "project", "delete", state.projectId, "--yes"])

    expect(engine.listProjects()).not.toContain(state.projectId)
    expect(engine.listRequirements()).not.toContain(state.requirementId)
    consoleLogSpy.mockRestore()
  })

  it("status 命令应在无需求时返回错误", () => {
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

  it("status 命令应输出需求与项目 ID", () => {
    const engine = createEngine()
    const state = seedRequirement(engine, "状态展示需求")
    const program = new Command()
    buildStatusCommand(program, engine)
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    program.parse(["node", "octopus", "status", state.requirementId, "--json"])
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    const summary = JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0]))
    expect(summary).toMatchObject({
      requirementId: state.requirementId,
      requirementName: state.requirementName,
      projectId: state.projectId,
    })

    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it.each(["NaN", "0", "1.5", "Infinity"])("workflow run 拒绝非法并发数 %s", async (value) => {
    const engine = createEngine()
    const state = seedRequirement(engine, "并发参数测试")
    const runWorkflowSpy = vi.spyOn(engine, "runWorkflow")
    const program = new Command()
    buildWorkflowCommands(program, engine)
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await program.parseAsync([
      "node",
      "octopus",
      "workflow",
      "run",
      state.requirementId,
      "--max-parallel",
      value,
    ])

    expect(runWorkflowSpy).not.toHaveBeenCalled()
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("--max-parallel 必须是正整数"))
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
    runWorkflowSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("phase advance 应正确前进阶段", () => {
    const engine = createEngine()
    const state = seedRequirement(engine, "阶段测试需求")

    const tasks = engine.getTasks(state.requirementId, { phase: state.currentPhase })
    for (const task of tasks) {
      if (task.status !== "COMPLETED") {
        engine.completeTask(state.requirementId, task.id)
      }
    }

    const program = new Command()
    buildPhaseCommands(program, engine)

    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    program.parse(["node", "octopus", "phase", "advance", state.requirementId])

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(consoleLogSpy).toHaveBeenCalled()

    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("task export/import 应通过文件跨需求合并任务进度", () => {
    const engine = createEngine()
    const source = seedRequirement(engine, "导出源需求")
    const target = seedRequirement(engine, "导入目标需求")
    const sourceTask = engine.getTasks(source.requirementId)[0]!
    engine.setTaskStatus(source.requirementId, sourceTask.id, TaskStatus.COMPLETED)
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
      source.requirementId,
      "--output",
      exportPath,
      "--json",
    ])

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(existsSync(exportPath)).toBe(true)
    expect(JSON.parse(readFileSync(exportPath, "utf-8"))).toMatchObject({
      format: "octopus.tasks",
      version: 1,
      sourceRequirement: {
        projectId: source.projectId,
        requirementId: source.requirementId,
        requirementName: source.requirementName,
      },
    })

    const importProgram = new Command()
    buildTaskCommands(importProgram, engine)
    importProgram.parse([
      "node",
      "octopus",
      "task",
      "import",
      exportPath,
      target.requirementId,
      "--json",
    ])

    const imported = engine.getTasks(target.requirementId).find((task) => task.stageId === sourceTask.stageId)!
    expect(imported.status).toBe(TaskStatus.COMPLETED)
    const result = JSON.parse(consoleLogSpy.mock.calls.at(-1)?.[0])
    expect(result).toMatchObject({
      requirementId: target.requirementId,
      projectId: target.projectId,
      updated: 1,
    })

    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("task export 默认拒绝覆盖，--force 允许覆盖", () => {
    const engine = createEngine()
    const state = seedRequirement(engine, "覆盖测试需求")
    const exportPath = `${TEST_STORE_DIR}/existing.json`
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const firstProgram = new Command()
    buildTaskCommands(firstProgram, engine)
    firstProgram.parse([
      "node",
      "octopus",
      "task",
      "export",
      state.requirementId,
      "-o",
      exportPath,
    ])

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit")
    })
    const secondProgram = new Command()
    buildTaskCommands(secondProgram, engine)
    expect(() => {
      secondProgram.parse([
        "node",
        "octopus",
        "task",
        "export",
        state.requirementId,
        "-o",
        exportPath,
      ])
    }).toThrow("process.exit")
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("导出文件已存在"))
    exitSpy.mockRestore()

    const forceProgram = new Command()
    buildTaskCommands(forceProgram, engine)
    forceProgram.parse([
      "node",
      "octopus",
      "task",
      "export",
      state.requirementId,
      "-o",
      exportPath,
      "--force",
    ])
    expect(existsSync(exportPath)).toBe(true)

    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("task import 拒绝非法 JSON 且不修改需求", () => {
    const engine = createEngine()
    const state = seedRequirement(engine, "非法导入测试需求")
    const importPath = `${TEST_STORE_DIR}/invalid.json`
    writeFileSync(importPath, "{ invalid", "utf-8")
    const before = engine.getState(state.requirementId)
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit")
    })

    const program = new Command()
    buildTaskCommands(program, engine)
    expect(() => {
      program.parse([
        "node",
        "octopus",
        "task",
        "import",
        importPath,
        state.requirementId,
      ])
    }).toThrow("process.exit")

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("导入任务失败"))
    expect(engine.getState(state.requirementId)).toEqual(before)

    consoleErrorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it("node create 创建可立即使用的 AI 文档节点", () => {
    const engine = createEngine()
    const projectRoot = mkdtempSync(join(tmpdir(), "octopus-cli-node-"))
    temporaryProjectRoots.push(projectRoot)
    const state = seedRequirement(engine, "节点创建测试", undefined, projectRoot)
    const program = new Command()
    buildNodeCommands(program, engine)
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    program.parse([
      "node",
      "octopus",
      "node",
      "create",
      "generate-project-report",
      "Generate Documentation",
      state.requirementId,
      "--role",
      "AI",
      "--depends-on",
      "requirements-analysis-and-brd-design",
      "--type",
      "ai",
      "--assistant",
      "DOCUMENT_SYNC",
      "--input",
      "Generate complete technical documentation from the project source code",
      "--output",
      "documentation.md",
      "--if-exists",
      "extend",
      "--json",
    ])

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    const definition = loadWorkflowDefinition(projectRoot)
    const internalId = definition.nodeIdMapping["generate-project-report"]
    const created = engine.getState(state.requirementId).steps.find((step) => step.id === internalId)
    expect(created?.responsibleRole).toBe("AI")
    expect(created?.actions).toEqual([expect.objectContaining({
      type: "ai",
      outputFile: "documentation.md",
      ifExists: "extend",
    })])
    expect(existsSync(`${projectRoot}/workflow/nodes/generate-project-report`)).toBe(true)
    const workflowYaml = readFileSync(`${projectRoot}/workflow.yaml`, "utf8")
    expect(workflowYaml).toContain("generate-project-report")
    expect(workflowYaml).not.toContain("  - id:")

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
