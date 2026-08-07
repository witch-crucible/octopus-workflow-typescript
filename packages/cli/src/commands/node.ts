/**
 * `octopus node` —— 节点执行与运行记录命令。
 */

import { readFileSync } from "node:fs"
import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { TASK_STATUS_LABELS } from "@octopus/core/task.js"

export function buildNodeCommands(program: Command, engine: WorkflowEngine): void {
  const node = program.command("node").description("工作流节点执行与运行监控")

  node.command("list")
    .description("列出节点及当前/可运行节点")
    .argument("[projectId]", "项目 ID")
    .option("--json", "以 JSON 输出")
    .action((projectId: string | undefined, options: { json?: boolean }) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return
      const state = engine.getState(pid)
      const snapshot = engine.getExecutionSnapshot(pid)
      const rows = state.steps.map((step) => ({
        id: step.id,
        name: step.name,
        phase: step.phase,
        status: step.status,
        statusLabel: TASK_STATUS_LABELS[step.status],
        current: snapshot.currentNodeIds.includes(step.id),
        ready: snapshot.readyNodeIds.includes(step.id),
        workspace: state.projectRoot ? `${state.projectRoot}/workflow/nodes/${step.id}` : undefined,
      }))
      if (options.json) {
        console.log(JSON.stringify({ projectId: pid, snapshot, nodes: rows }, null, 2))
        return
      }
      console.log(`\n📍 节点 (${rows.length}) · 当前: ${snapshot.currentNodeIds.join(", ") || "无"}`)
      for (const row of rows) {
        const marker = row.current ? "▶" : row.ready ? "◇" : " "
        console.log(` ${marker} ${row.id.padEnd(8)} [${row.statusLabel}] ${row.name}`)
      }
      console.log()
    })

  node.command("show")
    .description("查看节点详情和运行历史")
    .argument("<nodeId>", "节点 ID")
    .argument("[projectId]", "项目 ID")
    .option("--json", "以 JSON 输出")
    .action((nodeId: string, projectId: string | undefined, options: { json?: boolean }) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return
      const state = engine.getState(pid)
      const step = state.steps.find((candidate) => candidate.id === nodeId)
      if (!step) throw new Error(`节点不存在: ${nodeId}`)
      const data = { projectId: pid, node: step, runs: engine.execution.listRuns(pid, nodeId) }
      if (options.json) {
        console.log(JSON.stringify(data, null, 2))
        return
      }
      console.log(`\n📌 ${step.id} ${step.name}`)
      console.log(`   状态: ${TASK_STATUS_LABELS[step.status]}`)
      console.log(`   依赖: ${step.dependsOn.join(", ") || "无"}`)
      console.log(`   运行次数: ${data.runs.length}`)
      if (state.projectRoot) console.log(`   工作目录: ${state.projectRoot}/workflow/nodes/${step.id}`)
      console.log()
    })

  node.command("run")
    .description("独立运行一个节点")
    .argument("<nodeId>", "节点 ID")
    .argument("[projectId]", "项目 ID")
    .option("--force", "忽略未完成依赖并记录审计")
    .option("--json", "以 JSON 输出")
    .action((nodeId: string, projectId: string | undefined, options: { force?: boolean; json?: boolean }) => {
      try {
        const pid = resolveProjectId(engine, projectId)
        if (!pid) return
        const run = engine.runNode(pid, nodeId, options.force === undefined ? {} : { force: options.force })
        if (options.json) console.log(JSON.stringify(run, null, 2))
        else console.log(`✅ 节点 ${nodeId} 已启动: ${run.id} (PID ${run.pid ?? "pending"})`)
      } catch (error) {
        console.error(`❌ 节点运行失败: ${(error as Error).message}`)
        process.exitCode = 1
      }
    })

  node.command("complete")
    .description("完成手动节点")
    .argument("<nodeId>", "节点 ID")
    .argument("[projectId]", "项目 ID")
    .option("--force", "忽略未完成依赖")
    .action((nodeId: string, projectId: string | undefined, options: { force?: boolean }) => {
      try {
        const pid = resolveProjectId(engine, projectId)
        if (!pid) return
        engine.execution.completeManualNode(pid, nodeId, options.force === true)
        console.log(`✅ 手动节点 ${nodeId} 已完成`)
      } catch (error) {
        console.error(`❌ 节点完成失败: ${(error as Error).message}`)
        process.exitCode = 1
      }
    })

  node.command("cancel")
    .description("取消活动运行")
    .argument("<runId>", "运行 ID")
    .argument("[projectId]", "项目 ID")
    .action((runId: string, projectId: string | undefined) => {
      try {
        const pid = resolveProjectId(engine, projectId)
        if (!pid) return
        const run = engine.execution.cancelRun(pid, runId)
        console.log(`✅ 运行 ${run.id} 已取消`)
      } catch (error) {
        console.error(`❌ 取消运行失败: ${(error as Error).message}`)
        process.exitCode = 1
      }
    })

  node.command("retry")
    .description("重试失败运行")
    .argument("<runId>", "运行 ID")
    .argument("[projectId]", "项目 ID")
    .option("--force", "忽略未完成依赖")
    .action((runId: string, projectId: string | undefined, options: { force?: boolean }) => {
      try {
        const pid = resolveProjectId(engine, projectId)
        if (!pid) return
        const run = engine.execution.retryRun(pid, runId, options.force === undefined ? {} : { force: options.force })
        console.log(`✅ 已创建重试运行: ${run.id}`)
      } catch (error) {
        console.error(`❌ 重试运行失败: ${(error as Error).message}`)
        process.exitCode = 1
      }
    })

  node.command("logs")
    .description("查看运行日志")
    .argument("<runId>", "运行 ID")
    .argument("[projectId]", "项目 ID")
    .option("--stderr", "查看 stderr")
    .action((runId: string, projectId: string | undefined, options: { stderr?: boolean }) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return
      const run = engine.execution.listRuns(pid).find((candidate) => candidate.id === runId)
      if (!run) throw new Error(`运行不存在: ${runId}`)
      const path = options.stderr ? run.stderrPath : run.stdoutPath
      try {
        console.log(readFileSync(path, "utf8"))
      } catch {
        console.log("（日志尚未产生）")
      }
    })
}

function resolveProjectId(engine: WorkflowEngine, projectId?: string): string | null {
  if (projectId) return projectId
  const projects = engine["store"].listProjects()
  if (projects.length === 0) {
    console.error("⚠️  没有找到项目。使用 `octopus init <name>` 创建新项目。")
    return null
  }
  return projects[0] ?? null
}
