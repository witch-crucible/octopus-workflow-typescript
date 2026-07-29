/**
 * `octopus stage` —— 阶段步骤管理命令。
 *
 * 子命令:
 *   list [phase] [projectId]        — 列出阶段步骤
 *   status <stageId> [projectId]    — 查看步骤状态
 *   update <stageId> <status> [projectId] — 更新步骤状态
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { Phase } from "@octopus/core/phase.js"
import { StageStatus, STAGE_STATUS_LABELS } from "@octopus/core/task.js"

export function buildStageCommands(program: Command, engine: WorkflowEngine): void {
  const stageCmd = program
    .command("stage")
    .description("阶段步骤管理")

  // ── stage list ──
  stageCmd
    .command("list")
    .description("列出阶段步骤")
    .argument("[phase]", "阶段名称（默认当前阶段）")
    .argument("[projectId]", "项目 ID")
    .option("--json", "以 JSON 格式输出")
    .action((phaseName?: string, projectId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveProjectId(engine, projectId)
        if (!pid) return

        const state = engine.getState(pid)
        const phase = phaseName
          ? (Object.values(Phase).find((p) => p.toLowerCase() === phaseName.toLowerCase()) ?? state.currentPhase)
          : state.currentPhase

        const stages = engine.getStageInfos(pid, phase)

        if (options?.json) {
          console.log(JSON.stringify({
            projectId: pid,
            phase,
            stages: stages.map((s) => ({
              stageId: s.stageId,
              status: s.status,
              responsibleRole: s.responsibleRole,
              dependsOn: s.dependsOn,
              completedAt: s.completedAt,
            })),
          }, null, 2))
          return
        }

        console.log(`\n📋 阶段步骤: ${phase}`)
        for (const stage of stages) {
          const statusLabel = STAGE_STATUS_LABELS[stage.status] ?? stage.status
          console.log(`   ${stage.stageId} [${statusLabel}] 负责: ${stage.responsibleRole}`)
        }
        console.log()
      } catch (err) {
        console.error(`❌ 获取阶段步骤失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── stage status ──
  stageCmd
    .command("status")
    .description("查看步骤状态")
    .argument("<stageId>", "步骤 ID")
    .argument("[projectId]", "项目 ID")
    .option("--json", "以 JSON 格式输出")
    .action((stageId: string, projectId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveProjectId(engine, projectId)
        if (!pid) return

        const stage = engine.getStageInfo(pid, stageId)

        if (!stage) {
          console.error(`❌ 步骤不存在: ${stageId}`)
          process.exit(1)
          return
        }

        if (options?.json) {
          console.log(JSON.stringify({
            projectId: pid,
            stageId: stage.stageId,
            phase: stage.phase,
            status: stage.status,
            responsibleRole: stage.responsibleRole,
            dependsOn: stage.dependsOn,
            createdAt: stage.createdAt,
            updatedAt: stage.updatedAt,
            completedAt: stage.completedAt,
          }, null, 2))
          return
        }

        const statusLabel = STAGE_STATUS_LABELS[stage.status] ?? stage.status
        console.log(`\n📌 步骤: ${stage.stageId}`)
        console.log(`   阶段: ${stage.phase}`)
        console.log(`   状态: ${statusLabel}`)
        console.log(`   负责: ${stage.responsibleRole}`)
        console.log(`   依赖: ${stage.dependsOn.join(", ") || "无"}`)
        console.log()
      } catch (err) {
        console.error(`❌ 获取步骤状态失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── stage update ──
  stageCmd
    .command("update")
    .description("更新步骤状态")
    .argument("<stageId>", "步骤 ID")
    .argument("<status>", "新状态 (PENDING|IN_PROGRESS|COMPLETED|BLOCKED|SKIPPED)")
    .argument("[projectId]", "项目 ID")
    .option("--json", "以 JSON 格式输出")
    .action((stageId: string, status: string, projectId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveProjectId(engine, projectId)
        if (!pid) return

        const normalized = Object.values(StageStatus).find((s) => s.toLowerCase() === status.toLowerCase())
        if (!normalized) {
          console.error(`❌ 无效状态: ${status}。可选: ${Object.values(StageStatus).join(", ")}`)
          process.exit(1)
          return
        }

        engine.updateStageStatus(pid, stageId, normalized)

        if (options?.json) {
          const stage = engine.getStageInfo(pid, stageId)
          console.log(JSON.stringify({
            projectId: pid,
            stageId,
            status: stage?.status,
            updatedAt: stage?.updatedAt,
          }, null, 2))
          return
        }

        console.log(`✅ 步骤 ${stageId} 已更新为 ${normalized}`)
      } catch (err) {
        console.error(`❌ 更新步骤状态失败: ${(err as Error).message}`)
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
