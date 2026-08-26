/**
 * `octopus status` —— 展示需求状态摘要。
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { resolveRequirementId } from "../resolve-requirement.js"

export function buildStatusCommand(program: Command, engine: WorkflowEngine): void {
  program
    .command("status")
    .description("展示需求状态摘要")
    .argument("[requirementId]", "需求 ID（仅当状态库恰好有一个需求时可省略）")
    .option("--json", "以 JSON 格式输出")
    .action(async (requirementId: string | undefined, options: { json?: boolean }) => {
      try {
        const rid = await resolveRequirementId(engine, requirementId)
        if (!rid) return

        const summary = await engine.getRequirementStatus(rid)

        if (options.json) {
          console.log(JSON.stringify(summary, null, 2))
          return
        }

        const phaseLockLabel: Record<string, string> = {
          LOCKED: "🔒",
          ACTIVE: "▶",
          COMPLETED: "✅",
        }

        console.log(`\n📋 需求: ${summary.requirementName}`)
        console.log(`   需求 ID: ${summary.requirementId}`)
        console.log(`   项目 ID: ${summary.projectId}`)
        console.log(`   当前阶段: ${summary.currentPhase}\n`)

        console.log("   阶段进度:")
        for (const p of summary.phaseProgress) {
          const icon = phaseLockLabel[p.lock] ?? "❓"
          const bar =
            "#".repeat(Math.floor(p.progress.percent / 10)) +
            "░".repeat(10 - Math.floor(p.progress.percent / 10))
          console.log(`   ${icon} ${p.phase.padEnd(16)} [${bar}] ${p.progress.percent}%`)

          const stageProgress = await engine.getStageProgress(rid, p.phase)
          console.log(`      步骤: ${stageProgress.completed}/${stageProgress.total} 已完成`)
        }

        console.log(`\n   任务: ${summary.completedTasks}/${summary.totalTasks} 已完成`)
        console.log(
          `   清单: ${summary.checklistStats.verified}/${summary.checklistStats.total} 已核验`,
        )
        console.log(
          `   海因里希三角: 重大=${summary.heinrichSummary.major} 轻微=${summary.heinrichSummary.minor} 未遂=${summary.heinrichSummary.trivial}`,
        )
        console.log()
      } catch (err) {
        console.error(`❌ 获取状态失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })
}
