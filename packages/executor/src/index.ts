/**
 * 节点后台执行器 —— 每次运行由独立 worker 进程承载。
 */

import { closeSync, existsSync, openSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { NodeRun } from "@octopus/core/execution.js"
import { createExecutionStore } from "@octopus/context/execution.js"

export interface WorkerLaunchOptions {
  readonly storeDir: string
  readonly requirementId: string
  readonly run: NodeRun
}

/** 启动脱离当前 CLI/Electron 生命周期的 worker。 */
export function launchWorker(options: WorkerLaunchOptions): number {
  const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url))
  if (!existsSync(workerPath)) throw new Error(`worker 未构建: ${workerPath}`)
  mkdirSync(dirname(options.run.stdoutPath), { recursive: true })
  mkdirSync(dirname(options.run.stderrPath), { recursive: true })
  const stdout = openSync(options.run.stdoutPath, "a")
  const stderr = openSync(options.run.stderrPath, "a")
  const child = spawn(process.execPath, [workerPath, "--store-dir", options.storeDir, "--requirement-id", options.requirementId, "--run-id", options.run.id], {
    detached: true,
    stdio: ["ignore", stdout, stderr],
    env: { ...process.env, OCTOPUS_WORKER: "1" },
  })
  closeSync(stdout)
  closeSync(stderr)
  child.unref()
  if (!child.pid) throw new Error("无法启动节点 worker")
  createExecutionStore(options.storeDir).updateRun(options.run.id, {
    pid: child.pid,
    heartbeatAt: new Date().toISOString(),
  })
  return child.pid
}

/** 终止 worker 进程组，避免命令留下孤儿子进程。 */
export function terminateWorker(run: NodeRun): void {
  if (!run.pid) throw new Error(`运行 ${run.id} 没有进程号`)
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(run.pid), "/t", "/f"], { stdio: "ignore" })
      return
    }
    process.kill(-run.pid, "SIGTERM")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
  }
}
