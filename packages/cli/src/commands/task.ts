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
import { Role } from "@octopus/core/role.js"
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
    .option("--json", "以 JSON 格式输出")
    .action((phaseName?: string, projectId?: string, options?: { all?: boolean; json?: boolean }) => {
      try {
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
            process.exit(1)
            return
          }
        } else if (!options?.all) {
          tasks = tasks.filter((t) => t.phase === state.currentPhase)
        }

        if (tasks.length === 0) {
          console.log("📋 没有找到任务。")
          return
        }

        if (options?.json) {
          console.log(JSON.stringify({
            projectId: state.projectId,
            currentPhase: state.currentPhase,
            tasks: tasks.map((t) => ({
              id: t.id,
              stageId: t.stageId,
              phase: t.phase,
              title: t.title,
              description: t.description,
              responsibleRole: t.responsibleRole,
              status: t.status,
              artifactIds: t.artifactIds,
              createdAt: t.createdAt,
              completedAt: t.completedAt,
            })),
          }, null, 2))
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
      } catch (err) {
        console.error(`❌ 获取任务列表失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── task complete ──
  taskCmd
    .command("complete")
    .description("完成任务")
    .argument("<taskId>", "任务 ID")
    .argument("[projectId]", "项目 ID")
    .option("--as-role <role>", "以指定角色执行")
    .option("--json", "以 JSON 格式输出")
    .action((taskId: string, projectId?: string, options?: { asRole?: string; json?: boolean }) => {
      try {
        const pid = resolveProjectId(engine, projectId)
        if (!pid) return

        const role = options?.asRole ? (Object.values(Role).find((r) => r.toLowerCase() === options.asRole!.toLowerCase()) as Role | undefined) : undefined
        const state = engine.completeTask(pid, taskId, role)
        const task = state.tasks.find((t) => t.id === taskId)

        if (options?.json) {
          console.log(JSON.stringify({
            projectId: state.projectId,
            taskId,
            title: task?.title,
            status: task?.status,
          }, null, 2))
          return
        }

        if (task) {
          console.log(`✅ 任务已完成: ${task.title}`)
        }
      } catch (err) {
        console.error(`❌ ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── task set-status ──
  taskCmd
    .command("set-status")
    .description("设置任务状态")
    .argument("<taskId>", "任务 ID")
    .argument("<status>", "新状态 (PENDING|IN_PROGRESS|COMPLETED|BLOCKED|SKIPPED)")
    .argument("[projectId]", "项目 ID")
    .option("--json", "以 JSON 格式输出")
    .action((taskId: string, status: string, projectId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveProjectId(engine, projectId)
        if (!pid) return

        const taskStatus = Object.values(TaskStatus).find((s) => s === status)
        if (!taskStatus) {
          console.error(`❌ 无效状态: ${status}`)
          process.exit(1)
          return
        }

        const state = engine.setTaskStatus(pid, taskId, taskStatus)
        const task = state.tasks.find((t) => t.id === taskId)

        if (options?.json) {
          console.log(JSON.stringify({
            projectId: state.projectId,
            taskId,
            status: task?.status,
          }, null, 2))
          return
        }

        console.log(`✅ 任务状态已更新: ${taskId} → ${taskStatus}`)
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
