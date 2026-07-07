/**
 * `octopus checklist` —— 清单管理命令。
 *
 * 子命令:
 *   show [phase] [projectId]     — 显示清单
 *   check <itemId> [projectId]   — 核验清单项
 *   uncheck <itemId> [projectId] — 取消核验
 *   add <cat> <desc> [projectId] — 添加清单项
 *   remove <itemId> [projectId]  — 删除清单项
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { Phase } from "@octopus/core/phase.js"
import { ChecklistItemStatus } from "@octopus/core/checklist.js"

export function buildChecklistCommands(program: Command, engine: WorkflowEngine): void {
  const clCmd = program
    .command("checklist")
    .description("清单管理")

  // ── checklist show ──
  clCmd
    .command("show")
    .description("显示清单")
    .argument("[phase]", "阶段名称（默认为当前阶段）")
    .argument("[projectId]", "项目 ID")
    .action((phaseName?: string, projectId?: string) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      const state = engine.getState(pid)
      const phase = phaseName
        ? (Object.values(Phase).find((p) => p.toLowerCase() === phaseName.toLowerCase()) ?? state.currentPhase)
        : state.currentPhase

      const checklist = engine.getChecklist(pid, phase)

      console.log(`\n📋 ${phase} 清单 (${checklist.items.length} 项):`)
      if (checklist.items.length === 0) {
        console.log("   (空) 使用 `octopus checklist add <cat> <desc>` 添加项")
      } else {
        for (const item of checklist.items) {
          const icon = item.status === ChecklistItemStatus.VERIFIED
            ? "✅"
            : item.status === ChecklistItemStatus.NA
              ? "⏭"
              : "⬜"
          console.log(`   ${icon} [${item.id}] ${item.description}`)
          if (item.category) console.log(`       分类: ${item.category}`)
          if (item.verifiedBy) console.log(`       核验: ${item.verifiedBy} ${item.verifiedAt ? `于 ${item.verifiedAt}` : ""}`)
          console.log()
        }
      }
    })

  // ── checklist check ──
  clCmd
    .command("check")
    .description("核验清单项")
    .argument("<itemId>", "清单项 ID")
    .argument("[projectId]", "项目 ID")
    .action((itemId: string, projectId?: string) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      const state = engine.getState(pid)
      // 在所有阶段中查找清单项
      for (const phase of Object.values(Phase)) {
        const cl = state.checklists[phase]
        if (cl?.items.some((i) => i.id === itemId)) {
          engine.verifyChecklistItem(pid, phase, itemId)
          console.log(`✅ 清单项已核验: ${itemId}`)
          return
        }
      }
      console.error(`❌ 清单项不存在: ${itemId}`)
    })

  // ── checklist add ──
  clCmd
    .command("add")
    .description("添加清单项")
    .argument("<category>", "分类")
    .argument("<description>", "描述")
    .argument("[phase]", "阶段名称（默认为当前阶段）")
    .argument("[projectId]", "项目 ID")
    .action((category: string, description: string, phaseName?: string, projectId?: string) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      const state = engine.getState(pid)
      const phase = phaseName
        ? (Object.values(Phase).find((p) => p.toLowerCase() === phaseName.toLowerCase()) ?? state.currentPhase)
        : state.currentPhase

      engine.addChecklistItem(pid, phase, category, description)
      console.log(`✅ 清单项已添加: [${category}] ${description}`)
    })

  // ── checklist remove ──
  clCmd
    .command("remove")
    .description("删除清单项")
    .argument("<itemId>", "清单项 ID")
    .argument("[projectId]", "项目 ID")
    .action((itemId: string, projectId?: string) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return

      const state = engine.getState(pid)
      for (const phase of Object.values(Phase)) {
        const cl = state.checklists[phase]
        if (cl?.items.some((i) => i.id === itemId)) {
          engine.removeChecklistItem(pid, phase, itemId)
          console.log(`✅ 清单项已删除: ${itemId}`)
          return
        }
      }
      console.error(`❌ 清单项不存在: ${itemId}`)
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
