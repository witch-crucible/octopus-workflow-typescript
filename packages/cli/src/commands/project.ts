/**
 * `octopus project list|delete` —— 列出或删除状态库中的项目。
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

export function buildProjectCommands(program: Command, engine: WorkflowEngine): void {
  const project = program.command("project").description("管理状态库中的项目")

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
          console.log("暂无项目。使用 `octopus init <name>` 创建。")
          return
        }
        console.log(`\n📁 项目（${summaries.length}）\n`)
        for (const item of summaries) {
          console.log(`   ${item.projectName}`)
          console.log(`   ID: ${item.projectId}`)
          console.log(`   阶段: ${item.currentPhase}  节点: ${item.completedTasks}/${item.totalTasks}`)
          if (item.projectRoot) console.log(`   根目录: ${item.projectRoot}`)
          console.log()
        }
      } catch (err) {
        console.error(`❌ 列出项目失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("delete")
    .description("删除项目状态（不删除源码目录）")
    .argument("<projectId>", "项目 ID")
    .option("--yes", "确认删除")
    .action((projectId: string, options: { yes?: boolean }) => {
      try {
        if (!options.yes) {
          throw new Error("删除不可恢复，请加 --yes 确认。只会删除状态库记录，不会删除源码目录。")
        }
        engine.deleteProject(projectId)
        console.log(`✅ 已删除项目状态: ${projectId}`)
      } catch (err) {
        console.error(`❌ 删除项目失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })
}
