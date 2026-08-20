/**
 * 浏览器客户端服务 —— 复用 Electron renderer 与真实工作流引擎。
 *
 * 仅监听本机回环地址，页面通过同源 JSON API 访问经过白名单限制的引擎能力。
 */

import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { getIdentity, loadConfig, saveIdentity } from "@octopus/context/config.js"
import { getWorkflowWorkspace } from "@octopus/context/workflow.js"
import { createWorkflowEngineFromConfig } from "@octopus/workflow-engine/index.js"

const execFileAsync = promisify(execFile)

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(moduleDirectory, "../../..")

interface WebRequest {
  readonly method?: unknown
  readonly args?: unknown
}

export interface OctopusWebServerOptions {
  readonly host?: string
  readonly port?: number
  readonly storeDir?: string
  readonly rendererDir?: string
  readonly projectRoot?: string
}

export interface OctopusWebServer {
  readonly url: string
  listen(): Promise<string>
  close(): Promise<void>
}

class WebError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  response.end(JSON.stringify(value))
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WebError(400, `${name} 必须是非空字符串`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function findListenerPid(host: string, port: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      `-iTCP@${host}:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ], { encoding: "utf-8" })
    const pid = Number.parseInt(stdout.trim().split(/\n/, 1)[0] ?? "", 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

async function processCommand(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
    })
    const command = stdout.trim()
    return command === "" ? undefined : command
  } catch {
    return undefined
  }
}

async function isOctopusWebServer(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${host}:${port}/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "listProjects", args: [] }),
      signal: AbortSignal.timeout(800),
    })
    if (!response.ok) return false
    const body = await response.json() as { result?: unknown }
    return Array.isArray(body.result)
  } catch {
    return false
  }
}

function terminatePid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

async function waitUntilPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await sleep(40)
  }
  return false
}

/** 结束占用该端口的上一份 Octopus Web；端口空闲则返回 false。非本服务占用时抛错。 */
export async function stopExistingOctopusWeb(host: string, port: number): Promise<boolean> {
  const pid = await findListenerPid(host, port)
  if (pid === undefined || pid === process.pid) return false

  const command = await processCommand(pid)
  const ours = await isOctopusWebServer(host, port) || Boolean(command?.includes("dist/web.js"))
  if (!ours) {
    const occupant = command ? `${pid}（${command}）` : String(pid)
    throw new Error(`${host}:${port} 已被进程 ${occupant} 占用，可设置 OCTOPUS_WEB_PORT 换端口，或结束该进程后重试`)
  }

  terminatePid(pid, "SIGTERM")
  if (!await waitUntilPidGone(pid, 2000)) {
    terminatePid(pid, "SIGKILL")
    await waitUntilPidGone(pid, 1000)
  }

  const remaining = await findListenerPid(host, port)
  if (remaining !== undefined) {
    throw new Error(`无法释放 ${host}:${port}（仍被进程 ${remaining} 占用）`)
  }
  return true
}

async function readRequest(request: IncomingMessage): Promise<WebRequest> {
  if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
    throw new WebError(415, "请求必须使用 application/json")
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > 1_048_576) throw new WebError(413, "请求内容超过 1 MiB")
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as WebRequest
  } catch {
    throw new WebError(400, "请求 JSON 无效")
  }
}

export async function createOctopusWebServer(options: OctopusWebServerOptions = {}): Promise<OctopusWebServer> {
  const host = options.host ?? "127.0.0.1"
  const requestedPort = options.port ?? 4173
  const storeDir = resolve(options.storeDir ?? process.env["OCTOPUS_STORE_DIR"] ?? join(repositoryRoot, ".octo"))
  const rendererDir = resolve(options.rendererDir ?? join(moduleDirectory, "..", "src", "renderer"))
  const defaultProjectRoot = resolve(options.projectRoot ?? repositoryRoot)
  const config = { ...loadConfig(storeDir), storeDir }
  const engine = await createWorkflowEngineFromConfig(config, { projectRoot: defaultProjectRoot })

  const invoke = async (method: string, args: unknown[]): Promise<unknown> => {
    const projectId = (): string => requiredString(args[0], "projectId")
    const requirementId = (): string => requiredString(args[0], "requirementId")
    const schedulePatch = (raw: unknown): { plannedStart?: string | null; plannedEnd?: string | null } => {
      const schedule = asObject(raw)
      const patch: { plannedStart?: string | null; plannedEnd?: string | null } = {}
      if (schedule["plannedStart"] === null || typeof schedule["plannedStart"] === "string") {
        patch.plannedStart = schedule["plannedStart"] as string | null
      }
      if (schedule["plannedEnd"] === null || typeof schedule["plannedEnd"] === "string") {
        patch.plannedEnd = schedule["plannedEnd"] as string | null
      }
      return patch
    }

    switch (method) {
      case "canInit":
        return true

      // ── Project ──
      case "listProjects":
        return engine.listProjects()
      case "listProjectSummaries":
        return engine.listProjectSummaries()
      case "createProject": {
        const project = engine.createProject(requiredString(args[0], "name"), optionalString(args[1]))
        return {
          projectId: project.projectId,
          name: project.name,
          description: project.description,
          updatedAt: project.updatedAt,
        }
      }
      case "getProject":
        return engine.getProject(projectId())
      case "updateProjectMeta": {
        const patch = asObject(args[1])
        const project = engine.updateProjectMeta(projectId(), {
          ...(typeof patch["name"] === "string" ? { name: patch["name"] } : {}),
          ...(typeof patch["description"] === "string" ? { description: patch["description"] } : {}),
        })
        return {
          projectId: project.projectId,
          name: project.name,
          description: project.description,
        }
      }
      case "deleteProject":
        engine.deleteProject(projectId())
        return { deleted: true, projectId: projectId() }
      case "bindProjectTeambition": {
        const opts = asObject(args[1])
        return engine.bindProjectTeambition(projectId(), {
          ...(typeof opts["projectId"] === "string" ? { projectId: opts["projectId"] } : {}),
          ...(typeof opts["prefix"] === "string" ? { prefix: opts["prefix"] } : {}),
        })
      }
      case "unbindProjectTeambition":
        return engine.unbindProjectTeambition(projectId())
      case "listTeambitionCardStatuses":
        return engine.listTeambitionCardStatuses(projectId())

      // ── Requirement ──
      case "listRequirements":
        return engine.listRequirements(optionalString(args[0]))
      case "listRequirementSummaries":
        return engine.listRequirementSummaries(optionalString(args[0]))
      case "initRequirement": {
        const state = engine.initRequirement(
          requiredString(args[0], "projectId"),
          requiredString(args[1], "name"),
          optionalString(args[2]),
          optionalString(args[3]) ?? defaultProjectRoot,
        )
        return {
          projectId: state.projectId,
          requirementId: state.requirementId,
          requirementName: state.requirementName,
          currentPhase: state.currentPhase,
          taskCount: state.steps.length,
        }
      }
      case "updateRequirement": {
        const patch = asObject(args[1])
        const state = engine.updateRequirement(requirementId(), {
          ...(typeof patch["name"] === "string" ? { name: patch["name"] } : {}),
          ...(typeof patch["description"] === "string" ? { description: patch["description"] } : {}),
          ...(patch["owner"] === null || typeof patch["owner"] === "string"
            ? { owner: patch["owner"] as string | null }
            : {}),
        })
        return {
          projectId: state.projectId,
          requirementId: state.requirementId,
          requirementName: state.requirementName,
          description: state.description,
        }
      }
      case "deleteRequirement":
        engine.deleteRequirement(requirementId())
        return { deleted: true, requirementId: requirementId() }
      case "getRequirementStatus":
        return engine.getRequirementStatus(requirementId())
      case "getState":
        return engine.getState(requirementId())
      case "getExecutionSnapshot":
        return engine.getExecutionSnapshot(requirementId())
      case "updateNodeSchedule": {
        const nodeId = requiredString(args[1], "nodeId")
        const state = engine.updateNodeSchedule(requirementId(), nodeId, schedulePatch(args[2]))
        const step = state.steps.find((item) => item.id === nodeId)
        return {
          requirementId: state.requirementId,
          nodeId,
          plannedStart: step?.plannedStart ?? null,
          plannedEnd: step?.plannedEnd ?? null,
        }
      }
      case "updateRequirementSchedule": {
        const state = engine.updateRequirementSchedule(requirementId(), schedulePatch(args[1]))
        return {
          requirementId: state.requirementId,
          plannedStart: state.plannedStart ?? null,
          plannedEnd: state.plannedEnd ?? null,
        }
      }
      case "moveRequirementPhase": {
        const toPhase = requiredString(args[1], "toPhase")
        const state = engine.moveRequirementPhase(requirementId(), toPhase as never)
        return {
          requirementId: state.requirementId,
          currentPhase: state.currentPhase,
        }
      }
      case "listMilestones":
        return engine.listMilestones(requirementId())
      case "listProjectMilestones":
        return engine.listProjectMilestones(projectId())
      case "addMilestone": {
        const input = asObject(args[1])
        return engine.addMilestone(requirementId(), {
          name: requiredString(input["name"], "name"),
          date: requiredString(input["date"], "date"),
          ...(typeof input["phase"] === "string" ? { phase: input["phase"] as never } : {}),
          ...(typeof input["nodeId"] === "string" ? { nodeId: input["nodeId"] } : {}),
          ...(typeof input["note"] === "string" ? { note: input["note"] } : {}),
        })
      }
      case "updateMilestone": {
        const milestoneId = requiredString(args[1], "milestoneId")
        const patch = asObject(args[2])
        return engine.updateMilestone(requirementId(), milestoneId, {
          ...(typeof patch["name"] === "string" ? { name: patch["name"] } : {}),
          ...(patch["date"] === null || typeof patch["date"] === "string" ? { date: patch["date"] as string | null } : {}),
          ...(patch["phase"] === null || typeof patch["phase"] === "string"
            ? { phase: patch["phase"] as never }
            : {}),
          ...(patch["nodeId"] === null || typeof patch["nodeId"] === "string"
            ? { nodeId: patch["nodeId"] as string | null }
            : {}),
          ...(patch["note"] === null || typeof patch["note"] === "string"
            ? { note: patch["note"] as string | null }
            : {}),
        })
      }
      case "reachMilestone":
        return engine.reachMilestone(requirementId(), requiredString(args[1], "milestoneId"))
      case "unreachMilestone":
        return engine.unreachMilestone(requirementId(), requiredString(args[1], "milestoneId"))
      case "deleteMilestone":
        engine.deleteMilestone(requirementId(), requiredString(args[1], "milestoneId"))
        return { deleted: true, milestoneId: requiredString(args[1], "milestoneId") }
      case "runNode":
        return engine.execution.runNode(
          requirementId(),
          requiredString(args[1], "nodeId"),
          args[2] === true ? { force: true } : {},
        )
      case "runWorkflow":
        return engine.runWorkflow(requirementId(), {
          ...(args[1] === true ? { force: true } : {}),
          ...(typeof args[2] === "number" ? { maxParallel: args[2] } : {}),
        })
      case "completeNode":
        return engine.execution.completeManualNode(
          requirementId(),
          requiredString(args[1], "nodeId"),
          args[2] === true,
        )
      case "cancelRun":
        return engine.execution.cancelRun(requirementId(), requiredString(args[1], "runId"))
      case "retryRun":
        return engine.execution.retryRun(
          requirementId(),
          requiredString(args[1], "runId"),
          args[2] === true ? { force: true } : {},
        )
      case "runs":
        return engine.execution.listRuns(requirementId(), optionalString(args[1]))
      case "events":
        return engine.execution.eventsAfter(requirementId(), typeof args[1] === "number" ? args[1] : 0)
      case "bindRequirementTask": {
        const opts = asObject(args[1])
        return engine.bindRequirementTask(requirementId(), {
          ...(typeof opts["taskRef"] === "string" ? { taskRef: opts["taskRef"] } : {}),
          ...(typeof opts["taskId"] === "string" ? { taskId: opts["taskId"] } : {}),
        })
      }
      case "unbindRequirementTask":
        return engine.unbindRequirementTask(requirementId())
      case "getRequirementTeambitionStatus":
        return engine.getRequirementTeambitionStatus(requirementId())
      case "updateRequirementTeambitionStatus":
        return engine.updateRequirementTeambitionStatus(
          requirementId(),
          requiredString(args[1], "statusId"),
          optionalString(args[2]),
        )
      case "health":
        return engine.checkIntegrationHealth()
      case "resolveNodeWorkspace": {
        const state = engine.getState(requirementId())
        if (!state.projectRoot) throw new WebError(400, "需求没有源码根目录")
        const nodeKey = engine.resolveNodeKey(requirementId(), requiredString(args[1], "nodeId"))
        const path = getWorkflowWorkspace(state.projectRoot).nodePath(nodeKey)
        return { nodeKey, path, exists: existsSync(path) }
      }
      case "exportTasks": {
        const document = engine.exportTasks(requirementId())
        return { document, taskCount: document.tasks.length }
      }
      case "importTasks":
        return engine.importTasks(requirementId(), args[1])
      case "exportProjectOmniPlan": {
        const opts = asObject(args[1])
        return engine.exportProjectOmniPlan(projectId(), {
          ...(typeof opts["fileName"] === "string" ? { fileName: opts["fileName"] } : {}),
          ...(typeof opts["rootDir"] === "string" ? { rootDir: opts["rootDir"] } : {}),
        })
      }
      case "importProjectOmniPlan": {
        const opts = asObject(args[1])
        return engine.importProjectOmniPlan(projectId(), {
          ...(typeof opts["fileName"] === "string" ? { fileName: opts["fileName"] } : {}),
          ...(typeof opts["path"] === "string" ? { path: opts["path"] } : {}),
          ...(typeof opts["rootDir"] === "string" ? { rootDir: opts["rootDir"] } : {}),
        })
      }
      case "setProjectOmniPlanMeta": {
        const opts = asObject(args[1])
        return engine.setProjectOmniPlanMeta(projectId(), {
          ...(typeof opts["omniplanFolder"] === "string" ? { omniplanFolder: opts["omniplanFolder"] } : {}),
          ...(typeof opts["omniplanIdMap"] === "string" ? { omniplanIdMap: opts["omniplanIdMap"] } : {}),
          ...(typeof opts["omniplanFileName"] === "string" ? { omniplanFileName: opts["omniplanFileName"] } : {}),
        })
      }
      case "setProjectDefaultColor": {
        const color = args[1] === null || typeof args[1] === "string" ? (args[1] as string | null) : null
        return engine.setProjectDefaultColor(projectId(), color)
      }
      case "bindProjectTeambitionRepo": {
        const opts = asObject(args[1])
        return engine.bindProjectTeambitionRepo(projectId(), {
          repoId: requiredString(opts["repoId"], "repoId"),
          ...(typeof opts["pluginId"] === "string" ? { pluginId: opts["pluginId"] } : {}),
          ...(typeof opts["tbProjectId"] === "string" ? { tbProjectId: opts["tbProjectId"] } : {}),
          ...(typeof opts["name"] === "string" ? { name: opts["name"] } : {}),
        })
      }
      case "unbindProjectTeambitionRepo":
        return engine.unbindProjectTeambitionRepo(projectId())
      case "listProjectVersions": {
        const opts = asObject(args[1])
        return engine.listProjectVersions(projectId(), opts["refresh"] === true ? { refresh: true } : undefined)
      }
      case "syncProjectVersions":
        return engine.syncProjectVersions(projectId())
      case "getProjectVersion":
        return engine.getProjectVersion(projectId(), requiredString(args[1], "versionId"))
      case "setProjectDefaultVersion": {
        const versionId = args[1] === null || typeof args[1] === "string" ? (args[1] as string | null) : null
        return engine.setProjectDefaultVersion(projectId(), versionId)
      }
      case "bindRequirementVersion":
        return engine.bindRequirementVersion(requirementId(), requiredString(args[1], "versionId"))
      case "unbindRequirementVersion":
        return engine.unbindRequirementVersion(requirementId())
      case "getRequirementVersionBinding":
        return engine.getRequirementVersionBinding(requirementId())
      case "listVersionRequirements":
        return engine.listVersionRequirements(projectId(), optionalString(args[1]))
      case "updateVersionNote": {
        const versionId = requiredString(args[1], "versionId")
        const note = typeof args[2] === "string" ? args[2] : ""
        return engine.updateVersionNote(projectId(), versionId, note)
      }
      case "getProjectBrdDesignConfig":
        return engine.getProjectBrdDesignConfig(projectId())
      case "setProjectBrdDesignConfig": {
        const opts = asObject(args[1])
        const sourcesRaw = opts["sources"]
        const sources = sourcesRaw && typeof sourcesRaw === "object" ? asObject(sourcesRaw) : undefined
        const promptsRaw = opts["prompts"]
        const prompts = promptsRaw && typeof promptsRaw === "object" ? asObject(promptsRaw) : undefined
        const promptPatch = prompts
          ? Object.fromEntries(
              (["summarize-sources", "generate", "check"] as const)
                .filter((id) => prompts[id] !== undefined)
                .map((id) => {
                  const value = prompts[id]
                  if (value === null) return [id, null]
                  const item = value && typeof value === "object" ? asObject(value) : {}
                  return [id, {
                    ...(typeof item["system"] === "string" ? { system: item["system"] } : {}),
                    ...(typeof item["user"] === "string" ? { user: item["user"] } : {}),
                  }]
                }),
            )
          : undefined
        return engine.setProjectBrdDesignConfig(projectId(), {
          ...(sources
            ? {
                sources: {
                  ...(typeof sources["miniprogramCodePath"] === "string"
                    ? { miniprogramCodePath: sources["miniprogramCodePath"] }
                    : {}),
                  ...(typeof sources["websiteCodePath"] === "string"
                    ? { websiteCodePath: sources["websiteCodePath"] }
                    : {}),
                  ...(typeof sources["frontendCodePath"] === "string"
                    ? { frontendCodePath: sources["frontendCodePath"] }
                    : {}),
                  ...(typeof sources["backendCodePath"] === "string"
                    ? { backendCodePath: sources["backendCodePath"] }
                    : {}),
                  ...(typeof sources["miniprogramBuildArtifact"] === "string"
                    ? { miniprogramBuildArtifact: sources["miniprogramBuildArtifact"] }
                    : {}),
                  ...(typeof sources["websiteUrl"] === "string" ? { websiteUrl: sources["websiteUrl"] } : {}),
                },
              }
            : {}),
          ...(typeof opts["brdSpecPath"] === "string" ? { brdSpecPath: opts["brdSpecPath"] } : {}),
          ...(typeof opts["brdOutputPath"] === "string" ? { brdOutputPath: opts["brdOutputPath"] } : {}),
          ...(promptPatch ? { prompts: promptPatch } : {}),
        })
      }
      case "previewBrdPrompts": {
        const requirementId = requiredString(args[1], "requirementId")
        const opts = asObject(args[2])
        const mode = opts["mode"]
        return engine.previewBrdPrompts(projectId(), requirementId, {
          ...(mode === "generate" || mode === "check" || mode === "all" ? { mode } : {}),
          ...(opts["includeSummarize"] === true ? { includeSummarize: true } : {}),
        })
      }
      case "assignNode": {
        const nodeId = requiredString(args[1], "nodeId")
        const assignedTo = args[2] === null || typeof args[2] === "string" ? (args[2] as string | null) : null
        const state = engine.assignNode(requirementId(), nodeId, assignedTo)
        const step = state.steps.find((item) => item.id === nodeId)
        return { requirementId: state.requirementId, nodeId, assignedTo: step?.assignedTo ?? null }
      }
      case "listMyWork":
        return engine.listMyWork(requiredString(args[0], "identity"), optionalString(args[1]))
      case "getProjectOverview":
        return engine.getProjectOverview(projectId())
      case "getIdentity":
        return { name: getIdentity(storeDir) ?? null }
      case "setIdentity": {
        const name = args[0] === null || args[0] === "" ? null : requiredString(args[0], "name")
        saveIdentity(storeDir, name)
        return { name }
      }
      default:
        throw new WebError(404, `不支持的 API 方法：${method}`)
    }
  }

  const staticFiles = new Map([
    ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/renderer.js", { file: "renderer.js", type: "text/javascript; charset=utf-8" }],
    ["/gantt.js", { file: "gantt.js", type: "text/javascript; charset=utf-8" }],
    ["/browser-api.js", { file: "browser-api.js", type: "text/javascript; charset=utf-8" }],
    ["/app-icon.png", { file: "app-icon.png", type: "image/png" }],
    ["/logo.png", { file: "logo.png", type: "image/png" }],
    ["/mascot.jpg", { file: "mascot.jpg", type: "image/jpeg" }],
  ])

  let currentUrl = `http://${host}:${requestedPort}`
  const server = createServer((request, response) => {
    void (async () => {
      const allowedUrl = new URL(currentUrl)
      if (request.headers.host !== allowedUrl.host) {
        throw new WebError(403, "请求 Host 不受信任")
      }
      const origin = request.headers.origin
      if (origin !== undefined && origin !== allowedUrl.origin) {
        throw new WebError(403, "请求 Origin 不受信任")
      }

      const url = new URL(request.url ?? "/", `http://${host}`)
      if (request.method === "POST" && url.pathname === "/api") {
        const body = await readRequest(request)
        const method = requiredString(body.method, "method")
        const args = Array.isArray(body.args) ? body.args : []
        sendJson(response, 200, { result: await invoke(method, args) })
        return
      }
      if (request.method !== "GET") throw new WebError(405, "请求方法不受支持")
      const asset = staticFiles.get(url.pathname)
      if (!asset) throw new WebError(404, "页面不存在")
      response.writeHead(200, {
        "Content-Type": asset.type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      })
      response.end(readFileSync(join(rendererDir, asset.file)))
    })().catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      sendJson(response, error instanceof WebError ? error.status : 500, { error: error.message })
    })
  })

  return {
    get url() {
      return currentUrl
    },
    listen: () => new Promise((resolveListen, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once("error", onError)
      server.listen(requestedPort, host, () => {
        server.off("error", onError)
        const address = server.address()
        if (!address || typeof address === "string") {
          reject(new Error("无法确定 Web 服务监听地址"))
          return
        }
        currentUrl = `http://${host}:${address.port}`
        resolveListen(currentUrl)
      })
    }),
    close: () => new Promise((resolveClose, reject) => {
      if (!server.listening) {
        resolveClose()
        return
      }
      server.close((error) => error ? reject(error) : resolveClose())
    }),
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (entryPath === fileURLToPath(import.meta.url)) {
  const host = "127.0.0.1"
  const port = process.env["OCTOPUS_WEB_PORT"] ? Number(process.env["OCTOPUS_WEB_PORT"]) : 4173
  void (async () => {
    if (await stopExistingOctopusWeb(host, port)) {
      console.log(`已结束占用 ${host}:${port} 的上一份 Octopus Web 进程`)
    }
    const server = await createOctopusWebServer({ port })
    const url = await server.listen()
    console.log(`🐙 Octopus Web 已启动：${url}`)
  })().catch((error: unknown) => {
    console.error(`❌ Octopus Web 启动失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
