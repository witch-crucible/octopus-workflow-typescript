/**
 * `octopus phase` —— 阶段管理命令。
 *
 * 子命令:
 *   list                         — 列出所有阶段状态
 *   advance [requirementId]          — 前进到下一阶段
 *   rollback <phase> [requirementId] — 回退到指定阶段
 *   show <phase> [requirementId]     — 显示阶段详情
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { resolveRequirementId } from "../resolve-requirement.js"
import { Phase, PHASE_ORDER, PhaseLock } from "@octopus/core/phase.js"

export function buildPhaseCommands(program: Command, engine: WorkflowEngine): void {
  const phaseCmd = program
    .command("phase")
    .description("阶段管理")

  // ── phase list ──
  phaseCmd
    .command("list")
    .description("列出所有阶段状态")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action((requirementId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const state = engine.getState(pid)
        if (options?.json) {
          console.log(JSON.stringify({
            projectId: state.projectId,
            requirementId: state.requirementId,
            requirementName: state.requirementName,
            currentPhase: state.currentPhase,
            phases: PHASE_ORDER.map((phase) => ({
              phase,
              lock: state.phaseStatus[phase] ?? PhaseLock.LOCKED,
              progress: engine.getPhaseProgress(state, phase),
            })),
          }, null, 2))
          return
        }

        console.log("\n📊 阶段状态:")
        for (const phase of PHASE_ORDER) {
          const lock = state.phaseStatus[phase] ?? PhaseLock.LOCKED
          const progress = engine.getPhaseProgress(state, phase)
          const active = phase === state.currentPhase ? " ◀ 当前" : ""
          console.log(`   ${lock === PhaseLock.COMPLETED ? "✅" : lock === PhaseLock.ACTIVE ? "▶" : "🔒"} ${phase.padEnd(16)} ${progress.completed}/${progress.total} 任务${active}`)
        }
        console.log()
      } catch (err) {
        console.error(`❌ 获取阶段列表失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── phase advance ──
  phaseCmd
    .command("advance")
    .description("前进到下一阶段")
    .argument("[requirementId]", "需求 ID")
    .option("--skip-ai-gates", "跳过 AI 门控检查")
    .option("--json", "以 JSON 格式输出")
    .action((requirementId?: string, options?: { skipAiGates?: boolean; json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const state = engine.advancePhase(pid, options?.skipAiGates)

        if (options?.json) {
          console.log(JSON.stringify({
            projectId: state.projectId,
            requirementId: state.requirementId,
            requirementName: state.requirementName,
            currentPhase: state.currentPhase,
            taskCount: state.steps.filter((t) => t.phase === state.currentPhase).length,
          }, null, 2))
          return
        }

        console.log(`✅ 已前进到: ${state.currentPhase} (${PhaseLabel(state.currentPhase)})`)
        console.log(`   当前任务数: ${state.steps.filter((t) => t.phase === state.currentPhase).length}`)
      } catch (err) {
        console.error(`❌ ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── phase rollback ──
  phaseCmd
    .command("rollback")
    .description("回退到指定阶段")
    .argument("<phase>", "目标阶段名称")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action((targetPhase: string, requirementId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const phase = Object.values(Phase).find((p) => p.toLowerCase() === targetPhase.toLowerCase())
        if (!phase) {
          console.error(`❌ 未知阶段: ${targetPhase}`)
          console.log(`   可用阶段: ${Object.values(Phase).join(", ")}`)
          process.exit(1)
          return
        }

        const state = engine.rollbackTo(pid, phase)

        if (options?.json) {
          console.log(JSON.stringify({
            projectId: state.projectId,
            requirementId: state.requirementId,
            requirementName: state.requirementName,
            currentPhase: state.currentPhase,
          }, null, 2))
          return
        }

        console.log(`✅ 已回退到: ${state.currentPhase} (${PhaseLabel(state.currentPhase)})`)
      } catch (err) {
        console.error(`❌ ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── phase show ──
  phaseCmd
    .command("show")
    .description("显示阶段详情")
    .argument("<phase>", "阶段名称")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action((phaseName: string, requirementId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const phase = Object.values(Phase).find((p) => p.toLowerCase() === phaseName.toLowerCase())
        if (!phase) {
          console.error(`❌ 未知阶段: ${phaseName}`)
          process.exit(1)
          return
        }

        const state = engine.getState(pid)
        const tasks = engine.getTasks(pid, { phase })
        const progress = engine.getPhaseProgress(state, phase)

        if (options?.json) {
          console.log(JSON.stringify({
            phase,
            label: PhaseLabel(phase),
            lock: state.phaseStatus[phase] ?? PhaseLock.LOCKED,
            progress,
            tasks: tasks.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              responsibleRole: t.responsibleRole,
            })),
          }, null, 2))
          return
        }

        console.log(`\n📌 ${phase} (${PhaseLabel(phase)})`)
        console.log(`   状态: ${state.phaseStatus[phase] ?? PhaseLock.LOCKED}`)
        console.log(`   进度: ${progress.completed}/${progress.total} 任务 (${progress.percent}%)`)

        if (tasks.length > 0) {
          console.log("\n   任务列表:")
          for (const task of tasks) {
            console.log(`   ${task.status === "COMPLETED" ? "✅" : "⬜"} ${task.id} - ${task.title}`)
          }
        }
        console.log()
      } catch (err) {
        console.error(`❌ 获取阶段详情失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })
}


function PhaseLabel(phase: Phase): string {
  const labels: Record<Phase, string> = {
    [Phase.INTENTION]: "意向",
    [Phase.RESEARCH]: "调研",
    [Phase.DESIGN]: "设计",
    [Phase.IMPLEMENTATION]: "实现",
    [Phase.TESTING]: "测试",
    [Phase.UAT]: "UAT",
    [Phase.RELEASE]: "发布",
    [Phase.MAINTENANCE]: "维护",
    [Phase.COMPLETED]: "完结",
  }
  return labels[phase] ?? phase
}
