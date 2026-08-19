/**
 * `octopus task` —— 任务管理命令。
 *
 * 子命令:
 *   list [phase] [requirementId]       — 列出任务
 *   complete <taskId> [requirementId]  — 完成任务
 *   export [requirementId]             — 导出任务 JSON 文件
 *   import <file> [requirementId]      — 合并导入任务 JSON 文件
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { resolveRequirementId } from "../resolve-requirement.js"
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
    .argument("[requirementId]", "需求 ID")
    .option("--all", "列出所有阶段的任务")
    .option("--json", "以 JSON 格式输出")
    .action((phaseName?: string, requirementId?: string, options?: { all?: boolean; json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const state = engine.getState(pid)
        let tasks = engine.getTasks(pid)

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
            requirementId: state.requirementId,
            requirementName: state.requirementName,
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
    .argument("[requirementId]", "需求 ID")
    .option("--as-role <role>", "以指定角色执行")
    .option("--json", "以 JSON 格式输出")
    .action((taskId: string, requirementId?: string, options?: { asRole?: string; json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const role = options?.asRole ? (Object.values(Role).find((r) => r.toLowerCase() === options.asRole!.toLowerCase()) as Role | undefined) : undefined
        const state = engine.completeTask(pid, taskId, role)
        const task = engine.getTasks(pid).find((t) => t.id === taskId)

        if (options?.json) {
          console.log(JSON.stringify({
            projectId: state.projectId,
            requirementId: state.requirementId,
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
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action((taskId: string, status: string, requirementId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const taskStatus = Object.values(TaskStatus).find((s) => s === status)
        if (!taskStatus) {
          console.error(`❌ 无效状态: ${status}`)
          process.exit(1)
          return
        }

        const state = engine.setTaskStatus(pid, taskId, taskStatus)
        const task = engine.getTasks(pid).find((t) => t.id === taskId)

        if (options?.json) {
          console.log(JSON.stringify({
            projectId: state.projectId,
            requirementId: state.requirementId,
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

  // ── task export ──
  taskCmd
    .command("export")
    .description("将需求任务导出为版本化 JSON 文件")
    .argument("[requirementId]", "需求 ID")
    .requiredOption("-o, --output <file>", "导出文件路径")
    .option("--force", "覆盖已存在的文件")
    .option("--json", "以 JSON 格式输出结果")
    .action((requirementId: string | undefined, options: { output: string; force?: boolean; json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const outputPath = resolve(options.output)
        if (!options.force && existsSync(outputPath)) {
          throw new Error(`导出文件已存在: ${outputPath}；如需覆盖请使用 --force`)
        }

        const document = engine.exportTasks(pid)
        writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, {
          encoding: "utf-8",
          flag: options.force ? "w" : "wx",
        })

        if (options.json) {
          console.log(JSON.stringify({
            requirementId: document.sourceRequirement.requirementId,
            projectId: document.sourceRequirement.projectId,
            outputPath,
            taskCount: document.tasks.length,
          }, null, 2))
          return
        }

        console.log(`✅ 已导出 ${document.tasks.length} 个任务: ${outputPath}`)
      } catch (err) {
        console.error(`❌ 导出任务失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── task import ──
  taskCmd
    .command("import")
    .description("从版本化 JSON 文件合并任务进度")
    .argument("<file>", "导入文件路径")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出结果")
    .action((file: string, requirementId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const inputPath = resolve(file)
        const document = JSON.parse(readFileSync(inputPath, "utf-8")) as unknown
        const result = engine.importTasks(pid, document)

        if (options?.json) {
          console.log(JSON.stringify({ ...result, inputPath }, null, 2))
          return
        }

        console.log(`✅ 任务导入完成: 匹配 ${result.matched}，更新 ${result.updated}，未变化 ${result.unchanged}`)
      } catch (err) {
        console.error(`❌ 导入任务失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })
}

