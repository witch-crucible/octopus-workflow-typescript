/**
 * `octopus step` —— 步骤能力（capability）调度命令。
 *
 * 子命令:
 *   run <stageId> [projectId]  — 分发该步骤声明的 AI / 集成 / Heinrich 能力
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

export function buildStepCommands(program: Command, engine: WorkflowEngine): void {
  const stepCmd = program
    .command("step")
    .description("步骤能力调度")

  stepCmd
    .command("run")
    .description("分发步骤声明的 capabilities（AI / 集成 / Heinrich）")
    .argument("<stageId>", "步骤 ID（如 10.6）")
    .argument("[projectId]", "项目 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (stageId: string, projectId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveProjectId(engine, projectId)
        if (!pid) return

        const state = await engine.runStepCapabilities(pid, stageId)
        const step = state.steps.find((s) => s.id === stageId)
        const runs = step?.capabilityRuns ?? []

        if (options?.json) {
          console.log(JSON.stringify({ projectId: pid, stageId, runs }, null, 2))
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

function resolveProjectId(engine: WorkflowEngine, projectId?: string): string | null {
  if (projectId) return projectId
  const projects = engine["store"].listProjects()
  if (projects.length === 0) {
    console.error("⚠️  没有找到项目。使用 `octopus init <name>` 创建新项目。")
    process.exit(1)
    return null
  }
  return projects[0] ?? null
}
