/**
 * `octopus task` —— 任务管理命令。
 *
 * 子命令:
 *   list [phase] [projectId]       — 列出任务
 *   complete <taskId> [projectId]  — 完成任务
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { Phase } from "@octopus/core/phase.js"
import { TaskStatus } from "@octopus/core/task.js"

export function buildTaskCommands(program: Command, engine: WorkflowEngine): void {
  const taskCmd = program
    .command("task")
    .description("任务管理")

  // ── task list ──
  taskCmd
    .command("list")
    .description("列出任务（可按阶段过滤）")
    .argument("[phase]", "阶段名称（可选）")
    .argument("[projectId]", "项目 ID")
    .option("--all", "列出所有阶段的任务")
    .action((phaseName?: string, projectId?: string, options?: { all?: boolean }) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      const state = engine.getState(pid)
      let tasks = state.tasks

      if (phaseName) {
        const phase = Object.values(Phase).find((p) => p.toLowerCase() === phaseName.toLowerCase())
        if (phase) {
          tasks = tasks.filter((t) => t.phase === phase)
        } else {
          console.error(`❌ 未知阶段: ${phaseName}`)
          return
        }
      } else if (!options?.all) {
        tasks = tasks.filter((t) => t.phase === state.currentPhase)
      }

      if (tasks.length === 0) {
        console.log("📋 没有找到任务。")
        return
      }

      console.log(`\n📋 任务列表 (${tasks.length} 项):`)
      for (const task of tasks) {
        const statusIcon: Record<string, string> = {
          PENDING: "⬜",
          IN_PROGRESS: "🔄",
          COMPLETED: "✅",
          BLOCKED: "🚫",
          SKIPPED: "⏭",
        }
        const icon = statusIcon[task.status] ?? "⬜"
        const phaseLabel = task.phase
        console.log(`   ${icon} [${phaseLabel}] ${task.id}`)
        console.log(`       ${task.title}`)
        console.log(`       负责人: ${task.responsibleRole}  状态: ${task.status}`)
        if (task.assignedTo) console.log(`       指派: ${task.assignedTo}`)
        console.log()
      }
    })

  // ── task complete ──
  taskCmd
    .command("complete")
    .description("完成任务")
    .argument("<taskId>", "任务 ID")
    .argument("[projectId]", "项目 ID")
    .action((taskId: string, projectId?: string) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      try {
        const state = engine.completeTask(pid, taskId)
        const task = state.tasks.find((t) => t.id === taskId)
        if (task) {
          console.log(`✅ 任务已完成: ${task.title}`)
        }
      } catch (err) {
        console.error(`❌ ${(err as Error).message}`)
      }
    })

  // ── task set-status ──
  taskCmd
    .command("set-status")
    .description("设置任务状态")
    .argument("<taskId>", "任务 ID")
    .argument("<status>", "新状态 (PENDING|IN_PROGRESS|COMPLETED|BLOCKED|SKIPPED)")
    .argument("[projectId]", "项目 ID")
    .action((taskId: string, status: string, projectId?: string) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      const taskStatus = Object.values(TaskStatus).find((s) => s === status)
      if (!taskStatus) {
        console.error(`❌ 无效状态: ${status}`)
        return
      }

      try {
        engine.setTaskStatus(pid, taskId, taskStatus)
        console.log(`✅ 任务状态已更新: ${taskId} → ${taskStatus}`)
      } catch (err) {
        console.error(`❌ ${(err as Error).message}`)
      }
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
