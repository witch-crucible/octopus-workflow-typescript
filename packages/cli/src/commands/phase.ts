/**
 * `octopus phase` —— 阶段管理命令。
 *
 * 子命令:
 *   list                         — 列出所有阶段状态
 *   advance [projectId]          — 前进到下一阶段
 *   rollback <phase> [projectId] — 回退到指定阶段
 *   show <phase> [projectId]     — 显示阶段详情
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { Phase, PHASE_ORDER, PhaseLock } from "@octopus/core/phase.js"

export function buildPhaseCommands(program: Command, engine: WorkflowEngine): void {
  const phaseCmd = program
    .command("phase")
    .description("阶段管理")

  // ── phase list ──
  phaseCmd
    .command("list")
    .description("列出所有阶段状态")
    .argument("[projectId]", "项目 ID")
    .action((projectId?: string) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      const state = engine.getState(pid)
      console.log("\n📊 阶段状态:")
      for (const phase of PHASE_ORDER) {
        const lock = state.phaseStatus[phase] ?? PhaseLock.LOCKED
        const progress = engine.getPhaseProgress(state, phase)
        const active = phase === state.currentPhase ? " ◀ 当前" : ""
        console.log(`   ${lock === PhaseLock.COMPLETED ? "✅" : lock === PhaseLock.ACTIVE ? "▶" : "🔒"} ${phase.padEnd(16)} ${progress.completed}/${progress.total} 任务${active}`)
      }
      console.log()
    })

  // ── phase advance ──
  phaseCmd
    .command("advance")
    .description("前进到下一阶段")
    .argument("[projectId]", "项目 ID")
    .action((projectId?: string) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      try {
        const state = engine.advancePhase(pid)
        console.log(`✅ 已前进到: ${state.currentPhase} (${PhaseLabel(state.currentPhase)})`)
        console.log(`   当前任务数: ${state.tasks.filter((t) => t.phase === state.currentPhase).length}`)
      } catch (err) {
        console.error(`❌ ${(err as Error).message}`)
      }
    })

  // ── phase rollback ──
  phaseCmd
    .command("rollback")
    .description("回退到指定阶段")
    .argument("<phase>", "目标阶段名称")
    .argument("[projectId]", "项目 ID")
    .action((targetPhase: string, projectId?: string) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      const phase = Object.values(Phase).find((p) => p.toLowerCase() === targetPhase.toLowerCase())
      if (!phase) {
        console.error(`❌ 未知阶段: ${targetPhase}`)
        console.log(`   可用阶段: ${Object.values(Phase).join(", ")}`)
        return
      }

      try {
        const state = engine.rollbackTo(pid, phase)
        console.log(`✅ 已回退到: ${state.currentPhase} (${PhaseLabel(state.currentPhase)})`)
      } catch (err) {
        console.error(`❌ ${(err as Error).message}`)
      }
    })

  // ── phase show ──
  phaseCmd
    .command("show")
    .description("显示阶段详情")
    .argument("<phase>", "阶段名称")
    .argument("[projectId]", "项目 ID")
    .action((phaseName: string, projectId?: string) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      const phase = Object.values(Phase).find((p) => p.toLowerCase() === phaseName.toLowerCase())
      if (!phase) {
        console.error(`❌ 未知阶段: ${phaseName}`)
        return
      }

      const state = engine.getState(pid)
      const tasks = state.tasks.filter((t) => t.phase === phase)
      const progress = engine.getPhaseProgress(state, phase)

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

function PhaseLabel(phase: Phase): string {
  const labels: Record<Phase, string> = {
    [Phase.REQUIREMENTS_ANALYSIS]: "需求分析",
    [Phase.DESIGN]: "设计",
    [Phase.DEVELOPMENT]: "开发",
    [Phase.TESTING]: "测试",
    [Phase.DEPLOYMENT]: "部署",
    [Phase.MAINTENANCE]: "维护",
  }
  return labels[phase] ?? phase
}
