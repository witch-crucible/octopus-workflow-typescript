/**
 * `octopus init <projectName>` —— 创建新项目。
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

export function buildInitCommand(program: Command, engine: WorkflowEngine): void {
  program
    .command("init")
    .description("创建新项目")
    .argument("<projectName>", "项目名称")
    .option("-d, --description <desc>", "项目描述")
    .action((projectName: string, options: { description?: string }) => {
      const state = engine.initProject(projectName, options.description)
      console.log(`✅ 项目已创建: ${state.projectName}`)
      console.log(`   项目 ID: ${state.projectId}`)
      console.log(`   当前阶段: ${state.currentPhase}`)
      console.log(`   任务数: ${state.tasks.length}`)
    })
}
