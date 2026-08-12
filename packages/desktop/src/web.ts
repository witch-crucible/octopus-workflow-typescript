/**
 * 浏览器客户端服务 —— 复用 Electron renderer 与真实工作流引擎。
 *
 * 仅监听本机回环地址，页面通过同源 JSON API 访问经过白名单限制的引擎能力。
 */

import { readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "@octopus/context/config.js"
import { createWorkflowEngineFromConfig } from "@octopus/workflow-engine/index.js"

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

export function createOctopusWebServer(options: OctopusWebServerOptions = {}): OctopusWebServer {
  const host = options.host ?? "127.0.0.1"
  const requestedPort = options.port ?? 4173
  const storeDir = resolve(options.storeDir ?? process.env["OCTOPUS_STORE_DIR"] ?? join(repositoryRoot, ".octo"))
  const rendererDir = resolve(options.rendererDir ?? join(moduleDirectory, "..", "src", "renderer"))
  const defaultProjectRoot = resolve(options.projectRoot ?? repositoryRoot)
  const config = { ...loadConfig(storeDir), storeDir }
  const engine = createWorkflowEngineFromConfig(config)

  const listProjects = (): string[] => engine.listProjects()
  const initializationAllowed = (): boolean => listProjects().length === 0

  const invoke = async (method: string, args: unknown[]): Promise<unknown> => {
    const projectId = (): string => requiredString(args[0], "projectId")
    switch (method) {
      case "canInit":
        return initializationAllowed()
      case "listProjects":
        return listProjects()
      case "init": {
        if (!initializationAllowed()) {
          throw new WebError(409, "状态库已有项目，禁止执行 init")
        }
        const state = engine.initProject(
          requiredString(args[0], "name"),
          optionalString(args[1]),
          optionalString(args[2]) ?? defaultProjectRoot,
        )
        return {
          projectId: state.projectId,
          projectName: state.projectName,
          currentPhase: state.currentPhase,
          taskCount: state.steps.length,
        }
      }
      case "status":
        return engine.getProjectStatus(projectId())
      case "snapshot":
        return engine.getExecutionSnapshot(projectId())
      case "state":
        return engine.getState(projectId())
      case "runNode":
        return engine.execution.runNode(projectId(), requiredString(args[1], "nodeId"), args[2] === true ? { force: true } : {})
      case "runWorkflow":
        return engine.runWorkflow(projectId(), {
          ...(args[1] === true ? { force: true } : {}),
          ...(typeof args[2] === "number" ? { maxParallel: args[2] } : {}),
        })
      case "completeNode":
        return engine.execution.completeManualNode(projectId(), requiredString(args[1], "nodeId"), args[2] === true)
      case "cancelRun":
        return engine.execution.cancelRun(projectId(), requiredString(args[1], "runId"))
      case "retryRun":
        return engine.execution.retryRun(projectId(), requiredString(args[1], "runId"), args[2] === true ? { force: true } : {})
      case "runs":
        return engine.execution.listRuns(projectId(), optionalString(args[1]))
      case "events":
        return engine.execution.eventsAfter(projectId(), typeof args[1] === "number" ? args[1] : 0)
      case "health":
        return engine.checkIntegrationHealth()
      case "exportTasks": {
        const document = engine.exportTasks(projectId())
        return { document, taskCount: document.tasks.length }
      }
      case "importTasks":
        return engine.importTasks(projectId(), args[1])
      default:
        throw new WebError(404, `不支持的 API 方法：${method}`)
    }
  }

  const staticFiles = new Map([
    ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
    ["/renderer.js", { file: "renderer.js", type: "text/javascript; charset=utf-8" }],
    ["/browser-api.js", { file: "browser-api.js", type: "text/javascript; charset=utf-8" }],
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
  const server = createOctopusWebServer({
    ...(process.env["OCTOPUS_WEB_PORT"] ? { port: Number(process.env["OCTOPUS_WEB_PORT"]) } : {}),
  })
  server.listen()
    .then((url) => console.log(`🐙 Octopus Web 已启动：${url}`))
    .catch((error: unknown) => {
      console.error(`❌ Octopus Web 启动失败：${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })
}
