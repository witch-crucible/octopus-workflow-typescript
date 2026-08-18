/**
 * `octopus init <projectName>` —— 创建新项目。
 */

import type { Command } from "commander"
import { resolve } from "node:path"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

export function buildInitCommand(program: Command, engine: WorkflowEngine): void {
  program
    .command("init")
    .description("创建新项目")
    .argument("<projectName>", "项目名称")
    .option("-d, --description <desc>", "项目描述")
    .option("--root <path>", "项目源码根目录（默认当前目录）")
    .option("--json", "以 JSON 格式输出")
    .action((projectName: string, options: { description?: string; root?: string; json?: boolean }) => {
      try {
        const projectRoot = resolve(options.root ?? process.cwd())
        const state = engine.initProject(projectName, options.description, projectRoot)
        if (options.json) {
          console.log(JSON.stringify({
            projectId: state.projectId,
            projectName: state.projectName,
            description: state.description,
            currentPhase: state.currentPhase,
            taskCount: state.steps.length,
            projectRoot,
            createdAt: state.createdAt,
          }, null, 2))
          return
        }
        console.log(`✅ 项目已创建: ${state.projectName}`)
        console.log(`   项目 ID: ${state.projectId}`)
        console.log(`   当前阶段: ${state.currentPhase}`)
        console.log(`   任务数: ${state.steps.length}`)
      } catch (err) {
        console.error(`❌ 创建项目失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })
}
