/**
 * `octopus node` —— 节点执行与运行记录命令。
 */

import { readFileSync } from "node:fs"
import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { TASK_STATUS_LABELS } from "@octopus/core/task.js"
import type { NodeAction, WorkflowNodeSpec } from "@octopus/core/execution.js"
import { Phase } from "@octopus/core/phase.js"
import { Role } from "@octopus/core/role.js"
import { AIAssistantType } from "@octopus/core/agent.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import {
  definitionFromBuiltInSpec,
  loadWorkflowDefinition,
  resolveWorkflowNodeId,
  resolveWorkflowNodeKey,
} from "@octopus/context/workflow.js"

interface CreateNodeOptions {
  description?: string
  phase?: string
  role: string[]
  dependsOn: string[]
  type: string
  instructions?: string
  executable?: string
  arg: string[]
  timeout?: string
  assistant?: string
  input?: string
  output?: string
  ifExists: string
  delta?: string
  level?: string
  json?: boolean
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

export function buildNodeCommands(program: Command, engine: WorkflowEngine): void {
  const node = program.command("node").description("工作流节点执行与运行监控")

  node.command("create")
    .description("创建任务节点并写入项目工作流")
    .argument("<nodeKey>", "英文节点 key（kebab-case）")
    .argument("<name>", "节点名称")
    .argument("[projectId]", "项目 ID")
    .option("--description <text>", "节点描述")
    .option("--phase <phase>", "所属阶段，默认当前阶段")
    .option("--role <role>", "负责角色，可重复", collect, [])
    .option("--depends-on <nodeKey>", "前置节点英文 key，可重复", collect, [])
    .option("--type <type>", "动作类型：manual、command、ai、heinrich", "manual")
    .option("--instructions <text>", "手动节点操作说明")
    .option("--executable <path>", "命令节点可执行文件")
    .option("--arg <value>", "命令参数，可重复", collect, [])
    .option("--timeout <ms>", "命令超时毫秒数")
    .option("--assistant <type>", "AI 助手类型")
    .option("--input <text>", "AI 输入")
    .option("--output <file>", "AI 输出文件，相对于节点工作目录")
    .option("--if-exists <mode>", "AI 输出存在时的处理：overwrite、extend", "overwrite")
    .option("--delta <count>", "Heinrich 计数增量")
    .option("--level <level>", "Heinrich 等级：MAJOR、MINOR、TRIVIAL")
    .option("--json", "以 JSON 输出")
    .action((nodeKey: string, name: string, projectId: string | undefined, options: CreateNodeOptions) => {
      try {
        const pid = resolveProjectId(engine, projectId)
        if (!pid) return
        const state = engine.getState(pid)
        const phase = parseEnumValue(Phase, options.phase ?? state.currentPhase, "阶段")
        const roles = options.role.length > 0
          ? options.role.map((role) => parseEnumValue(Role, role, "角色"))
          : [Role.DEV]
        const spec: WorkflowNodeSpec = {
          key: nodeKey,
          phase,
          name,
          description: options.description ?? "",
          responsibleRoles: roles,
          dependsOn: options.dependsOn,
          actions: [createNodeAction(options)],
        }
        const result = engine.createNode(pid, spec)
        if (options.json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }
        const activation = result.activated ? "已加入当前阶段" : "将在对应阶段激活"
        console.log(`✅ 节点 ${nodeKey} 已创建（${activation}）`)
        console.log(`   工作目录: ${result.workspacePath}`)
      } catch (error) {
        console.error(`❌ 创建节点失败: ${(error as Error).message}`)
        process.exitCode = 1
      }
    })

  node.command("list")
    .description("列出节点及当前/可运行节点")
    .argument("[projectId]", "项目 ID")
    .option("--json", "以 JSON 输出")
    .action((projectId: string | undefined, options: { json?: boolean }) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return
      const state = engine.getState(pid)
      const snapshot = engine.getExecutionSnapshot(pid)
      const definition = state.projectRoot ? loadWorkflowDefinition(state.projectRoot) : definitionFromBuiltInSpec()
      const keyForId = (nodeId: string): string => resolveWorkflowNodeKey(definition, nodeId)
      const rows = state.steps.map((step) => ({
        key: keyForId(step.id),
        name: step.name,
        phase: step.phase,
        status: step.status,
        statusLabel: TASK_STATUS_LABELS[step.status],
        current: snapshot.currentNodeIds.includes(step.id),
        ready: snapshot.readyNodeIds.includes(step.id),
        workspace: state.projectRoot ? `${state.projectRoot}/workflow/nodes/${keyForId(step.id)}` : undefined,
      }))
      if (options.json) {
        console.log(JSON.stringify({
          projectId: pid,
          snapshot: {
            currentNodeKeys: snapshot.currentNodeIds.map(keyForId),
            readyNodeKeys: snapshot.readyNodeIds.map(keyForId),
            waitingNodeKeys: snapshot.waitingNodeIds.map(keyForId),
            schedulerStatus: snapshot.schedulerStatus,
            updatedAt: snapshot.updatedAt,
          },
          nodes: rows,
        }, null, 2))
        return
      }
      console.log(`\n📍 节点 (${rows.length}) · 当前: ${snapshot.currentNodeIds.map(keyForId).join(", ") || "无"}`)
      for (const row of rows) {
        const marker = row.current ? "▶" : row.ready ? "◇" : " "
        console.log(` ${marker} ${row.key.padEnd(40)} [${row.statusLabel}] ${row.name}`)
      }
      console.log()
    })

  node.command("show")
    .description("查看节点详情和运行历史")
    .argument("<nodeKey>", "英文节点 key")
    .argument("[projectId]", "项目 ID")
    .option("--json", "以 JSON 输出")
    .action((nodeKey: string, projectId: string | undefined, options: { json?: boolean }) => {
      const pid = resolveProjectId(engine, projectId)
      if (!pid) return
      const state = engine.getState(pid)
      const definition = state.projectRoot ? loadWorkflowDefinition(state.projectRoot) : definitionFromBuiltInSpec()
      const nodeId = resolveWorkflowNodeId(definition, nodeKey)
      const step = state.steps.find((candidate) => candidate.id === nodeId)
      if (!step) throw new Error(`节点尚未激活: ${nodeKey}`)
      const data = {
        projectId: pid,
        node: {
          key: nodeKey,
          phase: step.phase,
          name: step.name,
          description: step.description,
          responsibleRole: step.responsibleRole,
          status: step.status,
          dependsOn: step.dependsOn.map((dependencyId) => resolveWorkflowNodeKey(definition, dependencyId)),
          actions: step.actions,
          artifactIds: step.artifactIds,
          assignedTo: step.assignedTo,
          createdAt: step.createdAt,
          updatedAt: step.updatedAt,
          completedAt: step.completedAt,
          notes: step.notes,
          capabilityRuns: step.capabilityRuns,
        },
        runs: engine.execution.listRuns(pid, nodeId).map(({ nodeId: _nodeId, ...run }) => ({ ...run, nodeKey })),
      }
      if (options.json) {
        console.log(JSON.stringify(data, null, 2))
        return
      }
      console.log(`\n📌 ${nodeKey} ${step.name}`)
      console.log(`   状态: ${TASK_STATUS_LABELS[step.status]}`)
      console.log(`   依赖: ${data.node.dependsOn.join(", ") || "无"}`)
      console.log(`   运行次数: ${data.runs.length}`)
      if (state.projectRoot) console.log(`   工作目录: ${state.projectRoot}/workflow/nodes/${nodeKey}`)
      console.log()
    })

  node.command("run")
    .description("独立运行一个节点")
    .argument("<nodeKey>", "英文节点 key")
    .argument("[projectId]", "项目 ID")
    .option("--force", "忽略未完成依赖并记录审计")
    .option("--json", "以 JSON 输出")
    .action((nodeKey: string, projectId: string | undefined, options: { force?: boolean; json?: boolean }) => {
      try {
        const pid = resolveProjectId(engine, projectId)
        if (!pid) return
        const run = engine.runNode(pid, nodeKey, options.force === undefined ? {} : { force: options.force })
        const { nodeId: _nodeId, ...publicRun } = run
        if (options.json) console.log(JSON.stringify({ ...publicRun, nodeKey }, null, 2))
        else console.log(`✅ 节点 ${nodeKey} 已启动: ${run.id} (PID ${run.pid ?? "pending"})`)
      } catch (error) {
        console.error(`❌ 节点运行失败: ${(error as Error).message}`)
        process.exitCode = 1
      }
    })

  node.command("complete")
    .description("完成手动节点")
    .argument("<nodeKey>", "英文节点 key")
    .argument("[projectId]", "项目 ID")
    .option("--force", "忽略未完成依赖")
    .action((nodeKey: string, projectId: string | undefined, options: { force?: boolean }) => {
      try {
        const pid = resolveProjectId(engine, projectId)
        if (!pid) return
        engine.completeManualNode(pid, nodeKey, options.force === true)
        console.log(`✅ 手动节点 ${nodeKey} 已完成`)
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

function createNodeAction(options: CreateNodeOptions): NodeAction {
  const type = parseEnumValue(
    { MANUAL: "manual", COMMAND: "command", AI: "ai", HEINRICH: "heinrich" } as const,
    options.type,
    "动作类型",
  )
  if (type === "manual") {
    return options.instructions === undefined
      ? { type: "manual" }
      : { type: "manual", instructions: options.instructions }
  }
  if (type === "command") {
    if (!options.executable) throw new Error("command 动作必须提供 --executable")
    const timeoutMs = options.timeout === undefined ? undefined : parsePositiveInteger(options.timeout, "timeout")
    return {
      type: "command",
      executable: options.executable,
      ...(options.arg.length > 0 ? { args: options.arg } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }
  }
  if (type === "ai") {
    if (!options.assistant) throw new Error("ai 动作必须提供 --assistant")
    const assistant = parseEnumValue(AIAssistantType, options.assistant, "AI 助手")
    const ifExists = parseEnumValue(
      { OVERWRITE: "overwrite", EXTEND: "extend" } as const,
      options.ifExists,
      "AI 文件处理方式",
    )
    return {
      type: "ai",
      assistant,
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.output !== undefined ? { outputFile: options.output, ifExists } : {}),
    }
  }

  const delta = options.delta === undefined ? 1 : parsePositiveInteger(options.delta, "delta")
  const level = options.level === undefined
    ? undefined
    : parseEnumValue(HeinrichLevel, options.level, "Heinrich 等级")
  return {
    type: "heinrich",
    delta,
    ...(level !== undefined ? { level } : {}),
  }
}

function parseEnumValue<T extends string>(
  values: Readonly<Record<string, T>>,
  value: string,
  label: string,
): T {
  const allowed = Object.values(values)
  if (!allowed.includes(value as T)) throw new Error(`${label}无效: ${value}；可选值: ${allowed.join(", ")}`)
  return value as T
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} 必须是正整数`)
  return parsed
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
