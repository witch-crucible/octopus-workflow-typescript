import { spawn } from "node:child_process"
import type { CodeReviewAgent } from "@octopus/core/agent.js"

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024

/** 单个交叉代码审查工具的执行结果。 */
export interface CodeReviewResult {
  readonly agent: CodeReviewAgent
  readonly ok: boolean
  readonly output: string
  readonly error?: string
  readonly durationMs: number
}

/** 多个审查工具的汇总结果。 */
export interface CrossCodeReviewResponse {
  readonly result: string
  readonly reviews: readonly CodeReviewResult[]
  readonly successCount: number
  readonly durationMs: number
}

export interface CrossReviewConfig {
  readonly defaultTimeout: number
  readonly ocrPath: string
  readonly commandCodePath: string
  readonly codexPath: string
  readonly retries: number
  readonly retryDelay: number
}

export interface CrossReviewOptions {
  readonly signal?: AbortSignal
  readonly excludedPaths?: readonly string[]
}

interface ReviewCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly stdin: string
}

class ReviewCommandError extends Error {
  constructor(message: string, readonly output: string) {
    super(message)
  }
}

/** 并行调用配置的多个代码审查工具；单一工具失败会被记录，而不会中断其他审查。 */
export async function crossReviewCode(
  config: CrossReviewConfig,
  input: string,
  repositoryPath: string,
  reviewers: readonly CodeReviewAgent[],
  options: CrossReviewOptions = {},
): Promise<CrossCodeReviewResponse> {
  validateConfig(config)
  const startedAt = Date.now()
  const reviews = await Promise.all(
    reviewers.map((agent) => reviewWithRetries(config, agent, input, repositoryPath, options)),
  )

  return {
    result: aggregateReviews(reviews),
    reviews,
    successCount: reviews.filter((review) => review.ok).length,
    durationMs: Date.now() - startedAt,
  }
}

function validateConfig(config: CrossReviewConfig): void {
  if (!Number.isSafeInteger(config.defaultTimeout) || config.defaultTimeout < 0 || config.defaultTimeout > 2_147_483_647) {
    throw new Error("AI 调用超时必须是 0 至 2147483647ms 的整数")
  }
  if (!Number.isSafeInteger(config.retryDelay) || config.retryDelay < 0 || config.retryDelay > 2_147_483_647) {
    throw new Error("AI 重试间隔必须是 0 至 2147483647ms 的整数")
  }
  if (!Number.isSafeInteger(config.retries) || config.retries < 0) {
    throw new Error("AI 重试次数必须是非负整数")
  }
  if (config.retryDelay * Math.max(1, config.retries) > 2_147_483_647) {
    throw new Error("AI 重试退避时间超过 Node 定时器上限")
  }
}

async function reviewWithRetries(
  config: CrossReviewConfig,
  agent: CodeReviewAgent,
  input: string,
  repositoryPath: string,
  options: CrossReviewOptions,
): Promise<CodeReviewResult> {
  const startedAt = Date.now()
  let lastError: unknown
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (options.signal?.aborted) {
      lastError = new Error(`${agent} 调用已取消`)
      break
    }
    try {
      const output = await executeReviewCommand(
        createCommand(config, agent, input, repositoryPath, options.excludedPaths ?? []),
        config.defaultTimeout,
        agent,
        options.signal,
      )
      return { agent, ok: true, output, durationMs: Date.now() - startedAt }
    } catch (error) {
      lastError = error
      if (attempt < config.retries && !options.signal?.aborted) {
        await sleep(config.retryDelay * (attempt + 1), options.signal)
      }
    }
  }

  return {
    agent,
    ok: false,
    output: lastError instanceof ReviewCommandError ? lastError.output : "",
    error: lastError instanceof Error ? lastError.message : String(lastError),
    durationMs: Date.now() - startedAt,
  }
}

function createCommand(
  config: CrossReviewConfig,
  agent: CodeReviewAgent,
  input: string,
  repositoryPath: string,
  excludedPaths: readonly string[],
): ReviewCommand {
  const reviewInput = appendExcludedPaths(input, excludedPaths)
  switch (agent) {
    case "ocr":
      return {
        executable: config.ocrPath,
        args: [
          "review",
          "--repo",
          repositoryPath,
          "--audience",
          "agent",
          "--format",
          "text",
          "--background",
          reviewInput,
          ...(excludedPaths.length > 0 ? ["--exclude", excludedPaths.join(",")] : []),
        ],
        stdin: "",
      }
    case "commandcode":
      return {
        executable: config.commandCodePath,
        args: ["--no-session", "--skip-onboarding", "--permission-mode", "plan", "--print", reviewInput],
        cwd: repositoryPath,
        stdin: "",
      }
    case "codex":
      return {
        executable: config.codexPath,
        args: ["review", "--uncommitted", "-"],
        cwd: repositoryPath,
        stdin: reviewInput,
      }
    default:
      throw new Error(`不支持的代码审查工具: ${agent}`)
  }
}

function executeReviewCommand(
  command: ReviewCommand,
  timeout: number,
  agent: CodeReviewAgent,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutLength = 0
    let stderrLength = 0
    let settled = false
    let terminationError: Error | undefined
    let timer: NodeJS.Timeout | undefined
    let forceSettleTimer: NodeJS.Timeout | undefined
    let closeCode: number | null | undefined
    let closeSignal: NodeJS.Signals | null | undefined
    let stdoutEnded = false
    const onAbort = (): void => terminate(new Error(`${agent} 调用已取消`))
    const finish = (error?: Error, output?: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (forceSettleTimer) clearTimeout(forceSettleTimer)
      signal?.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve(output ?? "")
    }
    const append = (chunks: Buffer[], chunk: Buffer, currentLength: number): number => {
      const nextLength = currentLength + chunk.length
      if (nextLength > MAX_OUTPUT_BYTES) {
        if (!terminationError) terminate(new Error(`${agent} 输出超过 ${MAX_OUTPUT_BYTES} 字节`))
        return currentLength
      }
      chunks.push(chunk)
      return nextLength
    }
    const finishAfterOutput = (): void => {
      if (closeCode === undefined || !stdoutEnded) return
      if (terminationError) {
        finish(new ReviewCommandError(terminationError.message, Buffer.concat(stdout).toString("utf-8")))
        return
      }
      const output = Buffer.concat(stdout).toString("utf-8")
      if (closeCode === 0) {
        finish(undefined, output)
        return
      }
      const detail = Buffer.concat(stderr).toString("utf-8").trim()
      finish(new ReviewCommandError(
        `${agent} 退出失败（${closeSignal ?? closeCode ?? "unknown"}）${detail ? `: ${detail}` : ""}`,
        output,
      ))
    }
    const terminate = (error: Error): void => {
      if (terminationError) return
      terminationError = error
      terminateProcessTree(child)
      forceSettleTimer = setTimeout(() => {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
        finish(new ReviewCommandError(
          terminationError?.message ?? error.message,
          Buffer.concat(stdout).toString("utf-8"),
        ))
      }, 100)
    }
    if (timeout > 0) {
      timer = setTimeout(() => terminate(new Error(`${agent} 调用超时（${timeout}ms）`)), timeout)
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLength = append(stdout, chunk, stdoutLength)
    })
    child.stdout.once("end", () => {
      stdoutEnded = true
      finishAfterOutput()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderrLength = append(stderr, chunk, stderrLength)
    })
    child.once("error", (error) => finish(error))
    child.once("spawn", () => {
      if (!terminationError) child.stdin.end(command.stdin)
    })
    child.once("close", (code, signal) => {
      closeCode = code
      closeSignal = signal
      finishAfterOutput()
    })
    child.stdin.once("error", (error) => finish(error))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function aggregateReviews(reviews: readonly CodeReviewResult[]): string {
  return [
    "# Cross Code Review",
    ...reviews.map((review) => {
      if (review.ok) return `## ${review.agent}\n\n${review.output}`
      const partial = review.output.trim() === "" ? "" : `\n\nPartial output:\n\n${review.output}`
      return `## ${review.agent}\n\nError: ${review.error ?? "unknown error"}${partial}`
    }),
  ].join("\n\n")
}

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) {
    child.kill("SIGKILL")
    return
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL")
  }
}

function appendExcludedPaths(input: string, excludedPaths: readonly string[]): string {
  if (excludedPaths.length === 0) return input
  return [
    input,
    "",
    "Do not review these generated report paths:",
    ...excludedPaths.map((path) => `- ${path}`),
  ].join("\n")
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
