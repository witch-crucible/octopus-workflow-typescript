/**
 * `octopus project` —— 项目容器管理（Project ⊃ Requirement）。
 *
 * 子命令:
 *   create <name> [--desc] [--json]
 *   list [--json]
 *   update <projectId> [--name] [--desc]
 *   delete <projectId> --yes
 *   bind-tb <projectId> (--tb-project <id> | --prefix <PREFIX>)
 *   unbind-tb <projectId>
 *   tb-statuses <projectId> [--json]
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

export function buildProjectCommands(program: Command, engine: WorkflowEngine): void {
  const project = program.command("project").description("管理项目容器")

  project
    .command("create")
    .description("创建项目容器")
    .argument("<name>", "项目名称")
    .option("-d, --desc <desc>", "项目描述")
    .option("--json", "以 JSON 格式输出")
    .action((name: string, options: { desc?: string; json?: boolean }) => {
      try {
        const created = engine.createProject(name, options.desc)
        if (options.json) {
          console.log(JSON.stringify(created, null, 2))
          return
        }
        console.log(`✅ 项目已创建: ${created.name}`)
        console.log(`   项目 ID: ${created.projectId}`)
        if (created.description) console.log(`   描述: ${created.description}`)
      } catch (err) {
        console.error(`❌ 创建项目失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("list")
    .description("列出全部项目")
    .option("--json", "以 JSON 格式输出")
    .action((options: { json?: boolean }) => {
      try {
        const summaries = engine.listProjectSummaries()
        if (options.json) {
          console.log(JSON.stringify(summaries, null, 2))
          return
        }
        if (summaries.length === 0) {
          console.log("暂无项目。使用 `octopus project create <name>` 创建。")
          return
        }
        console.log(`\n📁 项目（${summaries.length}）\n`)
        for (const item of summaries) {
          console.log(`   ${item.name}`)
          console.log(`   ID: ${item.projectId}`)
          console.log(`   需求数: ${item.requirementCount}`)
          if (item.description) console.log(`   描述: ${item.description}`)
          if (item.teambitionProjectId) {
            console.log(`   Teambition: ${item.teambitionProjectId}`)
          }
          console.log(`   更新: ${item.updatedAt}`)
          console.log()
        }
      } catch (err) {
        console.error(`❌ 列出项目失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("update")
    .description("更新项目名称或描述")
    .argument("<projectId>", "项目 ID")
    .option("--name <name>", "新名称")
    .option("-d, --desc <desc>", "新描述")
    .option("--json", "以 JSON 格式输出")
    .action((
      projectId: string,
      options: { name?: string; desc?: string; json?: boolean },
    ) => {
      try {
        if (options.name === undefined && options.desc === undefined) {
          throw new Error("请至少提供 --name 或 --desc")
        }
        const patch: { name?: string; description?: string } = {}
        if (options.name !== undefined) patch.name = options.name
        if (options.desc !== undefined) patch.description = options.desc
        const updated = engine.updateProjectMeta(projectId, patch)
        if (options.json) {
          console.log(JSON.stringify(updated, null, 2))
          return
        }
        console.log(`✅ 项目已更新: ${updated.name}`)
        console.log(`   项目 ID: ${updated.projectId}`)
      } catch (err) {
        console.error(`❌ 更新项目失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("delete")
    .description("删除项目及其下需求状态（不删除源码目录）")
    .argument("<projectId>", "项目 ID")
    .option("--yes", "确认删除")
    .action((projectId: string, options: { yes?: boolean }) => {
      try {
        if (!options.yes) {
          throw new Error(
            "删除不可恢复，请加 --yes 确认。只会删除状态库记录，不会删除源码目录。",
          )
        }
        engine.deleteProject(projectId)
        console.log(`✅ 已删除项目: ${projectId}`)
      } catch (err) {
        console.error(`❌ 删除项目失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("bind-tb")
    .description("绑定 Teambition 项目")
    .argument("<projectId>", "项目 ID")
    .option("--tb-project <id>", "Teambition 项目 ID")
    .option("--prefix <PREFIX>", "Teambition 项目前缀")
    .option("--json", "以 JSON 格式输出")
    .action(async (
      projectId: string,
      options: { tbProject?: string; prefix?: string; json?: boolean },
    ) => {
      try {
        if (!options.tbProject && !options.prefix) {
          throw new Error("请提供 --tb-project <id> 或 --prefix <PREFIX>")
        }
        const updated = await engine.bindProjectTeambition(projectId, {
          ...(options.tbProject !== undefined ? { projectId: options.tbProject } : {}),
          ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
        })
        if (options.json) {
          console.log(JSON.stringify(updated, null, 2))
          return
        }
        console.log(`✅ 已绑定 Teambition 项目: ${updated.teambition?.projectId}`)
        if (updated.teambition?.name) console.log(`   名称: ${updated.teambition.name}`)
        if (updated.teambition?.uniqueIdPrefix) {
          console.log(`   前缀: ${updated.teambition.uniqueIdPrefix}`)
        }
      } catch (err) {
        console.error(`❌ 绑定 Teambition 失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("unbind-tb")
    .description("解除 Teambition 项目绑定")
    .argument("<projectId>", "项目 ID")
    .option("--json", "以 JSON 格式输出")
    .action((projectId: string, options: { json?: boolean }) => {
      try {
        const updated = engine.unbindProjectTeambition(projectId)
        if (options.json) {
          console.log(JSON.stringify(updated, null, 2))
          return
        }
        console.log(`✅ 已解除 Teambition 绑定: ${projectId}`)
      } catch (err) {
        console.error(`❌ 解除绑定失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("tb-statuses")
    .description("列出已绑定 Teambition 项目的卡片状态")
    .argument("<projectId>", "项目 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (projectId: string, options: { json?: boolean }) => {
      try {
        const statuses = await engine.listTeambitionCardStatuses(projectId)
        if (options.json) {
          console.log(JSON.stringify(statuses, null, 2))
          return
        }
        if (statuses.length === 0) {
          console.log("暂无卡片状态。")
          return
        }
        console.log(`\n📌 Teambition 卡片状态（${statuses.length}）\n`)
        for (const status of statuses) {
          console.log(`   ${status.name}  (${status.id})`)
        }
        console.log()
      } catch (err) {
        console.error(`❌ 获取卡片状态失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })
}
