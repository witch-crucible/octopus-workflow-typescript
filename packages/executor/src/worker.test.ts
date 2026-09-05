import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Phase } from "@octopus/core/phase.js"
import { Role } from "@octopus/core/role.js"
import { TaskStatus } from "@octopus/core/task.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { TaskId } from "@octopus/core/branded-ids.js"
import { AIAssistantType } from "@octopus/core/agent.js"
import type { StepRuntime } from "@octopus/core/step.js"
import type { PersistenceStore } from "@octopus/context/index.js"
import { createTestPersistenceStore } from "@octopus/context/testing.js"
import { DEFAULT_CONFIG } from "@octopus/context/config.js"
import { emptyPluginHost } from "@octopus/plugin/index.js"
import { executeAction, markInterruptedRun, parseArgs, type ActionContext } from "./worker.js"

const temporaryDirectories: string[] = []
const stores: PersistenceStore[] = []

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octopus-worker-"))
  temporaryDirectories.push(directory)
  return directory
}

function createReviewerExecutable(directory: string, name: string, output?: string): string {
  const executable = join(directory, `${name}.mjs`)
  writeFileSync(executable, [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs"',
    output === undefined
      ? `writeFileSync(2, ${JSON.stringify(`${name} failed`)})`
      : `writeFileSync(1, ${JSON.stringify(output)})`,
    output === undefined ? "process.exitCode = 3" : "",
  ].filter(Boolean).join("\n"))
  chmodSync(executable, 0o755)
  return executable
}

function createTestStep(phase: Phase = Phase.TESTING): StepRuntime {
  const now = new Date().toISOString()
  return {
    id: "step_test",
    taskId: TaskId("task_test"),
    phase,
    name: "测试步骤",
    description: "测试步骤描述",
    responsibleRole: Role.QA,
    status: TaskStatus.IN_PROGRESS,
    dependsOn: [],
    artifactIds: [],
    createdAt: now,
    updatedAt: now,
  }
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("parseArgs", () => {
  it("支持 --key value 与 --key=value 混用", () => {
    const args = parseArgs([
      "--store-dir",
      "/tmp/store",
      "--requirement-id=proj_x",
      "--run-id",
      "run_y",
    ])

    expect(args).toEqual({ storeDir: "/tmp/store", requirementId: "proj_x", runId: "run_y" })
  })

  it("支持引号包裹的带空格值", () => {
    const args = parseArgs([
      "--store-dir",
      '"/tmp/my store"',
      "--requirement-id",
      "'proj x'",
      "--run-id",
      "run_y",
    ])

    expect(args.storeDir).toBe("/tmp/my store")
    expect(args.requirementId).toBe("proj x")
    expect(args.runId).toBe("run_y")
  })

  it("支持 --flag 布尔参数且不吞并后续位置", () => {
    const args = parseArgs([
      "--store-dir",
      "/tmp/store",
      "--verbose",
      "--requirement-id",
      "proj_x",
      "--run-id",
      "run_y",
    ])

    expect(args).toEqual({ storeDir: "/tmp/store", requirementId: "proj_x", runId: "run_y" })
  })

  it("缺失必需参数时抛出清晰错误", () => {
    expect(() => parseArgs(["--store-dir", "/tmp/store", "--run-id", "run_y"])).toThrow(
      "--requirement-id",
    )
    expect(() => parseArgs(["--run-id", "run_y"])).toThrow("--store-dir")
    expect(() => parseArgs([])).toThrow("--store-dir")
  })
})

describe("heinrich action 阶段归属", () => {
  it("触发计数与观测使用 step.phase 而非 state.currentPhase", async () => {
    const storeDir = createTemporaryDirectory()
    const { store: stateStore } = await createTestPersistenceStore(storeDir)
    stores.push(stateStore)
    const project = await stateStore.createProject("测试项目")
    const requirementId = (
      await stateStore.createRequirement(project.projectId, "测试需求", "", "/tmp")
    ).requirementId
    const step = createTestStep(Phase.TESTING)
    await stateStore.update(requirementId, (current) => {
      current.steps.push(step)
      current.currentPhase = Phase.INTENTION
      return current
    })

    const context: ActionContext = {
      args: { storeDir, requirementId, runId: "run_test" },
      nodePath: "/tmp",
      stateStore,
      stateRequirementId: requirementId,
      config: DEFAULT_CONFIG,
      projectRoot: "/tmp",
      fallbackAIInput: "fallback",
      stdoutPath: join(storeDir, "stdout.log"),
      stderrPath: join(storeDir, "stderr.log"),
      pluginHost: emptyPluginHost(),
      step,
      isCancelled: () => false,
      assignChild: () => {},
    }

    const result = await executeAction(
      { type: "heinrich", delta: 3, level: HeinrichLevel.MINOR },
      context,
    )

    expect(result).toEqual({})
    const state = await stateStore.load(requirementId)
    expect(state.heinrich.triggerCounts[Phase.TESTING]).toBe(3)
    expect(state.heinrich.triggerCounts[Phase.INTENTION]).toBe(0)
    expect(state.heinrich.observations).toHaveLength(1)
    expect(state.heinrich.observations[0]?.phase).toBe(Phase.TESTING)
    expect(state.heinrich.observations[0]?.level).toBe(HeinrichLevel.MINOR)
  })
})

describe("AI 交叉代码评审 action", () => {
  function createCrossReviewContext(
    storeDir: string,
    nodePath: string,
    paths: { ocrPath: string; commandCodePath: string; codexPath: string },
  ): ActionContext {
    const stateStore = createStateStore({ storeDir })
    const project = stateStore.createProject("交叉评审项目")
    const requirementId = stateStore.createRequirement(
      project.projectId,
      "交叉评审需求",
      "",
      nodePath,
    ).requirementId
    return {
      args: { storeDir, requirementId, runId: "run_cross_review" },
      nodePath,
      stateStore,
      stateRequirementId: requirementId,
      config: {
        ...DEFAULT_CONFIG,
        ai: {
          ...DEFAULT_CONFIG.ai,
          ...paths,
          retries: 0,
          defaultTimeout: 2_000,
        },
      },
      projectRoot: nodePath,
      fallbackAIInput: "审查当前 Git 变更",
      stdoutPath: join(storeDir, "stdout.log"),
      stderrPath: join(storeDir, "stderr.log"),
      pluginHost: emptyPluginHost(),
      step: createTestStep(Phase.RELEASE),
      isCancelled: () => false,
      assignChild: () => {},
    }
  }

  it("三个 reviewer 独立落盘并生成汇总报告，两个成功即可通过", async () => {
    const storeDir = createTemporaryDirectory()
    const nodePath = createTemporaryDirectory()
    const paths = {
      ocrPath: createReviewerExecutable(storeDir, "ocr", "OCR finding"),
      commandCodePath: createReviewerExecutable(storeDir, "commandcode", "Command Code finding"),
      codexPath: createReviewerExecutable(storeDir, "codex"),
    }
    const context = createCrossReviewContext(storeDir, nodePath, paths)

    const result = await executeAction({
      type: "ai",
      assistant: AIAssistantType.CODE_REVIEW,
      reviewers: ["ocr", "commandcode", "codex"],
      minimumSuccessfulReviewers: 2,
      outputFile: "cross-review.md",
      reviewOutputDir: "reviews",
    }, context)

    const reviewOutputDir = `reviews/${context.stateRequirementId}`
    expect(result).toMatchObject({
      successCount: 2,
      reviewerCount: 3,
      outputFile: "cross-review.md",
      reviewOutputDir,
    })
    expect(readFileSync(join(nodePath, reviewOutputDir, "ocr.md"), "utf8")).toContain("OCR finding")
    expect(readFileSync(join(nodePath, reviewOutputDir, "commandcode.md"), "utf8")).toContain("Command Code finding")
    expect(readFileSync(join(nodePath, reviewOutputDir, "codex.md"), "utf8")).toContain("codex failed")
    const aggregate = readFileSync(join(nodePath, "cross-review.md"), "utf8")
    expect(aggregate).toContain("OCR finding")
    expect(aggregate).toContain("Command Code finding")
    expect(aggregate).toContain("codex failed")
  })

  it("成功 reviewer 少于门槛时保留诊断报告并阻止节点通过", async () => {
    const storeDir = createTemporaryDirectory()
    const nodePath = createTemporaryDirectory()
    const paths = {
      ocrPath: createReviewerExecutable(storeDir, "ocr", "OCR only success"),
      commandCodePath: createReviewerExecutable(storeDir, "commandcode"),
      codexPath: createReviewerExecutable(storeDir, "codex"),
    }
    const context = createCrossReviewContext(storeDir, nodePath, paths)
    const action = {
      type: "ai" as const,
      assistant: AIAssistantType.CODE_REVIEW,
      reviewers: ["ocr", "commandcode", "codex"] as const,
      minimumSuccessfulReviewers: 2,
      outputFile: "cross-review.md",
      reviewOutputDir: "reviews",
    }

    await expect(executeAction(action, context)).rejects.toThrow("至少需要 2 个成功，实际 1 个")
    expect(readFileSync(join(nodePath, "cross-review.md"), "utf8")).toContain("OCR only success")
    expect(readFileSync(join(nodePath, `reviews/${context.stateRequirementId}/commandcode.md`), "utf8")).toContain("commandcode failed")
  })
})

describe("markInterruptedRun", () => {
  it("把 RUNNING 运行置为 INTERRUPTED 并把步骤置 BLOCKED", async () => {
    const storeDir = createTemporaryDirectory()
    const { store } = await createTestPersistenceStore(storeDir)
    stores.push(store)
    const executionStore = store
    const stateStore = store
    const project = await stateStore.createProject("测试项目")
    const requirementId = (
      await stateStore.createRequirement(project.projectId, "测试需求", "", "/tmp")
    ).requirementId
    const run = await executionStore.createRun({
      id: "run_interrupt",
      requirementId,
      nodeId: "step_test",
      forced: false,
      stdoutPath: join(storeDir, "stdout.log"),
      stderrPath: join(storeDir, "stderr.log"),
    })
    await executionStore.transitionRun(run.id, ["QUEUED"], { status: "RUNNING" })
    await stateStore.update(requirementId, (current) => {
      current.steps.push(createTestStep())
      return current
    })

    const originalExitCode = process.exitCode
    try {
      await markInterruptedRun(
        executionStore,
        stateStore,
        { storeDir, requirementId, runId: run.id },
        "step_test",
      )
    } finally {
      process.exitCode = originalExitCode
    }

    const interrupted = await executionStore.getRun(run.id)
    expect(interrupted?.status).toBe("INTERRUPTED")
    expect(interrupted?.error).toBe("运行被外部信号中断")
    expect(
      (await stateStore.load(requirementId)).steps.find((candidate) => candidate.id === "step_test")
        ?.status,
    ).toBe(TaskStatus.BLOCKED)
    const events = await executionStore.eventsAfter(requirementId, 0)
    expect(
      events.some(
        (event) => event.type === "RUN_FAILED" && event.payload["status"] === "INTERRUPTED",
      ),
    ).toBe(true)
  })

  it("run 已是 CANCELED 时直接返回不覆盖", async () => {
    const storeDir = createTemporaryDirectory()
    const { store } = await createTestPersistenceStore(storeDir)
    stores.push(store)
    const executionStore = store
    const stateStore = store
    const project = await stateStore.createProject("测试项目")
    const requirementId = (
      await stateStore.createRequirement(project.projectId, "测试需求", "", "/tmp")
    ).requirementId
    const run = await executionStore.createRun({
      id: "run_canceled",
      requirementId,
      nodeId: "step_test",
      forced: false,
      stdoutPath: join(storeDir, "stdout.log"),
      stderrPath: join(storeDir, "stderr.log"),
    })
    await executionStore.transitionRun(run.id, ["QUEUED"], {
      status: "CANCELED",
      error: "运行已取消",
    })

    await markInterruptedRun(
      executionStore,
      stateStore,
      { storeDir, requirementId, runId: run.id },
      "step_test",
    )

    const canceled = await executionStore.getRun(run.id)
    expect(canceled?.status).toBe("CANCELED")
    expect(canceled?.error).toBe("运行已取消")
  })
})
