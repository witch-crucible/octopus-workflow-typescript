/**
 * `octopus milestone` —— 需求级单日里程碑。
 *
 * 子命令:
 *   list <requirementId> [--json] [--all]
 *   add <requirementId> --name --date [--phase] [--node] [--note] [--json]
 *   update <milestoneId> --requirement [--name] [--date] [--phase] [--node] [--note] [--json]
 *   reach <milestoneId> --requirement [--json]
 *   unreach <milestoneId> --requirement [--json]
 *   delete <milestoneId> --requirement --yes
 *   project <projectId> [--json]
 */

import { isMilestoneOverdue, type RequirementMilestone } from "@octopus/core/milestone.js"
import type { Phase } from "@octopus/core/phase.js"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import type { Command } from "commander"

function displayStatus(milestone: RequirementMilestone): string {
  if (milestone.status === "reached") return "reached"
  return isMilestoneOverdue(milestone) ? "overdue" : "planned"
}

function printMilestone(milestone: RequirementMilestone, extra = ""): void {
  const phase = milestone.phase ? `   ${milestone.phase}` : ""
  console.log(`${milestone.name}   ${milestone.date}  ${displayStatus(milestone)}${phase}${extra}`)
}

export function buildMilestoneCommands(program: Command, engine: WorkflowEngine): void {
  const milestone = program.command("milestone").description("管理需求级单日里程碑")

  milestone
    .command("list")
    .description("列出需求里程碑")
    .argument("<requirementId>", "需求 ID")
    .option("--all", "包含已达成")
    .option("--json", "以 JSON 格式输出")
    .action((requirementId: string, options: { all?: boolean; json?: boolean }) => {
      try {
        const items = engine.listMilestones(requirementId)
        const visible = options.all ? items : items.filter((item) => item.status === "planned")
        if (options.json) {
          console.log(JSON.stringify(visible, null, 2))
          return
        }
        if (visible.length === 0) {
          console.log(options.all ? "暂无里程碑。" : "暂无未达成里程碑。使用 --all 查看已达成。")
          return
        }
        for (const item of visible) printMilestone(item)
      } catch (err) {
        console.error(`❌ 列出里程碑失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  milestone
    .command("add")
    .description("新增需求里程碑")
    .argument("<requirementId>", "需求 ID")
    .requiredOption("--name <name>", "里程碑名称")
    .requiredOption("--date <date>", "日期 YYYY-MM-DD")
    .option("--phase <phase>", "可选挂钩阶段")
    .option("--node <nodeId>", "可选挂钩节点")
    .option("--note <text>", "备注")
    .option("--json", "以 JSON 格式输出")
    .action(
      (
        requirementId: string,
        options: {
          name: string
          date: string
          phase?: string
          node?: string
          note?: string
          json?: boolean
        },
      ) => {
        try {
          const created = engine.addMilestone(requirementId, {
            name: options.name,
            date: options.date,
            ...(options.phase !== undefined ? { phase: options.phase as Phase } : {}),
            ...(options.node !== undefined ? { nodeId: options.node } : {}),
            ...(options.note !== undefined ? { note: options.note } : {}),
          })
          if (options.json) {
            console.log(JSON.stringify(created, null, 2))
            return
          }
          console.log(`✅ 里程碑已创建: ${created.name}（${created.date}）`)
          console.log(`   ID: ${created.id}`)
        } catch (err) {
          console.error(`❌ 创建里程碑失败: ${(err as Error).message}`)
          process.exit(1)
        }
      },
    )

  milestone
    .command("update")
    .description("更新里程碑")
    .argument("<milestoneId>", "里程碑 ID")
    .requiredOption("--requirement <requirementId>", "需求 ID")
    .option("--name <name>", "名称")
    .option("--date <date>", "日期 YYYY-MM-DD")
    .option("--phase <phase>", "挂钩阶段；传空字符串清除")
    .option("--node <nodeId>", "挂钩节点；传空字符串清除")
    .option("--note <text>", "备注；传空字符串清除")
    .option("--json", "以 JSON 格式输出")
    .action(
      (
        milestoneId: string,
        options: {
          requirement: string
          name?: string
          date?: string
          phase?: string
          node?: string
          note?: string
          json?: boolean
        },
      ) => {
        try {
          const updated = engine.updateMilestone(options.requirement, milestoneId, {
            ...(options.name !== undefined ? { name: options.name } : {}),
            ...(options.date !== undefined ? { date: options.date } : {}),
            ...(options.phase !== undefined
              ? { phase: options.phase === "" ? null : (options.phase as Phase) }
              : {}),
            ...(options.node !== undefined
              ? { nodeId: options.node === "" ? null : options.node }
              : {}),
            ...(options.note !== undefined
              ? { note: options.note === "" ? null : options.note }
              : {}),
          })
          if (options.json) {
            console.log(JSON.stringify(updated, null, 2))
            return
          }
          console.log(`✅ 里程碑已更新: ${updated.name}（${updated.date}）`)
        } catch (err) {
          console.error(`❌ 更新里程碑失败: ${(err as Error).message}`)
          process.exit(1)
        }
      },
    )

  milestone
    .command("reach")
    .description("标记里程碑已达成（不改变需求阶段）")
    .argument("<milestoneId>", "里程碑 ID")
    .requiredOption("--requirement <requirementId>", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action((milestoneId: string, options: { requirement: string; json?: boolean }) => {
      try {
        const reached = engine.reachMilestone(options.requirement, milestoneId)
        if (options.json) {
          console.log(JSON.stringify(reached, null, 2))
          return
        }
        console.log(`✅ 已达成: ${reached.name}（不会改变需求阶段）`)
      } catch (err) {
        console.error(`❌ 标记达成失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  milestone
    .command("unreach")
    .description("取消里程碑达成")
    .argument("<milestoneId>", "里程碑 ID")
    .requiredOption("--requirement <requirementId>", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action((milestoneId: string, options: { requirement: string; json?: boolean }) => {
      try {
        const planned = engine.unreachMilestone(options.requirement, milestoneId)
        if (options.json) {
          console.log(JSON.stringify(planned, null, 2))
          return
        }
        console.log(`✅ 已取消达成: ${planned.name}`)
      } catch (err) {
        console.error(`❌ 取消达成失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  milestone
    .command("delete")
    .description("删除里程碑")
    .argument("<milestoneId>", "里程碑 ID")
    .requiredOption("--requirement <requirementId>", "需求 ID")
    .option("--yes", "确认删除")
    .action((milestoneId: string, options: { requirement: string; yes?: boolean }) => {
      try {
        if (!options.yes) {
          throw new Error("删除不可恢复，请加 --yes 确认。")
        }
        engine.deleteMilestone(options.requirement, milestoneId)
        console.log(`✅ 已删除里程碑: ${milestoneId}`)
      } catch (err) {
        console.error(`❌ 删除里程碑失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  milestone
    .command("project")
    .description("列出项目下全部需求里程碑")
    .argument("<projectId>", "项目 ID")
    .option("--json", "以 JSON 格式输出")
    .action((projectId: string, options: { json?: boolean }) => {
      try {
        const items = engine.listProjectMilestones(projectId)
        if (options.json) {
          console.log(JSON.stringify(items, null, 2))
          return
        }
        if (items.length === 0) {
          console.log("该项目暂无里程碑。")
          return
        }
        for (const item of items) {
          printMilestone(item, `   ${item.requirementName}`)
        }
      } catch (err) {
        console.error(`❌ 列出项目里程碑失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })
}
