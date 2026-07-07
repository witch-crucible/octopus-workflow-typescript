/**
 * `octopus status` —— 展示项目状态摘要。
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

export function buildStatusCommand(program: Command, engine: WorkflowEngine): void {
  program
    .command("status")
    .description("展示项目状态摘要")
    .argument("[projectId]", "项目 ID（默认加载第一个项目）")
    .option("--json", "以 JSON 格式输出")
    .action((projectId: string | undefined, options: { json?: boolean }) => {
      const projects = engine["store"].listProjects()
      if (projects.length === 0) {
        console.log("⚠️  没有找到项目。使用 `octopus init <name>` 创建新项目。")
        return
      }

      const pid = projectId ?? projects[0]
      if (!pid) {
        console.log("⚠️  没有找到项目。")
        return
      }

      const summary = engine.getProjectStatus(pid)

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2))
        return
      }

      const phaseLockLabel: Record<string, string> = {
        LOCKED: "🔒",
        ACTIVE: "▶",
        COMPLETED: "✅",
      }

      console.log(`\n📋 项目: ${summary.projectName}`)
      console.log(`   ID: ${summary.projectId}`)
      console.log(`   当前阶段: ${summary.currentPhase}\n`)

      console.log("   阶段进度:")
      for (const p of summary.phaseProgress) {
        const icon = phaseLockLabel[p.lock] ?? "❓"
        const bar = "#".repeat(Math.floor(p.progress.percent / 10)) +
          "░".repeat(10 - Math.floor(p.progress.percent / 10))
        console.log(`   ${icon} ${p.phase.padEnd(16)} [${bar}] ${p.progress.percent}%`)
      }

      console.log(`\n   任务: ${summary.completedTasks}/${summary.totalTasks} 已完成`)
      console.log(`   清单: ${summary.checklistStats.verified}/${summary.checklistStats.total} 已核验`)
      console.log(`   海因里希三角: 重大=${summary.heinrichSummary.major} 轻微=${summary.heinrichSummary.minor} 未遂=${summary.heinrichSummary.trivial}`)
      console.log()
    })
}
