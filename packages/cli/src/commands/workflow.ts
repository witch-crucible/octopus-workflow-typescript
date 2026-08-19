/** `octopus workflow` —— 工作流定义校验、同步与 DAG 调度。 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { resolveRequirementId } from "../resolve-requirement.js"
import { syncWorkflowWorkspace } from "@octopus/context/workflow.js"

export function buildWorkflowCommands(program: Command, engine: WorkflowEngine): void {
  const workflow = program.command("workflow").description("工作流定义与 DAG 调度")

  workflow.command("validate")
    .description("校验 workflow.yaml")
    .argument("[requirementId]", "需求 ID")
    .action((requirementId?: string) => {
      const pid = resolveRequirementId(engine, requirementId)
      if (!pid) return
      const definition = engine.getWorkflowDefinition(pid)
      console.log(`✅ 工作流有效: ${definition.name} (${definition.nodes.length} 个节点)`)
    })

  workflow.command("sync")
    .description("同步公共目录和节点目录")
    .argument("[requirementId]", "需求 ID")
    .action((requirementId?: string) => {
      const pid = resolveRequirementId(engine, requirementId)
      if (!pid) return
      const state = engine.getState(pid)
      const root = state.projectRoot ?? process.cwd()
      const definition = engine.getWorkflowDefinition(pid)
      const workspace = syncWorkflowWorkspace(root, definition)
      console.log(`✅ 工作区已同步: ${workspace.nodesPath}`)
    })

  workflow.command("run")
    .description("自动并行运行所有 READY 节点")
    .argument("[requirementId]", "需求 ID")
    .option("--max-parallel <count>", "最大并发数", "4")
    .option("--force", "忽略未完成依赖")
    .option("--json", "以 JSON 输出")
    .action(async (requirementId: string | undefined, options: { maxParallel: string; force?: boolean; json?: boolean }) => {
      try {
        const pid = resolveRequirementId(engine, requirementId)
        if (!pid) return
        const maxParallel = parsePositiveInteger(options.maxParallel, "--max-parallel")
        const snapshot = await engine.runWorkflow(pid, options.force === undefined
          ? { maxParallel }
          : { maxParallel, force: options.force })
        if (options.json) console.log(JSON.stringify(snapshot, null, 2))
        else console.log(`✅ 调度结束: ${snapshot.schedulerStatus} · 当前节点: ${snapshot.currentNodeIds.join(", ") || "无"}`)
      } catch (error) {
        console.error(`❌ 工作流运行失败: ${(error as Error).message}`)
        process.exitCode = 1
      }
    })

  workflow.command("status")
    .description("查看工作流调度状态")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 输出")
    .action((requirementId: string | undefined, options: { json?: boolean }) => {
      const pid = resolveRequirementId(engine, requirementId)
      if (!pid) return
      const snapshot = engine.getExecutionSnapshot(pid)
      if (options.json) console.log(JSON.stringify(snapshot, null, 2))
      else {
        console.log(`\n工作流: ${snapshot.schedulerStatus}`)
        console.log(`当前节点: ${snapshot.currentNodeIds.join(", ") || "无"}`)
        console.log(`可运行节点: ${snapshot.readyNodeIds.join(", ") || "无"}`)
        console.log(`等待手动节点: ${snapshot.waitingNodeIds.join(", ") || "无"}`)
        console.log(`活动运行: ${snapshot.activeRuns.length}\n`)
      }
    })
}


function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} 必须是正整数`)
  }
  return parsed
}
