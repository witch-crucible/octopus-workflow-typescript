#!/usr/bin/env node
/**
 * CLI 入口 —— 使用 commander 实现子命令路由。
 *
 * 命令结构：
 *   octopus init <name>         — 创建项目
 *   octopus status              — 项目状态
 *   octopus phase list          — 阶段列表
 *   octopus phase advance       — 前进阶段
 *   octopus phase rollback <p>  — 回退阶段
 *   octopus task list           — 任务列表
 *   octopus task complete <id>  — 完成任务
 *   octopus checklist show      — 清单展示
 *   octopus heinrich show       — 海因里希三角
 *   octopus ai ask <prompt>     — 询问 AI
 */

import { Command } from "commander"
import { loadConfig } from "@octopus/context/config.js"
import { createWorkflowEngineFromConfig } from "@octopus/workflow-engine/index.js"
import { buildInitCommand } from "./commands/init.js"
import { buildStatusCommand } from "./commands/status.js"
import { buildPhaseCommands } from "./commands/phase.js"
import { buildTaskCommands } from "./commands/task.js"
import { buildChecklistCommands } from "./commands/checklist.js"
import { buildHeinrichCommands } from "./commands/heinrich.js"
import { buildStageCommands } from "./commands/stage.js"
import { buildStepCommands } from "./commands/step.js"
import { buildAiCommands } from "./commands/ai.js"
import { buildNodeCommands } from "./commands/node.js"
import { buildWorkflowCommands } from "./commands/workflow.js"
import { buildMonitorCommands } from "./commands/monitor.js"

async function main(): Promise<void> {
  const config = loadConfig()
  const engine = await createWorkflowEngineFromConfig(config)

  const program = new Command()

  program
    .name("octopus")
    .description("AI 项目流程自动化引擎 — AI-assisted software development workflow orchestration")
    .version("0.1.0")

  // 注册子命令
  buildInitCommand(program, engine)
  buildStatusCommand(program, engine)
  buildPhaseCommands(program, engine)
  buildTaskCommands(program, engine)
  buildChecklistCommands(program, engine)
  buildHeinrichCommands(program, engine)
  buildStageCommands(program, engine)
  buildStepCommands(program, engine)
  buildAiCommands(program, engine)
  buildNodeCommands(program, engine)
  buildWorkflowCommands(program, engine)
  buildMonitorCommands(program, engine)

  program.parse(process.argv)

  // 未指定命令时显示帮助
  if (!process.argv.slice(2).length) {
    program.outputHelp()
  }
}

main().catch((err) => {
  console.error("❌ CLI 启动失败:", err)
  process.exit(1)
})
