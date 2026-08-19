/**
 * `octopus checklist` —— 清单管理命令。
 *
 * 子命令:
 *   show [phase] [requirementId]     — 显示清单
 *   check <itemId> [requirementId]   — 核验清单项
 *   uncheck <itemId> [requirementId] — 取消核验
 *   add <cat> <desc> [requirementId] — 添加清单项
 *   remove <itemId> [requirementId]  — 删除清单项
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { resolveRequirementId } from "../resolve-requirement.js"
import { Phase } from "@octopus/core/phase.js"
import { Role } from "@octopus/core/role.js"
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
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action((phaseName?: string, requirementId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const state = engine.getState(pid)
        const phase = phaseName
          ? (Object.values(Phase).find((p) => p.toLowerCase() === phaseName.toLowerCase()) ?? state.currentPhase)
          : state.currentPhase

        const checklist = engine.getChecklist(pid, phase)

        if (options?.json) {
          console.log(JSON.stringify({
            projectId: state.projectId,
            phase,
            items: checklist.items.map((item) => ({
              id: item.id,
              category: item.category,
              description: item.description,
              status: item.status,
              verifiedBy: item.verifiedBy,
              verifiedAt: item.verifiedAt,
            })),
          }, null, 2))
          return
        }

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
      } catch (err) {
        console.error(`❌ 获取清单失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── checklist check ──
  clCmd
    .command("check")
    .description("核验清单项")
    .argument("<itemId>", "清单项 ID")
    .argument("[requirementId]", "需求 ID")
    .option("--as-role <role>", "以指定角色执行")
    .option("--json", "以 JSON 格式输出")
    .action((itemId: string, requirementId?: string, options?: { asRole?: string; json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const state = engine.getState(pid)
        const role = options?.asRole ? (Object.values(Role).find((r) => r.toLowerCase() === options.asRole!.toLowerCase()) as Role | undefined) : undefined
        // 在所有阶段中查找清单项
        for (const phase of Object.values(Phase)) {
          const cl = state.checklists[phase]
          if (cl?.items.some((i) => i.id === itemId)) {
            engine.verifyChecklistItem(pid, phase, itemId, role)

            if (options?.json) {
              console.log(JSON.stringify({
                requirementId: pid,
                itemId,
                status: "VERIFIED",
              }, null, 2))
              return
            }

            console.log(`✅ 清单项已核验: ${itemId}`)
            return
          }
        }

        console.error(`❌ 清单项不存在: ${itemId}`)
        process.exit(1)
      } catch (err) {
        console.error(`❌ 核验清单项失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── checklist add ──
  clCmd
    .command("add")
    .description("添加清单项")
    .argument("<category>", "分类")
    .argument("<description>", "描述")
    .argument("[phase]", "阶段名称（默认为当前阶段）")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action((category: string, description: string, phaseName?: string, requirementId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const state = engine.getState(pid)
        const phase = phaseName
          ? (Object.values(Phase).find((p) => p.toLowerCase() === phaseName.toLowerCase()) ?? state.currentPhase)
          : state.currentPhase

        const updated = engine.addChecklistItem(pid, phase, category, description)
        const item = updated.checklists[phase]!.items.at(-1)!

        if (options?.json) {
          console.log(JSON.stringify({
            requirementId: pid,
            phase,
            itemId: item.id,
            category,
            description,
            status: item.status,
          }, null, 2))
          return
        }

        console.log(`✅ 清单项已添加: [${category}] ${description}`)
      } catch (err) {
        console.error(`❌ 添加清单项失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── checklist remove ──
  clCmd
    .command("remove")
    .description("删除清单项")
    .argument("<itemId>", "清单项 ID")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action((itemId: string, requirementId?: string, options?: { json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return

        const state = engine.getState(pid)
        for (const phase of Object.values(Phase)) {
          const cl = state.checklists[phase]
          if (cl?.items.some((i) => i.id === itemId)) {
            engine.removeChecklistItem(pid, phase, itemId)

            if (options?.json) {
              console.log(JSON.stringify({
                requirementId: pid,
                itemId,
                removed: true,
              }, null, 2))
              return
            }

            console.log(`✅ 清单项已删除: ${itemId}`)
            return
          }
        }

        console.error(`❌ 清单项不存在: ${itemId}`)
        process.exit(1)
      } catch (err) {
        console.error(`❌ 删除清单项失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })
}

