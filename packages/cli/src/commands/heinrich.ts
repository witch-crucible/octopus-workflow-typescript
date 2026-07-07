/**
 * `octopus heinrich` —— 海因里希三角管理命令。
 *
 * 子命令:
 *   show [projectId]                   — 展示海因里希三角
 *   log <level> <desc> [projectId]     — 记录风险观测
 *   resolve <obsId> [projectId]        — 解决观测
 *   assess [projectId]                 — 质量评估
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { HeinrichLevel, QualityVerdict } from "@octopus/core/risk.js"
import { Phase } from "@octopus/core/phase.js"

export function buildHeinrichCommands(program: Command, engine: WorkflowEngine): void {
  const heinrichCmd = program
    .command("heinrich")
    .description("海因里希三角管理")

  // ── heinrich show ──
  heinrichCmd
    .command("show")
    .description("展示海因里希三角")
    .argument("[projectId]", "项目 ID")
    .option("--observations", "同时显示观测记录")
    .action((projectId?: string, options?: { observations?: boolean }) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      const record = engine.getHeinrichRecord(pid)

      console.log("\n🔺 海因里希三角 (Heinrich's Triangle)")
      console.log(`   重大缺陷 (MAJOR):   ${record.majorDefects}`)
      console.log(`   轻微缺陷 (MINOR):   ${record.minorDefects}`)
      console.log(`   未遂/轻微 (TRIVIAL): ${record.trivialDefects}`)

      // 显示 1:29:300 比例
      if (record.majorDefects > 0) {
        const idealMinor = record.majorDefects * 29
        const idealTrivial = record.majorDefects * 300
        console.log(`\n   理想比例 1:29:300 对照:`)
        console.log(`   预期轻微缺陷: ${idealMinor}  (实际: ${record.minorDefects})`)
        console.log(`   预期未遂事件: ${idealTrivial}  (实际: ${record.trivialDefects})`)
      }

      if (options?.observations && record.observations.length > 0) {
        console.log("\n   观测记录:")
        for (const obs of record.observations) {
          const resolved = obs.resolvedAt ? "✅ 已解决" : "⬜ 待解决"
          console.log(`   [${obs.level}] ${obs.description} (${obs.phase}) ${resolved}`)
        }
      }
      console.log()
    })

  // ── heinrich log ──
  heinrichCmd
    .command("log")
    .description("记录风险观测")
    .argument("<level>", "风险等级 (MAJOR|MINOR|TRIVIAL)")
    .argument("<description>", "描述")
    .argument("[phase]", "所属阶段（默认为当前阶段）")
    .argument("[projectId]", "项目 ID")
    .action((level: string, description: string, phaseName?: string, projectId?: string) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      const heinrichLevel = Object.values(HeinrichLevel).find((l) => l === level.toUpperCase())
      if (!heinrichLevel) {
        console.error(`❌ 无效等级: ${level}。可选: MAJOR, MINOR, TRIVIAL`)
        return
      }

      const state = engine.getState(pid)
      const phase = phaseName
        ? (Object.values(Phase).find((p) => p.toLowerCase() === phaseName.toLowerCase()) ?? state.currentPhase)
        : state.currentPhase

      engine.logObservation(pid, phase, heinrichLevel, description)
      console.log(`✅ 已记录 ${heinrichLevel} 风险: ${description}`)
    })

  // ── heinrich resolve ──
  heinrichCmd
    .command("resolve")
    .description("解决风险观测")
    .argument("<obsId>", "观测 ID")
    .argument("[projectId]", "项目 ID")
    .action((obsId: string, projectId?: string) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      try {
        engine.resolveObservation(pid, obsId)
        console.log(`✅ 观测已解决: ${obsId}`)
      } catch (err) {
        console.error(`❌ ${(err as Error).message}`)
      }
    })

  // ── heinrich assess ──
  heinrichCmd
    .command("assess")
    .description("质量评估")
    .argument("[projectId]", "项目 ID")
    .action((projectId?: string) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      const assessment = engine.assessQuality(pid)

      const verdictLabels: Record<string, string> = {
        HEALTHY: "✅ 健康 — 比例接近 1:29:300",
        UNDER_REPORTING: "⚠️  漏报 — 轻微/未遂记录不足，可能存在隐性问题",
        OVER_REPORTING: "⚠️  过报 — 轻微/未遂记录过多",
        INSUFFICIENT_DATA: "ℹ️  数据不足 — 无重大缺陷记录",
      }

      console.log("\n📊 质量评估 (Heinrich's Triangle)")
      console.log(`   预期轻微: ${assessment.expectedMinor.toFixed(1)}  实际: ${assessment.actualMinor}`)
      console.log(`   预期未遂: ${assessment.expectedTrivial.toFixed(1)}  实际: ${assessment.actualTrivial}`)
      console.log(`   轻微比例: ${(assessment.minorRatio * 100).toFixed(1)}%`)
      console.log(`   未遂比例: ${(assessment.trivialRatio * 100).toFixed(1)}%`)
      console.log(`\n   结论: ${verdictLabels[assessment.verdict] ?? assessment.verdict}`)
      console.log()
    })
}

function resolveProjectId(engine: WorkflowEngine, projectId?: string): string | null {
  if (projectId) return projectId
  const projects = engine["store"].listProjects()
  if (projects.length === 0) {
    console.log("⚠️  没有找到项目。使用 `octopus init <name>` 创建新项目。")
    return null
  }
  return projects[0] ?? null
}
