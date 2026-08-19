/**
 * `octopus init <name> --project <projectId>` —— `requirement init` 的别名。
 */

import type { Command } from "commander"
import { resolve } from "node:path"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

export function buildInitCommand(program: Command, engine: WorkflowEngine): void {
  program
    .command("init")
    .description("初始化需求（requirement init 别名，必须指定 --project）")
    .argument("<name>", "需求名称")
    .requiredOption("--project <projectId>", "所属项目 ID")
    .option("-d, --desc <desc>", "需求描述")
    .option("--description <desc>", "需求描述（兼容旧参数）")
    .option("--root <path>", "项目源码根目录（默认当前目录）")
    .option("--json", "以 JSON 格式输出")
    .action((
      name: string,
      options: {
        project: string
        desc?: string
        description?: string
        root?: string
        json?: boolean
      },
    ) => {
      try {
        const projectRoot = resolve(options.root ?? process.cwd())
        const description = options.desc ?? options.description
        const state = engine.initRequirement(
          options.project,
          name,
          description,
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
}
