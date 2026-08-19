/** `octopus monitor` —— 运行状态、事件和集成健康检查。 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { resolveRequirementId } from "../resolve-requirement.js"

const MAX_TIMER_DELAY_MS = 2_147_483_647

export function buildMonitorCommands(program: Command, engine: WorkflowEngine): void {
  const monitor = program.command("monitor").description("工作流运行监控")

  monitor.command("status")
    .description("查看运行和集成健康度")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 输出")
    .action((requirementId: string | undefined, options: { json?: boolean }) => {
      const pid = resolveRequirementId(engine, requirementId)
      if (!pid) return
      const data = {
        snapshot: engine.getExecutionSnapshot(pid),
        health: engine.getIntegrationHealth(),
        plugins: engine.listPlugins(),
      }
      if (options.json) console.log(JSON.stringify(data, null, 2))
      else {
        console.log(`\n运行状态: ${data.snapshot.schedulerStatus}`)
        console.log(`活动运行: ${data.snapshot.activeRuns.length}`)
        console.log(`插件: ${data.plugins.length > 0 ? data.plugins.map((plugin) => `${plugin.id}@${plugin.version}`).join(", ") : "无"}`)
        for (const health of data.health) console.log(`集成 ${health.service}: ${health.healthy ? "✅" : "❌"} ${health.message}`)
        console.log()
      }
    })

  monitor.command("check")
    .description("立即检查所有已注册集成")
    .argument("[requirementId]", "需求 ID")
    .action(async (requirementId?: string) => {
      const pid = resolveRequirementId(engine, requirementId)
      if (!pid) return
      const health = await engine.checkIntegrationHealth()
      if (health.length === 0) console.log("ℹ️  当前没有注册集成")
      for (const item of health) console.log(`${item.healthy ? "✅" : "❌"} ${item.service}: ${item.message} (${item.latencyMs}ms)`)
    })

  monitor.command("watch")
    .description("持续查看节点事件")
    .argument("[requirementId]", "需求 ID")
    .option("--interval <ms>", "轮询间隔", "1000")
    .action(async (requirementId: string | undefined, options: { interval: string }) => {
      const pid = resolveRequirementId(engine, requirementId)
      if (!pid) return
      const interval = parseInterval(options.interval)
      let sequence = 0
      console.log("正在监控，按 Ctrl+C 退出。")
      while (true) {
        for (const event of engine.execution.eventsAfter(pid, sequence)) {
          sequence = event.sequence
          console.log(`[${event.createdAt}] ${event.type} ${event.nodeId ?? ""} ${JSON.stringify(event.payload)}`)
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, interval))
      }
    })
}


function parseInterval(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > MAX_TIMER_DELAY_MS) {
    throw new Error(`--interval 必须是 100 至 ${MAX_TIMER_DELAY_MS}ms 的整数`)
  }
  return parsed
}
