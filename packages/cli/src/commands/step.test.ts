import { afterEach, describe, expect, it, vi } from "vitest"
import { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { buildStepCommands } from "./step.js"

const originalExitCode = process.exitCode

afterEach(() => {
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
})

describe("step run", () => {
  it("任一 capability 失败时设置非零退出码", async () => {
    const engine = {
      getState: () => ({ steps: [{ id: "50.5", capabilityRuns: [] }] }),
      runStepCapabilities: async () => ({
        steps: [{
          id: "50.5",
          capabilityRuns: [{ kind: "ai", ref: "CODE_REVIEW", ok: false, summary: "1/3" }],
        }],
      }),
    } as unknown as WorkflowEngine
    const program = new Command()
    program.exitOverride()
    buildStepCommands(program, engine)
    vi.spyOn(console, "log").mockImplementation(() => {})

    await program.parseAsync(["node", "octopus", "step", "run", "50.5", "req_test"])

    expect(process.exitCode).toBe(1)
  })

  it("只根据本次新增的交叉评审结果设置退出码", async () => {
    const historicalRun = { kind: "ai", ref: "CODE_REVIEW", ok: false, summary: "1/3" }
    const successfulRun = { kind: "ai", ref: "CODE_REVIEW", ok: true, summary: "3/3" }
    const engine = {
      getState: () => ({
        steps: [{ id: "50.5", capabilityRuns: [historicalRun] }],
      }),
      runStepCapabilities: async () => ({
        steps: [{ id: "50.5", capabilityRuns: [historicalRun, successfulRun] }],
      }),
    } as unknown as WorkflowEngine
    const program = new Command()
    program.exitOverride()
    buildStepCommands(program, engine)
    vi.spyOn(console, "log").mockImplementation(() => {})

    await program.parseAsync(["node", "octopus", "step", "run", "50.5", "req_test"])

    expect(process.exitCode).toBe(originalExitCode)
  })
})
