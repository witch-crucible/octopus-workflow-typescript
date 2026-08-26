/**
 * `octopus heinrich` —— 海因里希三角管理命令。
 *
 * 子命令:
 *   show [requirementId]                   — 展示海因里希三角
 *   log <level> <desc> [requirementId]     — 记录风险观测
 *   resolve <obsId> [requirementId]        — 解决观测
 *   assess [requirementId]                 — 质量评估
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { resolveRequirementId } from "../resolve-requirement.js"
import { HeinrichLevel, QualityVerdict } from "@octopus/core/risk.js"
import { Phase } from "@octopus/core/phase.js"

export function buildHeinrichCommands(program: Command, engine: WorkflowEngine): void {
  const heinrichCmd = program.command("heinrich").description("海因里希三角管理")

  // ── heinrich show ──
  heinrichCmd
    .command("show")
    .description("展示海因里希三角")
    .argument("[requirementId]", "需求 ID")
    .option("--observations", "同时显示观测记录")
    .option("--json", "以 JSON 格式输出")
    .action(
      async (requirementId?: string, options?: { observations?: boolean; json?: boolean }) => {
        try {
          const pid = await resolveRequirementId(engine, requirementId)
          if (!pid) return

          const record = await engine.getHeinrichRecord(pid)

          if (options?.json) {
            console.log(
              JSON.stringify(
                {
                  requirementId: pid,
                  majorDefects: record.majorDefects,
                  minorDefects: record.minorDefects,
                  trivialDefects: record.trivialDefects,
                  observations: options.observations ? record.observations : undefined,
                },
                null,
                2,
              ),
            )
            return
          }

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
        } catch (err) {
          console.error(`❌ 获取海因里希三角失败: ${(err as Error).message}`)
          process.exit(1)
        }
      },
    )

  // ── heinrich log ──
  heinrichCmd
    .command("log")
    .description("记录风险观测")
    .argument("<level>", "风险等级 (MAJOR|MINOR|TRIVIAL)")
    .argument("<description>", "描述")
    .argument("[phase]", "所属阶段（默认为当前阶段）")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action(
      async (
        level: string,
        description: string,
        phaseName?: string,
        requirementId?: string,
        options?: { json?: boolean },
      ) => {
        try {
          const pid = await resolveRequirementId(engine, requirementId)
          if (!pid) return

          const heinrichLevel = Object.values(HeinrichLevel).find((l) => l === level.toUpperCase())
          if (!heinrichLevel) {
            console.error(`❌ 无效等级: ${level}。可选: MAJOR, MINOR, TRIVIAL`)
            process.exit(1)
            return
          }

          const state = await engine.getState(pid)
          const phase = phaseName
            ? (Object.values(Phase).find((p) => p.toLowerCase() === phaseName.toLowerCase()) ??
              state.currentPhase)
            : state.currentPhase

          const updated = await engine.logObservation(pid, phase, heinrichLevel, description)

          if (options?.json) {
            console.log(
              JSON.stringify(
                {
                  requirementId: pid,
                  level: heinrichLevel,
                  description,
                  phase,
                  majorDefects: updated.heinrich.majorDefects,
                  minorDefects: updated.heinrich.minorDefects,
                  trivialDefects: updated.heinrich.trivialDefects,
                },
                null,
                2,
              ),
            )
            return
          }

          console.log(`✅ 已记录 ${heinrichLevel} 风险: ${description}`)
        } catch (err) {
          console.error(`❌ 记录风险观测失败: ${(err as Error).message}`)
          process.exit(1)
        }
      },
    )

  // ── heinrich resolve ──
  heinrichCmd
    .command("resolve")
    .description("解决风险观测")
    .argument("<obsId>", "观测 ID")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (obsId: string, requirementId?: string, options?: { json?: boolean }) => {
      try {
        const pid = await resolveRequirementId(engine, requirementId)
        if (!pid) return

        await engine.resolveObservation(pid, obsId)

        if (options?.json) {
          console.log(
            JSON.stringify(
              {
                requirementId: pid,
                obsId,
                resolved: true,
              },
              null,
              2,
            ),
          )
          return
        }

        console.log(`✅ 观测已解决: ${obsId}`)
      } catch (err) {
        console.error(`❌ ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── heinrich marker ──
  heinrichCmd
    .command("marker")
    .description("记录海因里希条数标记")
    .argument("[phase]", "所属阶段（默认当前阶段）")
    .argument("[requirementId]", "需求 ID")
    .option("--description <text>", "标记描述")
    .option("--json", "以 JSON 格式输出")
    .action(
      async (
        phaseName?: string,
        requirementId?: string,
        options?: { description?: string; json?: boolean },
      ) => {
        try {
          const pid = await resolveRequirementId(engine, requirementId)
          if (!pid) return

          const state = await engine.getState(pid)
          const phase = phaseName
            ? (Object.values(Phase).find((p) => p.toLowerCase() === phaseName.toLowerCase()) ??
              state.currentPhase)
            : state.currentPhase

          const updated = await engine.logHeinrichMarker(pid, phase, options?.description)

          if (options?.json) {
            console.log(
              JSON.stringify(
                {
                  requirementId: pid,
                  phase,
                  triggerCount: updated.heinrich.triggerCounts[phase],
                  description: options?.description,
                },
                null,
                2,
              ),
            )
            return
          }

          console.log(
            `✅ 已记录 Heinrich marker: ${phase} (triggerCount=${updated.heinrich.triggerCounts[phase]})`,
          )
        } catch (err) {
          console.error(`❌ 记录 marker 失败: ${(err as Error).message}`)
          process.exit(1)
        }
      },
    )

  // ── heinrich assess ──
  heinrichCmd
    .command("assess")
    .description("质量评估")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (requirementId?: string, options?: { json?: boolean }) => {
      try {
        const pid = await resolveRequirementId(engine, requirementId)
        if (!pid) return

        const assessment = await engine.assessQuality(pid)

        if (options?.json) {
          console.log(
            JSON.stringify(
              {
                requirementId: pid,
                expectedMinor: assessment.expectedMinor,
                expectedTrivial: assessment.expectedTrivial,
                actualMinor: assessment.actualMinor,
                actualTrivial: assessment.actualTrivial,
                minorRatio: assessment.minorRatio,
                trivialRatio: assessment.trivialRatio,
                verdict: assessment.verdict,
              },
              null,
              2,
            ),
          )
          return
        }

        const verdictLabels: Record<string, string> = {
          HEALTHY: "✅ 健康 — 比例接近 1:29:300",
          UNDER_REPORTING: "⚠️  漏报 — 轻微/未遂记录不足，可能存在隐性问题",
          OVER_REPORTING: "⚠️  过报 — 轻微/未遂记录过多",
          INSUFFICIENT_DATA: "ℹ️  数据不足 — 无重大缺陷记录",
        }

        console.log("\n📊 质量评估 (Heinrich's Triangle)")
        console.log(
          `   预期轻微: ${assessment.expectedMinor.toFixed(1)}  实际: ${assessment.actualMinor}`,
        )
        console.log(
          `   预期未遂: ${assessment.expectedTrivial.toFixed(1)}  实际: ${assessment.actualTrivial}`,
        )
        console.log(`   轻微比例: ${(assessment.minorRatio * 100).toFixed(1)}%`)
        console.log(`   未遂比例: ${(assessment.trivialRatio * 100).toFixed(1)}%`)
        console.log(`\n   结论: ${verdictLabels[assessment.verdict] ?? assessment.verdict}`)
        console.log()
      } catch (err) {
        console.error(`❌ 质量评估失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })
}
