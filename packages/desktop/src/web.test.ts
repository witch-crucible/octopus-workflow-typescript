import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, it } from "vitest"
import { createOctopusWebServer } from "./web.js"

const temporaryDirectories: string[] = []

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
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("应提供真实项目状态并拒绝同一状态库重复初始化", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-web-"))
    temporaryDirectories.push(root)
    const server = createOctopusWebServer({
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
      expect(repeated.status).toBe(409)
      expect(await repeated.json()).toMatchObject({ error: expect.stringContaining("状态库已有项目，禁止执行 init") })
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
    const first = createOctopusWebServer(options)
    const firstUrl = await first.listen()
    try {
      expect(await (await invoke(firstUrl, "canInit")).json()).toEqual({ result: true })
    } finally {
      await first.close()
    }

    const restarted = createOctopusWebServer(options)
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
    const server = createOctopusWebServer({
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
