/**
 * `octopus step` —— 步骤能力（capability）调度命令。
 *
 * 子命令:
 *   run <stageId> [requirementId]  — 分发该步骤声明的 AI / 集成 / Heinrich 能力
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { AIAssistantType } from "@octopus/core/agent.js"
import type { WorkflowState } from "@octopus/core/workflow.js"
import { resolveRequirementId } from "../resolve-requirement.js"

export function buildStepCommands(program: Command, engine: WorkflowEngine): void {
  const stepCmd = program
    .command("step")
    .description("步骤能力调度")

  stepCmd
    .command("run")
    .description("分发步骤声明的 capabilities（AI / 集成 / Heinrich）")
    .argument("<stageId>", "步骤 ID（如 10.6）")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (stageId: string, requirementId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const previousRunCount = engine.getState(pid).steps
          .find((step) => step.id === stageId)?.capabilityRuns?.length ?? 0
        const controller = new AbortController()
        const abort = (): void => controller.abort()
        process.once("SIGINT", abort)
        process.once("SIGTERM", abort)
        let state: WorkflowState
        try {
          state = await engine.runStepCapabilities(pid, stageId, undefined, controller.signal)
        } finally {
          process.removeListener("SIGINT", abort)
          process.removeListener("SIGTERM", abort)
        }
        const step = state.steps.find((s) => s.id === stageId)
        const runs = (step?.capabilityRuns ?? []).slice(previousRunCount)
        if (runs.some((run) =>
          run.kind === "ai" && run.ref === AIAssistantType.CODE_REVIEW && !run.ok
        )) process.exitCode = 1

        if (options?.json) {
          console.log(JSON.stringify({ requirementId: pid, stageId, runs }, null, 2))
          return
        }

        if (runs.length === 0) {
          console.log(`ℹ️  步骤 ${stageId} 没有声明 capabilities。`)
          return
        }

        console.log(`\n⚙️  步骤 ${stageId} 能力分发结果:`)
        for (const run of runs) {
          const icon = run.ok ? "✅" : "⚠️"
          console.log(`   ${icon} [${run.kind}] ${run.ref}${run.summary ? ` — ${run.summary}` : ""}`)
        }
        console.log()
      } catch (err) {
        console.error(`❌ ${(err as Error).message}`)
        process.exit(1)
      }
    })
}
