/**
 * 后台节点 worker 入口。
 *
 * worker 不依赖 CLI/Electron，直接读取 SQLite、执行节点动作并写入运行事件，
 * 因此启动端退出后任务仍可继续执行。
 */

import { closeSync, openSync, mkdirSync } from "node:fs"
import { spawn } from "node:child_process"
import { loadConfig } from "@octopus/context/config.js"
import { createStateStore, loadWorkflowDefinition, syncWorkflowWorkspace } from "@octopus/context/index.js"
import { resolveWorkflowNodeKey } from "@octopus/context/workflow.js"
import { createExecutionStore } from "@octopus/context/execution.js"
import type { NodeAction, NodeRunStatus, WorkflowEvent } from "@octopus/core/execution.js"
import { TaskStatus } from "@octopus/core/task.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { ObservationId } from "@octopus/core/branded-ids.js"
import { createAIClient } from "@octopus/agent-layer/index.js"
import { prepareAIOutput, writeAIOutput } from "./ai-output.js"

interface WorkerArgs {
  storeDir: string
  projectId: string
  runId: string
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const executionStore = createExecutionStore(args.storeDir)
  const stateStore = createStateStore({ storeDir: args.storeDir })
  const run = executionStore.getRun(args.runId)
  if (!run) throw new Error(`运行不存在: ${args.runId}`)
  const state = stateStore.load(args.projectId)
  const step = state.steps.find((candidate) => candidate.id === run.nodeId)
  if (!step) throw new Error(`节点不存在: ${run.nodeId}`)

  const projectRoot = state.projectRoot ?? process.cwd()
  const definition = loadWorkflowDefinition(projectRoot)
  const workspace = syncWorkflowWorkspace(projectRoot, definition)
  const nodePath = workspace.nodePath(resolveWorkflowNodeKey(definition, step.id))
  const config = loadConfig(args.storeDir)
  const actions = step.actions ?? [{ type: "manual" as const }]
  const heartbeat = setInterval(() => {
    const active = executionStore.getRun(args.runId)
    if (!active || active.status !== "RUNNING") return
    executionStore.updateRun(args.runId, { heartbeatAt: new Date().toISOString() })
  }, 2_000)

  let child: ReturnType<typeof spawn> | undefined
  let cancelled = false
  const cancel = (): void => {
    cancelled = true
    if (child && !child.killed) child.kill("SIGTERM")
  }
  process.once("SIGTERM", cancel)
  process.once("SIGINT", cancel)

  try {
    const started = executionStore.transitionRun(args.runId, ["QUEUED", "RUNNING"], {
      status: "RUNNING",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    })
    if (!started) return
    appendEvent(executionStore, args, "RUN_STARTED", { pid: process.pid, nodePath })
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index]
      if (!action) continue
      if (cancelled) throw new WorkerFailure("CANCELED", "运行已取消")
      executionStore.updateRun(args.runId, { currentAction: index, heartbeatAt: new Date().toISOString() })
      appendEvent(executionStore, args, "ACTION_STARTED", { index, type: action.type })
      const result = await executeAction(action, {
        args,
        nodePath,
        stateStore,
        stateProjectId: args.projectId,
        config,
        projectRoot,
        fallbackAIInput: `${step.name}：${step.description}`,
        stdoutPath: run.stdoutPath,
        stderrPath: run.stderrPath,
        assignChild: (processHandle) => { child = processHandle },
      })
      appendEvent(executionStore, args, "ACTION_FINISHED", { index, type: action.type, ...result })
    }
    const succeeded = executionStore.transitionRun(args.runId, ["RUNNING"], {
      status: "SUCCEEDED",
      finishedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    })
    if (!succeeded) return
    try {
      stateStore.update(args.projectId, (current) => {
        const target = current.steps.find((candidate) => candidate.id === run.nodeId)
        if (target) {
          target.status = TaskStatus.COMPLETED
          target.completedAt = new Date().toISOString()
          target.updatedAt = new Date().toISOString()
        }
        return current
      })
    } catch (cause) {
      const error = `运行结果写入项目状态失败: ${(cause as Error).message}`
      const failed = executionStore.transitionRun(args.runId, ["SUCCEEDED"], {
        status: "FAILED",
        error,
      })
      if (failed) appendEvent(executionStore, args, "RUN_FAILED", { status: "FAILED", error })
      process.exitCode = 1
      return
    }
    appendEvent(executionStore, args, "RUN_FINISHED", { status: "SUCCEEDED" })
  } catch (cause) {
    const currentRun = executionStore.getRun(args.runId)
    if (currentRun && currentRun.status !== "QUEUED" && currentRun.status !== "RUNNING") return
    const failure = cause instanceof WorkerFailure ? cause : new WorkerFailure("FAILED", (cause as Error).message)
    const status: NodeRunStatus = failure.status
    const failed = executionStore.transitionRun(args.runId, ["QUEUED", "RUNNING"], {
      status,
      finishedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      error: failure.message,
    })
    if (!failed) return
    stateStore.update(args.projectId, (current) => {
      const target = current.steps.find((candidate) => candidate.id === run.nodeId)
      if (target) {
        target.status = status === "CANCELED" ? TaskStatus.BLOCKED : TaskStatus.BLOCKED
        target.updatedAt = new Date().toISOString()
        target.notes = failure.message
      }
      return current
    })
    appendEvent(executionStore, args, status === "CANCELED" ? "RUN_CANCELED" : "RUN_FAILED", { status, error: failure.message })
    process.exitCode = 1
  } finally {
    clearInterval(heartbeat)
  }
}

interface ActionContext {
  args: WorkerArgs
  nodePath: string
  stateStore: ReturnType<typeof createStateStore>
  stateProjectId: string
  config: ReturnType<typeof loadConfig>
  projectRoot: string
  fallbackAIInput: string
  stdoutPath: string
  stderrPath: string
  assignChild: (child: ReturnType<typeof spawn>) => void
}

async function executeAction(
  action: NodeAction,
  context: ActionContext,
): Promise<Record<string, unknown>> {
  if (action.type === "manual") throw new WorkerFailure("FAILED", action.instructions ?? "手动节点不能由 worker 执行")
  if (action.type === "command") {
    await executeCommand(action, context)
    return {}
  }
  if (action.type === "ai") {
    const prepared = prepareAIOutput(action, context.nodePath, context.fallbackAIInput)
    const client = createAIClient(context.config.ai)
    const response = await client.callAssistant(action.assistant, prepared.input)
    if (prepared.outputPath) writeAIOutput(prepared.outputPath, response.result)
    return {
      summary: response.result.slice(0, 500),
      ...(action.outputFile !== undefined ? { outputFile: action.outputFile } : {}),
      extended: prepared.extended,
    }
  }
  if (action.type === "heinrich") {
    context.stateStore.update(context.stateProjectId, (state) => {
      state.heinrich.triggerCounts[state.currentPhase] = (state.heinrich.triggerCounts[state.currentPhase] ?? 0) + action.delta
      state.heinrich.observations.push({
        id: ObservationId(`obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        phase: state.currentPhase,
        level: action.level ?? HeinrichLevel.TRIVIAL,
        description: `节点 ${context.args.runId} Heinrich +${action.delta}`,
        notedAt: new Date().toISOString(),
      })
      return state
    })
    return {}
  }
  throw new WorkerFailure("FAILED", `未注册集成动作: ${action.service}.${action.operation}`)
}

function executeCommand(
  action: Extract<NodeAction, { type: "command" }>,
  context: ActionContext,
): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(context.nodePath, { recursive: true })
    const stdout = openSync(context.stdoutPath, "a")
    const stderr = openSync(context.stderrPath, "a")
    const child = spawn(action.executable, action.args ?? [], {
      cwd: context.nodePath,
      env: {
        ...process.env,
        ...action.env,
        OCTOPUS_PROJECT_ROOT: context.projectRoot,
        OCTOPUS_SHARED_DIR: context.projectRoot + "/workflow/shared",
        OCTOPUS_SHARED_READ_ONLY: "1",
        OCTOPUS_NODE_DIR: context.nodePath,
        OCTOPUS_RUN_ID: context.args.runId,
      },
      shell: false,
      stdio: ["ignore", stdout, stderr],
    })
    closeSync(stdout)
    closeSync(stderr)
    context.assignChild(child)
    let timer: NodeJS.Timeout | undefined
    if (action.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGTERM")
        reject(new WorkerFailure("TIMED_OUT", `命令超时（${action.timeoutMs}ms）`))
      }, action.timeoutMs)
    }
    child.once("error", (error) => {
      if (timer) clearTimeout(timer)
      reject(new WorkerFailure("FAILED", error.message))
    })
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer)
      if (signal) reject(new WorkerFailure(signal === "SIGTERM" ? "CANCELED" : "FAILED", `命令被信号 ${signal} 终止`))
      else if (code !== 0) reject(new WorkerFailure("FAILED", `命令退出码 ${code ?? "unknown"}`))
      else resolve()
    })
  })
}

function appendEvent(
  store: ReturnType<typeof createExecutionStore>,
  args: WorkerArgs,
  type: WorkflowEvent["type"],
  payload: Record<string, unknown>,
): void {
  store.appendEvent({
    projectId: args.projectId,
    runId: args.runId,
    type,
    payload,
    createdAt: new Date().toISOString(),
  })
}

function parseArgs(argv: string[]): WorkerArgs {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key && value) values.set(key, value)
  }
  const storeDir = values.get("--store-dir")
  const projectId = values.get("--project-id")
  const runId = values.get("--run-id")
  if (!storeDir || !projectId || !runId) throw new Error("worker 参数不完整")
  return { storeDir, projectId, runId }
}

class WorkerFailure extends Error {
  constructor(public readonly status: Extract<NodeRunStatus, "FAILED" | "CANCELED" | "TIMED_OUT">, message: string) {
    super(message)
  }
}

void main().catch((error) => {
  console.error(error)
  try {
    const args = parseArgs(process.argv.slice(2))
    const store = createExecutionStore(args.storeDir)
    const run = store.getRun(args.runId)
    if (run && (run.status === "QUEUED" || run.status === "RUNNING")) {
      const failed = store.transitionRun(args.runId, ["QUEUED", "RUNNING"], {
        status: "FAILED",
        finishedAt: new Date().toISOString(),
        error: (error as Error).message,
      })
      if (failed) appendEvent(store, args, "RUN_FAILED", { error: (error as Error).message })
    }
  } catch {
    // 启动参数或存储本身损坏时无法再写入运行记录，只保留进程错误输出。
  }
  process.exitCode = 1
})
