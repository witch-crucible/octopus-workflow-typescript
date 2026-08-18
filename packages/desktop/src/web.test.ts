import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, it } from "vitest"
import { createOctopusWebServer, stopExistingOctopusWeb } from "./web.js"

const temporaryDirectories: string[] = []
const childProcesses: ChildProcess[] = []

async function reservedPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("无法分配测试端口"))
        return
      }
      const port = address.port
      probe.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

async function waitForChildListen(host: string, port: number): Promise<void> {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    try {
      await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(200) })
      return
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 40))
    }
  }
  throw new Error(`测试子进程未在 ${host}:${port} 监听`)
}

function spawnListener(port: number, script: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, TEST_PORT: String(port) },
    stdio: "ignore",
  })
  childProcesses.push(child)
  return child
}

async function invoke(url: string, method: string, ...args: unknown[]): Promise<Response> {
  return fetch(`${url}/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args }),
  })
}

async function rawInvoke(
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const endpoint = new URL(`${url}/api`)
  const body = JSON.stringify({ method: "listProjects", args: [] })
  return new Promise((resolveRequest, reject) => {
    const outgoing = request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () => {
        resolveRequest({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
        })
      })
    })
    outgoing.on("error", reject)
    outgoing.end(body)
  })
}

describe("Octopus Web", () => {
  afterEach(() => {
    for (const child of childProcesses.splice(0)) {
      if (child.pid !== undefined) {
        try { process.kill(child.pid, "SIGKILL") } catch { /* 已退出 */ }
      }
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("应提供真实项目状态并允许同一状态库创建多个项目", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-web-"))
    temporaryDirectories.push(root)
    const server = await createOctopusWebServer({
      port: 0,
      storeDir: join(root, "store"),
      projectRoot: join(root, "project"),
      rendererDir: join(process.cwd(), "packages/desktop/src/renderer"),
    })
    const url = await server.listen()

    try {
      const page = await fetch(url)
      expect(await page.text()).toContain("Octopus Workflow")
      expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
      expect(page.headers.get("x-frame-options")).toBe("DENY")
      expect(await (await invoke(url, "canInit")).json()).toEqual({ result: true })

      const initialized = await invoke(url, "init", "Web Test Project", undefined, join(root, "project"))
      expect(initialized.status).toBe(200)
      const initializedBody = await initialized.json() as { result: { projectId: string } }
      expect(readFileSync(join(root, "project", "workflow.yaml"), "utf-8")).toContain("name:")

      expect(await (await invoke(url, "listProjects")).json()).toEqual({
        result: [initializedBody.result.projectId],
      })
      const state = await invoke(url, "state", initializedBody.result.projectId)
      expect(await state.json()).toMatchObject({
        result: { projectName: "Web Test Project", projectRoot: join(root, "project") },
      })

      const repeated = await invoke(url, "init", "Repeated Project", undefined, join(root, "project-two"))
      expect(repeated.status).toBe(200)
      const repeatedBody = await repeated.json() as { result: { projectId: string } }

      const summaries = await (await invoke(url, "listProjectSummaries")).json() as {
        result: Array<{ projectId: string; projectName: string; completedTasks: number; totalTasks: number }>
      }
      expect(summaries.result.map((item) => item.projectId)).toEqual(
        expect.arrayContaining([initializedBody.result.projectId, repeatedBody.result.projectId]),
      )
      expect(summaries.result[0]?.totalTasks).toBeGreaterThan(0)

      const renamed = await invoke(url, "updateProject", initializedBody.result.projectId, { name: "Renamed Web Project" })
      expect(renamed.status).toBe(200)
      expect(await renamed.json()).toMatchObject({
        result: { projectId: initializedBody.result.projectId, projectName: "Renamed Web Project" },
      })

      const stateBody = await (await invoke(url, "state", initializedBody.result.projectId)).json() as {
        result: { steps: Array<{ id: string }> }
      }
      const nodeId = stateBody.result.steps[0]?.id
      expect(nodeId).toBeTruthy()
      const scheduled = await invoke(url, "updateNodeSchedule", initializedBody.result.projectId, nodeId, {
        plannedStart: "2026-04-01",
        plannedEnd: "2026-04-03",
      })
      expect(scheduled.status).toBe(200)
      expect(await scheduled.json()).toMatchObject({
        result: { nodeId, plannedStart: "2026-04-01", plannedEnd: "2026-04-03" },
      })

      const deleted = await invoke(url, "deleteProject", repeatedBody.result.projectId)
      expect(deleted.status).toBe(200)
      expect(await (await invoke(url, "listProjects")).json()).toEqual({
        result: [initializedBody.result.projectId],
      })
    } finally {
      await server.close()
    }
  })

  it("空状态库重启后仍应允许初始化", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-web-empty-restart-"))
    temporaryDirectories.push(root)
    const options = {
      port: 0,
      storeDir: join(root, "store"),
      projectRoot: join(root, "project"),
      rendererDir: join(process.cwd(), "packages/desktop/src/renderer"),
    }
    const first = await createOctopusWebServer(options)
    const firstUrl = await first.listen()
    try {
      expect(await (await invoke(firstUrl, "canInit")).json()).toEqual({ result: true })
    } finally {
      await first.close()
    }

    const restarted = await createOctopusWebServer(options)
    const restartedUrl = await restarted.listen()
    try {
      expect(await (await invoke(restartedUrl, "canInit")).json()).toEqual({ result: true })
      expect((await invoke(restartedUrl, "init", "Restarted Project")).status).toBe(200)
    } finally {
      await restarted.close()
    }
  })

  it("应拒绝伪造 Host 与跨源 Origin，同时允许无 Origin 的本地客户端", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-web-origin-"))
    temporaryDirectories.push(root)
    const server = await createOctopusWebServer({
      port: 0,
      storeDir: join(root, "store"),
      rendererDir: join(process.cwd(), "packages/desktop/src/renderer"),
    })
    const url = await server.listen()
    const allowedUrl = new URL(url)

    try {
      expect(await rawInvoke(url, { Host: allowedUrl.host })).toMatchObject({ status: 200 })
      expect(await rawInvoke(url, { Host: allowedUrl.host, Origin: allowedUrl.origin })).toMatchObject({ status: 200 })
      expect(await rawInvoke(url, { Host: `evil.example:${allowedUrl.port}` })).toMatchObject({
        status: 403,
        body: { error: "请求 Host 不受信任" },
      })
      expect(await rawInvoke(url, { Host: allowedUrl.host, Origin: `http://evil.example:${allowedUrl.port}` })).toMatchObject({
        status: 403,
        body: { error: "请求 Origin 不受信任" },
      })
    } finally {
      await server.close()
    }
  })

  it("应结束占用端口的上一份 Octopus Web，并拒绝杀死无关进程", async () => {
    const host = "127.0.0.1"
    const octopusPort = await reservedPort()
    const foreignPort = await reservedPort()

    spawnListener(octopusPort, `
      require("http").createServer((request, response) => {
        if (request.url === "/api" && request.method === "POST") {
          response.setHeader("Content-Type", "application/json")
          response.end(JSON.stringify({ result: [] }))
          return
        }
        response.statusCode = 404
        response.end()
      }).listen(process.env.TEST_PORT, "127.0.0.1")
    `)
    const foreign = spawnListener(foreignPort, `
      require("http").createServer((_request, response) => {
        response.end("other")
      }).listen(process.env.TEST_PORT, "127.0.0.1")
    `)
    await waitForChildListen(host, octopusPort)
    await waitForChildListen(host, foreignPort)

    expect(await stopExistingOctopusWeb(host, octopusPort)).toBe(true)
    await expect(fetch(`http://${host}:${octopusPort}/`, { signal: AbortSignal.timeout(400) }))
      .rejects.toThrow()

    await expect(stopExistingOctopusWeb(host, foreignPort)).rejects.toThrow(/已被进程/)
    expect(foreign.exitCode).toBeNull()
    expect(await (await fetch(`http://${host}:${foreignPort}/`)).text()).toBe("other")

    expect(await stopExistingOctopusWeb(host, octopusPort)).toBe(false)
  })

  it("浏览器 transport 遇到非法 JSON 时应拒绝而不是悬挂", async () => {
    const input = {
      type: "",
      accept: "",
      files: [{ text: async () => "{" }],
      onchange: undefined as (() => Promise<void>) | undefined,
      oncancel: undefined as (() => void) | undefined,
      click: (): void => {
        queueMicrotask(() => { void input.onchange?.() })
      },
    }
    const windowObject: {
      octopus?: { importTasks(projectId: string): Promise<unknown> }
    } = {}
    runInNewContext(
      readFileSync(join(process.cwd(), "packages/desktop/src/renderer/browser-api.js"), "utf-8"),
      {
        window: windowObject,
        document: { createElement: () => input },
        fetch,
        Blob,
        URL,
        queueMicrotask,
      },
    )

    expect(windowObject.octopus).toBeDefined()
    await expect(windowObject.octopus?.importTasks("project-test")).rejects.toThrow()
  })
})
