/**
 * 后台节点 worker 入口。
 *
 * worker 不依赖 CLI/Electron，使用本地 SQLite 执行节点动作并写入运行事件，
 * 因此启动端退出后任务仍可继续执行。
 */

import { closeSync, openSync, mkdirSync } from "node:fs"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { loadConfig } from "@octopus/context/config.js"
import {
  createPersistenceStore,
  syncWorkflowWorkspace,
  type PersistenceStore,
} from "@octopus/context/index.js"
import {
  loadResolvedWorkflowDefinition,
  loadWorkflowPluginRefs,
  resolveWorkflowNodeKey,
} from "@octopus/context/workflow.js"
import type { NodeAction, NodeRunStatus, WorkflowEvent } from "@octopus/core/execution.js"
import type { StepRuntime } from "@octopus/core/step.js"
import { TaskStatus } from "@octopus/core/task.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { ObservationId } from "@octopus/core/branded-ids.js"
import { createAIClient } from "@octopus/agent-layer/index.js"
import type { PluginHost } from "@octopus/plugin/index.js"
import { loadPlugins } from "@octopus/plugin/index.js"
import { prepareAIOutput, writeAIOutput } from "./ai-output.js"

export interface WorkerArgs {
  storeDir: string
  requirementId: string
  runId: string
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const store = await createPersistenceStore({ storeDir: args.storeDir })
  const executionStore = store
  const stateStore = store
  const run = await executionStore.getRun(args.runId)
  if (!run) throw new Error(`运行不存在: ${args.runId}`)
  const state = await stateStore.load(args.requirementId)
  const step = state.steps.find((candidate) => candidate.id === run.nodeId)
  if (!step) throw new Error(`节点不存在: ${run.nodeId}`)

  const projectRoot = state.projectRoot ?? process.cwd()
  const config = loadConfig(args.storeDir)
  const pluginHost = await loadPlugins(
    [...loadWorkflowPluginRefs(projectRoot), ...config.plugins],
    { projectRoot },
  )
  const definition = loadResolvedWorkflowDefinition(projectRoot, pluginHost.overlays)
  const workspace = syncWorkflowWorkspace(projectRoot, definition)
  const nodePath = workspace.nodePath(resolveWorkflowNodeKey(definition, step.id))
  const actions = step.actions ?? [{ type: "manual" as const }]
  let heartbeatRunning = false
  const heartbeat = setInterval(() => {
    if (heartbeatRunning) return
    heartbeatRunning = true
    void (async () => {
      const active = await executionStore.getRun(args.runId)
      if (active?.status === "RUNNING") {
        await executionStore.updateRun(args.runId, { heartbeatAt: new Date().toISOString() })
      }
    })()
      .catch((cause) => {
        console.error(`心跳写入失败: ${(cause as Error).message}`)
      })
      .finally(() => {
        heartbeatRunning = false
      })
  }, 2_000)

  let child: ReturnType<typeof spawn> | undefined
  let cancelled = false
  const interrupt = (): void => {
    cancelled = true
    killProcessGroup(child)
    void markInterruptedRun(executionStore, stateStore, args, run.nodeId).catch((cause) => {
      console.error(`中断落账失败: ${(cause as Error).message}`)
      process.exitCode = 1
    })
  }
  // SIGTERM/SIGINT 均可触发取消；handler 幂等，重复触发安全。
  process.on("SIGTERM", interrupt)
  process.on("SIGINT", interrupt)

  try {
    const started = await executionStore.transitionRun(args.runId, ["QUEUED", "RUNNING"], {
      status: "RUNNING",
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    })
    if (!started) return
    await appendEvent(executionStore, args, "RUN_STARTED", { pid: process.pid, nodePath })
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index]
      if (!action) continue
      if (cancelled) throw new WorkerFailure("CANCELED", "运行已取消")
      await executionStore.updateRun(args.runId, {
        currentAction: index,
        heartbeatAt: new Date().toISOString(),
      })
      await appendEvent(executionStore, args, "ACTION_STARTED", { index, type: action.type })
      const result = await executeAction(action, {
        args,
        nodePath,
        stateStore,
        stateRequirementId: args.requirementId,
        config,
        projectRoot,
        fallbackAIInput: `${step.name}：${step.description}`,
        stdoutPath: run.stdoutPath,
        stderrPath: run.stderrPath,
        pluginHost,
        step,
        isCancelled: () => cancelled,
        assignChild: (processHandle) => {
          child = processHandle
        },
      })
      if (cancelled) throw new WorkerFailure("CANCELED", "运行已取消")
      await appendEvent(executionStore, args, "ACTION_FINISHED", {
        index,
        type: action.type,
        ...result,
      })
    }
    const succeeded = await executionStore.transitionRun(args.runId, ["RUNNING"], {
      status: "SUCCEEDED",
      finishedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    })
    if (!succeeded) return
    try {
      await stateStore.update(args.requirementId, (current) => {
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
      const failed = await executionStore.transitionRun(args.runId, ["SUCCEEDED"], {
        status: "FAILED",
        error,
      })
      if (failed) await appendEvent(executionStore, args, "RUN_FAILED", { status: "FAILED", error })
      process.exitCode = 1
      return
    }
    await appendEvent(executionStore, args, "RUN_FINISHED", { status: "SUCCEEDED" })
  } catch (cause) {
    const currentRun = await executionStore.getRun(args.runId)
    if (currentRun && currentRun.status !== "QUEUED" && currentRun.status !== "RUNNING") return
    const failure =
      cause instanceof WorkerFailure ? cause : new WorkerFailure("FAILED", (cause as Error).message)
    const status: NodeRunStatus = failure.status
    const failed = await executionStore.transitionRun(args.runId, ["QUEUED", "RUNNING"], {
      status,
      finishedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      error: failure.message,
    })
    if (!failed) return
    await stateStore.update(args.requirementId, (current) => {
      const target = current.steps.find((candidate) => candidate.id === run.nodeId)
      if (target) {
        // 任务状态模型只有 BLOCKED 作为失败落点：CANCELED/FAILED/TIMED_OUT/INTERRUPTED 统一归入。
        target.status = TaskStatus.BLOCKED
        target.updatedAt = new Date().toISOString()
        target.notes = failure.message
      }
      return current
    })
    await appendEvent(executionStore, args, status === "CANCELED" ? "RUN_CANCELED" : "RUN_FAILED", {
      status,
      error: failure.message,
    })
    process.exitCode = 1
  } finally {
    clearInterval(heartbeat)
    await store.close()
  }
}

export interface ActionContext {
  args: WorkerArgs
  nodePath: string
  stateStore: PersistenceStore
  stateRequirementId: string
  config: ReturnType<typeof loadConfig>
  projectRoot: string
  fallbackAIInput: string
  stdoutPath: string
  stderrPath: string
  pluginHost: PluginHost
  step: StepRuntime
  isCancelled: () => boolean
  assignChild: (child: ReturnType<typeof spawn>) => void
}

export async function executeAction(
  action: NodeAction,
  context: ActionContext,
): Promise<Record<string, unknown>> {
  if (action.type === "manual")
    throw new WorkerFailure("FAILED", action.instructions ?? "手动节点不能由 worker 执行")
  if (action.type === "command") {
    await executeCommand(action, context)
    return {}
  }
  if (action.type === "ai") {
    if (context.isCancelled()) throw new WorkerFailure("CANCELED", "运行已取消")
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
    const phase = context.step.phase
    await context.stateStore.update(context.stateRequirementId, (state) => {
      state.heinrich.triggerCounts[phase] =
        (state.heinrich.triggerCounts[phase] ?? 0) + action.delta
      state.heinrich.observations.push({
        id: ObservationId(`obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        phase,
        level: action.level ?? HeinrichLevel.TRIVIAL,
        description: `节点 ${context.args.runId} Heinrich +${action.delta}`,
        notedAt: new Date().toISOString(),
      })
      return state
    })
    return {}
  }
  if (action.type === "integration") {
    const service = context.pluginHost.integrations[action.service]
    if (!service) throw new WorkerFailure("FAILED", `未注册集成: ${action.service}`)
    const fn = (service as unknown as Record<string, unknown>)[action.operation]
    if (typeof fn !== "function") {
      throw new WorkerFailure("FAILED", `集成无操作: ${action.operation}`)
    }
    try {
      const out = await (fn as (...args: unknown[]) => unknown).call(service, action.input)
      return { summary: JSON.stringify(out ?? {}).slice(0, 500) }
    } catch (cause) {
      throw new WorkerFailure("FAILED", (cause as Error).message)
    }
  }
  if (action.type === "custom") {
    const handler = context.pluginHost.customHandlers.get(action.name)
    if (!handler) throw new WorkerFailure("FAILED", `未注册自定义能力: ${action.name}`)
    const state = await context.stateStore.load(context.stateRequirementId)
    const step = state.steps.find((candidate) => candidate.id === context.step.id) ?? context.step
    const result = await handler(
      action.input === undefined
        ? { kind: "custom", name: action.name }
        : { kind: "custom", name: action.name, input: action.input },
      {
        state,
        step,
        integrations: { ...context.pluginHost.integrations },
      },
    )
    await context.stateStore.save(state)
    if (!result.ok)
      throw new WorkerFailure("FAILED", result.summary ?? `自定义能力失败: ${action.name}`)
    return { summary: result.summary ?? "" }
  }
  throw new WorkerFailure("FAILED", `未知动作类型: ${(action as NodeAction).type}`)
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
      // 让命令成为独立进程组首领，超时/取消可对整个进程组（含孙进程）发送信号。
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
    })
    closeSync(stdout)
    closeSync(stderr)
    context.assignChild(child)
    let timer: NodeJS.Timeout | undefined
    if (action.timeoutMs) {
      timer = setTimeout(() => {
        killProcessGroup(child)
        reject(new WorkerFailure("TIMED_OUT", `命令超时（${action.timeoutMs}ms）`))
      }, action.timeoutMs)
    }
    child.once("error", (error) => {
      if (timer) clearTimeout(timer)
      reject(new WorkerFailure("FAILED", error.message))
    })
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer)
      if (signal)
        reject(
          new WorkerFailure(
            signal === "SIGTERM" ? "CANCELED" : "FAILED",
            `命令被信号 ${signal} 终止`,
          ),
        )
      else if (code !== 0) reject(new WorkerFailure("FAILED", `命令退出码 ${code ?? "unknown"}`))
      else resolve()
    })
  })
}

async function appendEvent(
  store: PersistenceStore,
  args: WorkerArgs,
  type: WorkflowEvent["type"],
  payload: Record<string, unknown>,
): Promise<void> {
  await store.appendEvent({
    requirementId: args.requirementId,
    runId: args.runId,
    type,
    payload,
    createdAt: new Date().toISOString(),
  })
}

export function parseArgs(argv: string[]): WorkerArgs {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === undefined) continue
    if (!token.startsWith("--")) throw new Error(`worker 参数无效: ${token}`)
    const equalsIndex = token.indexOf("=")
    if (equalsIndex !== -1) {
      const key = token.slice(0, equalsIndex)
      const value = unquote(token.slice(equalsIndex + 1))
      if (key === "--" || value === "") throw new Error(`worker 参数无效: ${token}`)
      values.set(key, value)
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      values.set(token, unquote(next))
      index++
    } else {
      values.set(token, "true")
    }
  }
  const storeDir = values.get("--store-dir")
  const requirementId = values.get("--requirement-id")
  const runId = values.get("--run-id")
  if (!storeDir) throw new Error("worker 缺少必需参数 --store-dir")
  if (!requirementId) throw new Error("worker 缺少必需参数 --requirement-id")
  if (!runId) throw new Error("worker 缺少必需参数 --run-id")
  return { storeDir, requirementId, runId }
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * 外部信号中断落账：把运行置为 INTERRUPTED，步骤置 BLOCKED，exit code 1。
 * run 已通过正常路径转为终态（尤其 CANCELED）时直接返回，不覆盖已有结果。
 */
export async function markInterruptedRun(
  executionStore: PersistenceStore,
  stateStore: PersistenceStore,
  args: WorkerArgs,
  nodeId: string,
): Promise<void> {
  const currentRun = await executionStore.getRun(args.runId)
  if (!currentRun || (currentRun.status !== "QUEUED" && currentRun.status !== "RUNNING")) return
  const interrupted = await executionStore.transitionRun(args.runId, ["QUEUED", "RUNNING"], {
    status: "INTERRUPTED",
    finishedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    error: "运行被外部信号中断",
  })
  if (!interrupted) return
  await stateStore.update(args.requirementId, (current) => {
    const target = current.steps.find((candidate) => candidate.id === nodeId)
    if (target) {
      target.status = TaskStatus.BLOCKED
      target.updatedAt = new Date().toISOString()
      target.notes = "运行被外部信号中断"
    }
    return current
  })
  await appendEvent(executionStore, args, "RUN_FAILED", {
    status: "INTERRUPTED",
    error: "运行被外部信号中断",
  })
  process.exitCode = 1
}

/** 终止命令进程组；win32 无法使用负 PID，退回单进程 kill。 */
function killProcessGroup(processHandle: ReturnType<typeof spawn> | undefined): void {
  if (!processHandle || processHandle.killed) return
  if (process.platform === "win32") {
    processHandle.kill("SIGTERM")
    return
  }
  if (processHandle.pid === undefined) return
  try {
    process.kill(-processHandle.pid, "SIGTERM")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
  }
}

export class WorkerFailure extends Error {
  constructor(
    public readonly status: Extract<NodeRunStatus, "FAILED" | "CANCELED" | "TIMED_OUT">,
    message: string,
  ) {
    super(message)
  }
}

const entryFile = process.argv[1]
if (entryFile !== undefined && pathToFileURL(entryFile).href === import.meta.url) {
  void main().catch(async (error) => {
    console.error(error)
    try {
      const args = parseArgs(process.argv.slice(2))
      const store = await createPersistenceStore({ storeDir: args.storeDir })
      const run = await store.getRun(args.runId)
      if (run && (run.status === "QUEUED" || run.status === "RUNNING")) {
        const failed = await store.transitionRun(args.runId, ["QUEUED", "RUNNING"], {
          status: "FAILED",
          finishedAt: new Date().toISOString(),
          error: (error as Error).message,
        })
        if (failed)
          await appendEvent(store, args, "RUN_FAILED", { error: (error as Error).message })
      }
      await store.close()
    } catch {
      // 启动参数或存储本身损坏时无法再写入运行记录，只保留进程错误输出。
    }
    process.exitCode = 1
  })
}
