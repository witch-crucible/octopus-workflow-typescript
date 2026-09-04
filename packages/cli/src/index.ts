#!/usr/bin/env node
/**
 * CLI 入口 —— 使用 commander 实现子命令路由。
 *
 * 命令结构：
 *   octopus project create|list|update|delete|bind-tb|unbind-tb|tb-statuses
 *   octopus requirement init|list|delete|bind-task|unbind-task|tb-status|tb-update
 *   octopus milestone list|add|update|reach|unreach|delete|project
 *   octopus init <name> --project <id>  — requirement init 别名
 *   octopus status                      — 需求状态
 *   octopus phase list|advance|rollback|show
 *   octopus task list|complete|export|import
 *   octopus checklist show              — 清单展示
 *   octopus heinrich show               — 海因里希三角
 *   octopus ai ask <prompt>             — 询问 AI
 *   octopus brd config|prompts|generate|check — BRD 设计
 */

import { Command } from "commander"
import { loadConfig } from "@octopus/context/config.js"
import { createWorkflowEngineFromConfig } from "@octopus/workflow-engine/index.js"
import { buildInitCommand } from "./commands/init.js"
import { buildProjectCommands } from "./commands/project.js"
import { buildRequirementCommands } from "./commands/requirement.js"
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
import { buildMilestoneCommands } from "./commands/milestone.js"
import { buildMineCommands } from "./commands/mine.js"
import { buildBrdCommands } from "./commands/brd.js"
import { buildStorageCommands } from "./commands/storage.js"

class CliRequestedExit extends Error {
  constructor(readonly exitCode: number) {
    super(`CLI requested exit ${exitCode}`)
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const engine = await createWorkflowEngineFromConfig(config)
  const nativeExit = process.exit
  process.exit = ((code?: number) => {
    throw new CliRequestedExit(code ?? 0)
  }) as typeof process.exit
  try {
    const program = new Command()

    program
      .name("octopus")
      .description(
        "AI 项目流程自动化引擎 — AI-assisted software development workflow orchestration",
      )
      .version("0.1.0")

    // 注册子命令
    buildInitCommand(program, engine)
    buildProjectCommands(program, engine)
    buildRequirementCommands(program, engine)
    buildMilestoneCommands(program, engine)
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
    buildMineCommands(program, engine, config.storeDir)
    buildBrdCommands(program, engine)
    buildStorageCommands(program, engine)

    await program.parseAsync(process.argv)

    // 未指定命令时显示帮助
    if (!process.argv.slice(2).length) {
      program.outputHelp()
    }
  } finally {
    process.exit = nativeExit
    await engine.close()
  }
}

main().catch((err) => {
  if (err instanceof CliRequestedExit) {
    process.exitCode = err.exitCode
    return
  }
  console.error("❌ CLI 启动失败:", err)
  process.exitCode = 1
})
