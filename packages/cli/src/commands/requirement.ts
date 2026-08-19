/**
 * `octopus requirement` —— 需求（工作流实例）管理。
 *
 * 子命令:
 *   init <name> --project <projectId> [--desc] [--root] [--json]
 *   list [--project <id>] [--json]
 *   delete <requirementId> --yes
 *   bind-task <requirementId> (--ref <REF> | --task-id <id>)
 *   unbind-task <requirementId>
 *   tb-status <requirementId> [--json]
 *   tb-update <requirementId> --status-id <id> [--operator <userId>]
 */

import type { Command } from "commander"
import { resolve } from "node:path"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

export function buildRequirementCommands(program: Command, engine: WorkflowEngine): void {
  const requirement = program.command("requirement").description("管理需求（工作流实例）")

  requirement
    .command("init")
    .description("在项目下初始化需求")
    .argument("<name>", "需求名称")
    .requiredOption("--project <projectId>", "所属项目 ID")
    .option("-d, --desc <desc>", "需求描述")
    .option("--root <path>", "项目源码根目录（默认当前目录）")
    .option("--json", "以 JSON 格式输出")
    .action((
      name: string,
      options: { project: string; desc?: string; root?: string; json?: boolean },
    ) => {
      try {
        const projectRoot = resolve(options.root ?? process.cwd())
        const state = engine.initRequirement(
          options.project,
          name,
          options.desc,
          projectRoot,
        )
        if (options.json) {
          console.log(JSON.stringify({
            projectId: state.projectId,
            requirementId: state.requirementId,
            requirementName: state.requirementName,
            description: state.description,
            currentPhase: state.currentPhase,
            taskCount: state.steps.length,
            projectRoot,
            createdAt: state.createdAt,
          }, null, 2))
          return
        }
        console.log(`✅ 需求已创建: ${state.requirementName}`)
        console.log(`   需求 ID: ${state.requirementId}`)
        console.log(`   项目 ID: ${state.projectId}`)
        console.log(`   当前阶段: ${state.currentPhase}`)
        console.log(`   任务数: ${state.steps.length}`)
      } catch (err) {
        console.error(`❌ 创建需求失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  requirement
    .command("list")
    .description("列出需求")
    .option("--project <projectId>", "按项目过滤")
    .option("--json", "以 JSON 格式输出")
    .action((options: { project?: string; json?: boolean }) => {
      try {
        const summaries = engine.listRequirementSummaries(options.project)
        if (options.json) {
          console.log(JSON.stringify(summaries, null, 2))
          return
        }
        if (summaries.length === 0) {
          console.log(
            "暂无需求。使用 `octopus requirement init <name> --project <projectId>` 创建。",
          )
          return
        }
        console.log(`\n📋 需求（${summaries.length}）\n`)
        for (const item of summaries) {
          console.log(`   ${item.requirementName}`)
          console.log(`   需求 ID: ${item.requirementId}`)
          console.log(`   项目 ID: ${item.projectId}`)
          console.log(
            `   阶段: ${item.currentPhase}  节点: ${item.completedTasks}/${item.totalTasks}`,
          )
          if (item.projectRoot) console.log(`   根目录: ${item.projectRoot}`)
          if (item.teambitionTaskId) {
            console.log(`   Teambition 任务: ${item.teambitionTaskId}`)
          }
          if (item.teambitionStatusName) {
            console.log(`   Teambition 状态: ${item.teambitionStatusName}`)
          }
          console.log()
        }
      } catch (err) {
        console.error(`❌ 列出需求失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  requirement
    .command("delete")
    .description("删除需求状态（不删除源码目录）")
    .argument("<requirementId>", "需求 ID")
    .option("--yes", "确认删除")
    .action((requirementId: string, options: { yes?: boolean }) => {
      try {
        if (!options.yes) {
          throw new Error(
            "删除不可恢复，请加 --yes 确认。只会删除状态库记录，不会删除源码目录。",
          )
        }
        engine.deleteRequirement(requirementId)
        console.log(`✅ 已删除需求状态: ${requirementId}`)
      } catch (err) {
        console.error(`❌ 删除需求失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  requirement
    .command("bind-task")
    .description("绑定 Teambition 任务")
    .argument("<requirementId>", "需求 ID")
    .option("--ref <REF>", "Teambition 任务编号")
    .option("--task-id <id>", "Teambition 任务 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (
      requirementId: string,
      options: { ref?: string; taskId?: string; json?: boolean },
    ) => {
      try {
        if (!options.ref && !options.taskId) {
          throw new Error("请提供 --ref <REF> 或 --task-id <id>")
        }
        const state = await engine.bindRequirementTask(requirementId, {
          ...(options.ref !== undefined ? { taskRef: options.ref } : {}),
          ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
        })
        if (options.json) {
          console.log(JSON.stringify({
            requirementId: state.requirementId,
            projectId: state.projectId,
            teambition: state.teambition,
          }, null, 2))
          return
        }
        console.log(`✅ 已绑定 Teambition 任务`)
        if (state.teambition?.taskRef) console.log(`   编号: ${state.teambition.taskRef}`)
        if (state.teambition?.taskId) console.log(`   任务 ID: ${state.teambition.taskId}`)
        if (state.teambition?.statusName) {
          console.log(`   状态: ${state.teambition.statusName}`)
        }
      } catch (err) {
        console.error(`❌ 绑定任务失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  requirement
    .command("unbind-task")
    .description("解除 Teambition 任务绑定")
    .argument("<requirementId>", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action((requirementId: string, options: { json?: boolean }) => {
      try {
        const state = engine.unbindRequirementTask(requirementId)
        if (options.json) {
          console.log(JSON.stringify({
            requirementId: state.requirementId,
            projectId: state.projectId,
            teambition: state.teambition ?? null,
          }, null, 2))
          return
        }
        console.log(`✅ 已解除 Teambition 任务绑定: ${requirementId}`)
      } catch (err) {
        console.error(`❌ 解除绑定失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  requirement
    .command("tb-status")
    .description("读取并同步 Teambition 任务状态")
    .argument("<requirementId>", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (requirementId: string, options: { json?: boolean }) => {
      try {
        const binding = await engine.getRequirementTeambitionStatus(requirementId)
        if (options.json) {
          console.log(JSON.stringify(binding, null, 2))
          return
        }
        console.log(`\n📌 Teambition 任务状态`)
        if (binding.taskRef) console.log(`   编号: ${binding.taskRef}`)
        if (binding.taskId) console.log(`   任务 ID: ${binding.taskId}`)
        if (binding.statusName) console.log(`   状态: ${binding.statusName}`)
        if (binding.statusId) console.log(`   状态 ID: ${binding.statusId}`)
        if (binding.url) console.log(`   链接: ${binding.url}`)
        if (binding.lastSyncedAt) console.log(`   同步: ${binding.lastSyncedAt}`)
        console.log()
      } catch (err) {
        console.error(`❌ 获取 Teambition 状态失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  requirement
    .command("tb-update")
    .description("更新 Teambition 任务工作流状态")
    .argument("<requirementId>", "需求 ID")
    .requiredOption("--status-id <id>", "目标状态 ID")
    .option("--operator <userId>", "操作者用户 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (
      requirementId: string,
      options: { statusId: string; operator?: string; json?: boolean },
    ) => {
      try {
        const binding = await engine.updateRequirementTeambitionStatus(
          requirementId,
          options.statusId,
          options.operator,
        )
        if (options.json) {
          console.log(JSON.stringify(binding, null, 2))
          return
        }
        console.log(`✅ 已更新 Teambition 状态`)
        if (binding.statusName) console.log(`   状态: ${binding.statusName}`)
        if (binding.statusId) console.log(`   状态 ID: ${binding.statusId}`)
      } catch (err) {
        console.error(`❌ 更新 Teambition 状态失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })
}
