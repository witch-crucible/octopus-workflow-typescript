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

function extractBalancedBlock(source: string, openBrace: number): string {
  if (source[openBrace] !== "{") throw new Error(`偏移 ${openBrace} 不是 '{'`)
  let depth = 0
  for (let index = openBrace; index < source.length; index++) {
    const char = source[index]
    if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return source.slice(openBrace, index + 1)
    }
  }
  throw new Error(`未能从偏移 ${openBrace} 截取成对花括号`)
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`未找到函数 ${name}`)
  // 跳过参数列表（可能含 options = {}），再取函数体，避免默认参数花括号截断。
  let depth = 0
  let bodyOpen = -1
  for (let index = start + `function ${name}`.length; index < source.length; index++) {
    const char = source[index]
    if (char === "(") depth++
    else if (char === ")") {
      depth--
      if (depth === 0) {
        bodyOpen = source.indexOf("{", index + 1)
        break
      }
    }
  }
  if (bodyOpen < 0) throw new Error(`未找到函数 ${name} 的函数体`)
  return source.slice(start, bodyOpen) + extractBalancedBlock(source, bodyOpen)
}

function extractConstObject(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = {`)
  if (start < 0) throw new Error(`未找到常量 ${name}`)
  const openBrace = source.indexOf("{", start)
  return source.slice(start, openBrace) + extractBalancedBlock(source, openBrace)
}

function extractConstArray(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = [`)
  if (start < 0) throw new Error(`未找到常量数组 ${name}`)
  const openBracket = source.indexOf("[", start)
  let depth = 0
  for (let index = openBracket; index < source.length; index++) {
    const char = source[index]
    if (char === "[") depth++
    else if (char === "]") {
      depth--
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`未能从偏移 ${openBracket} 截取数组 ${name}`)
}

type HubCardBuild = {
  readonly kind: "empty" | "nomatch" | "cards"
  readonly filtered: Array<{ projectId: string; name: string }>
  readonly html: string
}

function loadBuildHubCardsMarkup(source: string): (
  items: unknown[],
  options?: { filter?: string; lastCreatedId?: string },
) => HubCardBuild {
  const script = [
    extractConstObject(source, "PHASE_LABELS"),
    extractFunction(source, "phaseLabel"),
    extractFunction(source, "escapeHtml"),
    extractFunction(source, "formatUpdatedAt"),
    extractFunction(source, "buildHubCardsMarkup"),
    "buildHubCardsMarkup",
  ].join("\n")
  return runInNewContext(script, {}) as (
    items: unknown[],
    options?: { filter?: string; lastCreatedId?: string },
  ) => HubCardBuild
}

function loadBuildRequirementCardsMarkup(source: string): (
  items: unknown[],
  options?: { filter?: string; lastCreatedId?: string },
) => { kind: string; html: string } {
  const script = [
    extractConstObject(source, "PHASE_LABELS"),
    extractFunction(source, "phaseLabel"),
    extractFunction(source, "escapeHtml"),
    extractFunction(source, "formatUpdatedAt"),
    extractFunction(source, "formatMilestoneDate"),
    extractFunction(source, "milestoneBadgeHtml"),
    extractFunction(source, "buildRequirementCardsMarkup"),
    "buildRequirementCardsMarkup",
  ].join("\n")
  return runInNewContext(script, {}) as (
    items: unknown[],
    options?: { filter?: string; lastCreatedId?: string },
  ) => { kind: string; html: string }
}

function loadBuildKanbanMarkup(source: string): (
  items: unknown[],
  options?: { filter?: string; lastCreatedId?: string; tbStatuses?: unknown[] },
) => { kind: string; filtered: unknown[]; html: string } {
  const script = [
    extractConstArray(source, "PHASE_ORDER"),
    extractConstObject(source, "PHASE_LABELS"),
    extractFunction(source, "phaseLabel"),
    extractFunction(source, "escapeHtml"),
    extractFunction(source, "formatUpdatedAt"),
    extractFunction(source, "buildKanbanMarkup"),
    "buildKanbanMarkup",
  ].join("\n")
  return runInNewContext(script, {}) as (
    items: unknown[],
    options?: { filter?: string; lastCreatedId?: string; tbStatuses?: unknown[] },
  ) => { kind: string; filtered: unknown[]; html: string }
}

function loadCollectBrdPromptPatch(source: string): (
  drafts: Record<string, { system: string; user: string }>,
  clearedIds: string[],
) => { prompts: Record<string, { system: string; user: string } | null>; invalid?: { id: string } } {
  const script = [
    extractConstArray(source, "BRD_PROMPT_IDS"),
    extractFunction(source, "collectBrdPromptPatch"),
    "collectBrdPromptPatch",
  ].join("\n")
  return runInNewContext(script, {}) as (
    drafts: Record<string, { system: string; user: string }>,
    clearedIds: string[],
  ) => { prompts: Record<string, { system: string; user: string } | null>; invalid?: { id: string } }
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

  it("应提供真实项目/需求状态并允许同一状态库创建多个项目", async () => {
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
      const html = await page.text()
      expect(html).toContain("Octopus Workflow")
      expect(html).toContain("rel=\"icon\"")
      expect(html).toContain("href=\"app-icon.png\"")
      expect(html).toContain("src=\"logo.png\"")
      expect(html).toContain("src=\"mascot.jpg\"")
      expect(html).toContain("href=\"element-plus.css\"")
      expect(html).toContain("src=\"element-plus.js\"")
      expect(html).toContain("src=\"element-plus-adapter.js\"")
      expect(html).toContain("class=\"hub-hero\"")
      expect(html).toContain("一只章鱼，编排整条软件交付流水线")
      expect(html).toContain("class=\"brand-name\"")
      expect(html).not.toContain("🐙</div>")
      expect(html).toContain("id=\"hubGanttHost\"")
      expect(html).toContain("id=\"hubCards\"")
      expect(html).toContain("id=\"projectView\"")
      expect(html).toContain("id=\"requirementCards\"")
      expect(html).toContain("id=\"requirementTbBar\"")
      expect(html).toContain("id=\"requirementMilestoneBar\"")
      expect(html).toContain("class=\"hub-cards\"")
      expect(html).toContain(".hub-card {")
      expect(html).toContain("--el-border-radius-card")
      expect(html).toContain("点击泳道图中的节点")
      expect(html).toContain("id=\"toggleSidebar\"")
      expect(html).toContain("id=\"toggleInspector\"")
      expect(html).toContain("id=\"nodeLocator\"")
      expect(html).toContain("快速定位工作流节点")
      expect(html).toContain("拖拽空白处平移")
      expect(html).toContain("Ctrl/⌘ + 滚轮缩放")
      expect(html).toContain(".node .name-en")
      expect(html).not.toContain("id=\"workspaceTabs\"")
      expect(html).not.toContain("id=\"ganttPane\"")
      expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")

      const ganttScript = await fetch(new URL("/gantt.js", url))
      expect(ganttScript.headers.get("content-type")).toContain("javascript")
      expect(await ganttScript.text()).toContain("function unmount(")

      const appIcon = await fetch(new URL("/app-icon.png", url))
      expect(appIcon.ok).toBe(true)
      expect(appIcon.headers.get("content-type")).toContain("image/png")
      expect(Buffer.byteLength(await appIcon.arrayBuffer())).toBeGreaterThan(1000)

      const logo = await fetch(new URL("/logo.png", url))
      expect(logo.ok).toBe(true)
      expect(logo.headers.get("content-type")).toContain("image/png")
      expect(Buffer.byteLength(await logo.arrayBuffer())).toBeGreaterThan(1000)

      const mascot = await fetch(new URL("/mascot.jpg", url))
      expect(mascot.ok).toBe(true)
      expect(mascot.headers.get("content-type")).toContain("image/jpeg")
      expect(Buffer.byteLength(await mascot.arrayBuffer())).toBeGreaterThan(1000)

      const renderer = await (await fetch(new URL("/renderer.js", url))).text()
      expect(renderer).toContain("buildHubCardsMarkup")
      expect(renderer).toContain("buildRequirementCardsMarkup")
      expect(renderer).toContain("toggleHubSchedule")
      expect(renderer).toContain("toggleWorkspacePanel")
      expect(renderer).toContain("setupGraphPan")
      expect(renderer).toContain("setupGraphWheelZoom")
      expect(renderer).toContain("renderNodeLocator")
      expect(renderer).toContain("focusNodeInGraph")
      expect(renderer).toContain('"data-node-id": node.id')
      expect(renderer).toContain("scrollNodeIntoView")
      expect(renderer).toContain("jumpToNodeWorkspace")
      expect(renderer).toContain("resolveNodeWorkspace")
      expect(renderer).toContain("bindProjectTeambition")
      expect(renderer).toContain("bindRequirementTask")
      expect(renderer).toContain("goToRequirement")
      expect(renderer).not.toContain("workspaceMode")

      const browserApi = await (await fetch(new URL("/browser-api.js", url))).text()
      expect(browserApi).toContain("resolveNodeWorkspace")
      expect(browserApi).toContain("createProject")
      expect(browserApi).toContain("initRequirement")
      expect(browserApi).toContain("listRequirementSummaries")
      expect(browserApi).toContain("updateRequirementSchedule")
      expect(browserApi).toContain("moveRequirementPhase")
      expect(browserApi).toContain("listMilestones")
      expect(browserApi).toContain("addMilestone")
      expect(browserApi).toContain("reachMilestone")
      expect(page.headers.get("x-frame-options")).toBe("DENY")
      expect(await (await invoke(url, "canInit")).json()).toEqual({ result: true })

      const createdProject = await invoke(url, "createProject", "Web Test Project", "desc")
      expect(createdProject.status).toBe(200)
      const createdProjectBody = await createdProject.json() as { result: { projectId: string; name: string } }
      expect(createdProjectBody.result.name).toBe("Web Test Project")

      const initialized = await invoke(
        url,
        "initRequirement",
        createdProjectBody.result.projectId,
        "Web Test Requirement",
        undefined,
        join(root, "project"),
      )
      expect(initialized.status).toBe(200)
      const initializedBody = await initialized.json() as {
        result: { projectId: string; requirementId: string; requirementName: string }
      }
      expect(readFileSync(join(root, "project", "workflow.yaml"), "utf-8")).toContain("name:")
      expect(initializedBody.result.requirementName).toBe("Web Test Requirement")

      expect(await (await invoke(url, "listProjects")).json()).toEqual({
        result: [createdProjectBody.result.projectId],
      })
      expect(await (await invoke(url, "listRequirements", createdProjectBody.result.projectId)).json()).toEqual({
        result: [initializedBody.result.requirementId],
      })
      const state = await invoke(url, "getState", initializedBody.result.requirementId)
      expect(await state.json()).toMatchObject({
        result: {
          requirementName: "Web Test Requirement",
          projectId: createdProjectBody.result.projectId,
          projectRoot: join(root, "project"),
        },
      })

      const secondProject = await invoke(url, "createProject", "Repeated Project")
      expect(secondProject.status).toBe(200)
      const secondProjectBody = await secondProject.json() as { result: { projectId: string } }
      const repeated = await invoke(
        url,
        "initRequirement",
        secondProjectBody.result.projectId,
        "Repeated Requirement",
        undefined,
        join(root, "project-two"),
      )
      expect(repeated.status).toBe(200)
      const repeatedBody = await repeated.json() as { result: { requirementId: string } }

      const summaries = await (await invoke(url, "listProjectSummaries")).json() as {
        result: Array<{ projectId: string; name: string; requirementCount: number }>
      }
      expect(summaries.result.map((item) => item.projectId)).toEqual(
        expect.arrayContaining([createdProjectBody.result.projectId, secondProjectBody.result.projectId]),
      )
      expect(summaries.result.find((item) => item.projectId === createdProjectBody.result.projectId)?.requirementCount)
        .toBe(1)

      const renamed = await invoke(url, "updateProjectMeta", createdProjectBody.result.projectId, {
        name: "Renamed Web Project",
      })
      expect(renamed.status).toBe(200)
      expect(await renamed.json()).toMatchObject({
        result: { projectId: createdProjectBody.result.projectId, name: "Renamed Web Project" },
      })

      const stateBody = await (await invoke(url, "getState", initializedBody.result.requirementId)).json() as {
        result: { steps: Array<{ id: string }> }
      }
      const nodeId = stateBody.result.steps[0]?.id
      expect(nodeId).toBeTruthy()
      const workspace = await invoke(url, "resolveNodeWorkspace", initializedBody.result.requirementId, nodeId)
      expect(workspace.status).toBe(200)
      expect(await workspace.json()).toMatchObject({
        result: {
          nodeKey: expect.stringMatching(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          path: expect.stringContaining(`${join(root, "project")}/workflow/nodes/`),
          exists: true,
        },
      })
      const scheduled = await invoke(url, "updateNodeSchedule", initializedBody.result.requirementId, nodeId, {
        plannedStart: "2026-04-01",
        plannedEnd: "2026-04-03",
      })
      expect(scheduled.status).toBe(200)
      expect(await scheduled.json()).toMatchObject({
        result: { nodeId, plannedStart: "2026-04-01", plannedEnd: "2026-04-03" },
      })
      const addedMilestone = await invoke(url, "addMilestone", initializedBody.result.requirementId, {
        name: "设计评审",
        date: "2026-03-12",
      })
      expect(addedMilestone.status).toBe(200)
      const addedMilestoneBody = await addedMilestone.json() as { result: { id: string; name: string } }
      expect(addedMilestoneBody.result.name).toBe("设计评审")
      const requirementSummaries = await (await invoke(
        url,
        "listRequirementSummaries",
        createdProjectBody.result.projectId,
      )).json() as {
        result: Array<{ requirementId: string; milestoneCount?: number; nextMilestone?: { name: string } }>
      }
      expect(requirementSummaries.result[0]?.milestoneCount).toBe(1)
      expect(requirementSummaries.result[0]?.nextMilestone?.name).toBe("设计评审")

      const deleted = await invoke(url, "deleteProject", secondProjectBody.result.projectId)
      expect(deleted.status).toBe(200)
      expect(await (await invoke(url, "listProjects")).json()).toEqual({
        result: [createdProjectBody.result.projectId],
      })
      expect(await (await invoke(url, "listRequirements")).json()).toEqual({
        result: [initializedBody.result.requirementId],
      })
      expect(repeatedBody.result.requirementId).toBeTruthy()
    } finally {
      await server.close()
    }
  })

  it("需求卡片按里程碑摘要渲染徽章", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf8")
    const build = loadBuildRequirementCardsMarkup(source)
    const base = {
      requirementId: "req_1",
      requirementName: "支付改版",
      description: "desc",
      currentPhase: "Design",
      completedTasks: 1,
      totalTasks: 2,
    }
    expect(build([base]).html).not.toContain("里程碑")
    expect(build([{
      ...base,
      milestoneCount: 2,
      nextMilestone: { id: "ms_1", name: "设计评审", date: "2026-03-12", overdue: false },
    }]).html).toContain("里程碑 03-12 设计评审")
    expect(build([{
      ...base,
      milestoneCount: 1,
      nextMilestone: { id: "ms_1", name: "上线", date: "2026-03-01", overdue: true },
    }]).html).toContain("is-overdue")
    expect(build([{ ...base, milestoneCount: 1 }]).html).toContain("里程碑已全部达成")
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
      const project = await invoke(restartedUrl, "createProject", "Restarted Project")
      expect(project.status).toBe(200)
      const projectBody = await project.json() as { result: { projectId: string } }
      expect((await invoke(
        restartedUrl,
        "initRequirement",
        projectBody.result.projectId,
        "Restarted Requirement",
      )).status).toBe(200)
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

  it("项目管理中心应按卡片渲染每个项目摘要", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-web-cards-"))
    temporaryDirectories.push(root)
    const server = await createOctopusWebServer({
      port: 0,
      storeDir: join(root, "store"),
      projectRoot: join(root, "project"),
      rendererDir: join(process.cwd(), "packages/desktop/src/renderer"),
    })
    const url = await server.listen()

    try {
      const first = await invoke(url, "createProject", "卡片项目甲", "甲描述")
      expect(first.status).toBe(200)
      const firstBody = await first.json() as { result: { projectId: string } }
      const second = await invoke(url, "createProject", "卡片项目乙", "乙描述")
      expect(second.status).toBe(200)
      const secondBody = await second.json() as { result: { projectId: string } }

      const summaries = await (await invoke(url, "listProjectSummaries")).json() as {
        result: Array<{
          projectId: string
          name: string
          description?: string
          requirementCount: number
          teambitionProjectId?: string
          updatedAt?: string
        }>
      }
      expect(summaries.result.length).toBeGreaterThanOrEqual(2)
      const created = summaries.result.filter((item) => (
        item.projectId === firstBody.result.projectId
        || item.projectId === secondBody.result.projectId
      ))
      expect(created).toHaveLength(2)

      const pageHtml = await (await fetch(url)).text()
      expect(pageHtml).toContain("id=\"hubCards\"")
      expect(pageHtml).toContain(".hub-card {")
      expect(pageHtml).toMatch(/\.hub-card\s*\{[^}]*border:\s*1px solid/)
      expect(pageHtml).toMatch(/\.hub-cards\s*\{[^}]*display:\s*grid/)

      const rendererSource = await (await fetch(new URL("/renderer.js", url))).text()
      expect(rendererSource).toContain("function buildHubCardsMarkup(")
      const buildHubCardsMarkup = loadBuildHubCardsMarkup(rendererSource)

      const empty = buildHubCardsMarkup([])
      expect(empty).toMatchObject({ kind: "empty", html: "" })

      const nomatch = buildHubCardsMarkup(created, { filter: "绝不可能匹配的筛选词-xyz" })
      expect(nomatch.kind).toBe("nomatch")
      expect(nomatch.html).toContain("empty-state")
      expect(nomatch.html).not.toContain("hub-card")

      const built = buildHubCardsMarkup(created)
      expect(built.kind).toBe("cards")
      const cardMatches = built.html.match(/<article class="hub-card/g) || []
      expect(cardMatches).toHaveLength(created.length)
      for (const item of created) {
        expect(built.html).toContain(`data-project-id="${item.projectId}"`)
        expect(built.html).toContain(item.name)
        expect(built.html).toContain(item.projectId)
      }
      expect(built.html).toContain("需求")
      expect(built.html).toContain("未绑定 Teambition")
    } finally {
      await server.close()
    }
  })

  it("路由应区分项目页 tab 并支持看板/列表/甘特/设置深链", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf-8")
    const start = source.indexOf("function routeFromHash()")
    expect(start).toBeGreaterThanOrEqual(0)
    let depth = 0
    let end = -1
    for (let index = start; index < source.length; index++) {
      const char = source[index]
      if (char === "{") depth++
      else if (char === "}") {
        depth--
        if (depth === 0) {
          end = index + 1
          break
        }
      }
    }
    expect(end).toBeGreaterThan(start)
    const run = (hash: string) => runInNewContext(
      `${source.slice(start, end)}; routeFromHash()`,
      { location: { hash }, encodeURIComponent, decodeURIComponent },
    ) as {
      view: string
      projectId?: string
      projectTab?: string
      requirementId?: string
    }
    expect(run("#hub")).toEqual({ view: "hub" })
    expect(run("#project/demo")).toEqual({ view: "project", projectId: "demo", projectTab: "board" })
    expect(run("#project/demo/board")).toEqual({ view: "project", projectId: "demo", projectTab: "board" })
    expect(run("#project/demo/list")).toEqual({ view: "project", projectId: "demo", projectTab: "list" })
    expect(run("#project/demo/gantt")).toEqual({ view: "project", projectId: "demo", projectTab: "gantt" })
    expect(run("#project/demo/settings")).toEqual({ view: "project", projectId: "demo", projectTab: "settings" })
    expect(run("#requirement/req_1")).toEqual({ view: "workspace", requirementId: "req_1" })
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
      octopus?: { importTasks(requirementId: string): Promise<unknown> }
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
    await expect(windowObject.octopus?.importTasks("requirement-test")).rejects.toThrow()
  })
})

describe("OmniPlan RPC 注册", () => {
  it("web.ts 应注册 exportProjectOmniPlan / importProjectOmniPlan / setProjectOmniPlanMeta", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/web.ts"), "utf-8")
    expect(source).toContain('"exportProjectOmniPlan"')
    expect(source).toContain('"importProjectOmniPlan"')
    expect(source).toContain('"setProjectOmniPlanMeta"')
  })

  it("main.ts 应注册 OmniPlan IPC handler", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/main.ts"), "utf-8")
    expect(source).toContain('"octopus:exportProjectOmniPlan"')
    expect(source).toContain('"octopus:importProjectOmniPlan"')
    expect(source).toContain('"octopus:setProjectOmniPlanMeta"')
  })

  it("browser-api.js 应注册 OmniPlan API 方法", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/browser-api.js"), "utf-8")
    expect(source).toContain("exportProjectOmniPlan:")
    expect(source).toContain("importProjectOmniPlan:")
    expect(source).toContain("setProjectOmniPlanMeta:")
  })
})

describe("BRD 设计 RPC 注册", () => {
  it("web.ts 应注册 BRD 配置与预览方法", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/web.ts"), "utf-8")
    expect(source).toContain('"getProjectBrdDesignConfig"')
    expect(source).toContain('"setProjectBrdDesignConfig"')
    expect(source).toContain('"previewBrdPrompts"')
  })

  it("main.ts / browser-api / renderer 应暴露 BRD 设置", () => {
    const main = readFileSync(join(process.cwd(), "packages/desktop/src/main.ts"), "utf-8")
    const api = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/browser-api.js"), "utf-8")
    const renderer = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf-8")
    expect(main).toContain('"octopus:getProjectBrdDesignConfig"')
    expect(main).toContain('"octopus:setProjectBrdDesignConfig"')
    expect(api).toContain("getProjectBrdDesignConfig:")
    expect(api).toContain("setProjectBrdDesignConfig:")
    expect(renderer).toContain("settingsSaveBrd")
    expect(renderer).toContain("BRD 设计")
    expect(renderer).toContain("BRD_PROMPT_META")
    expect(renderer).toContain("syncPromptEditor")
    expect(renderer).toContain("brdPromptDrafts")
    expect(renderer).toContain("恢复内置默认")
    expect(renderer).toContain("预览已保存提示词")
    expect(renderer).toContain("renderBrdPromptPreview")
  })

  it("提示词编辑器应保留跨类型草稿并分区展示预览", () => {
    const html = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/index.html"), "utf-8")
    const renderer = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf-8")
    const settingsSource = extractFunction(renderer, "renderProjectSettings")
    const previewSource = extractFunction(renderer, "renderBrdPromptPreview")
    expect(html).toContain(".brd-prompt-fields")
    expect(html).toContain(".brd-prompt-preview-card")
    expect(settingsSource).toContain("brdPromptDrafts[activePromptId]")
    expect(settingsSource).toContain("collectBrdPromptPatch(brdPromptDrafts")
    expect(settingsSource).toContain("settingsBrdPreviewRequirement")
    expect(settingsSource).toContain("includeSummarize: true")
    expect(previewSource).toContain('for (const [label, value] of [["system", item.system], ["user", item.prompt]])')
    expect(previewSource).toContain("content.textContent = value")
  })

  it("提示词保存应一次提交多类型草稿、恢复默认项并拒绝半条提示词", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf-8")
    const collect = loadCollectBrdPromptPatch(source)
    const valid = collect({
      generate: { system: "生成系统", user: "生成用户" },
      check: { system: "检查系统", user: "检查用户" },
    }, ["summarize-sources"])
    expect(valid).toEqual({
      prompts: {
        generate: { system: "生成系统", user: "生成用户" },
        check: { system: "检查系统", user: "检查用户" },
        "summarize-sources": null,
      },
    })
    expect(collect({ generate: { system: "仅 system", user: "" } }, []).invalid).toMatchObject({
      id: "generate",
    })
  })
})

describe("PR1 RPC 注册", () => {
  it("web.ts 应注册 PR1 方法", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/web.ts"), "utf-8")
    expect(source).toContain('"assignNode"')
    expect(source).toContain('"listMyWork"')
    expect(source).toContain('"getProjectOverview"')
    expect(source).toContain('"getIdentity"')
    expect(source).toContain('"setIdentity"')
  })

  it("main.ts 应注册 PR1 IPC handler", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/main.ts"), "utf-8")
    expect(source).toContain('"octopus:assignNode"')
    expect(source).toContain('"octopus:listMyWork"')
    expect(source).toContain('"octopus:getProjectOverview"')
    expect(source).toContain('"octopus:getIdentity"')
    expect(source).toContain('"octopus:setIdentity"')
  })

  it("browser-api.js 应注册 PR1 API 方法", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/browser-api.js"), "utf-8")
    expect(source).toContain("assignNode:")
    expect(source).toContain("listMyWork:")
    expect(source).toContain("getProjectOverview:")
    expect(source).toContain("getIdentity:")
    expect(source).toContain("setIdentity:")
  })

  it("web.ts updateRequirement 应透传 owner", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/web.ts"), "utf-8")
    expect(source).toContain('"owner"')
  })
})

describe("甘特里程碑支持", () => {
  it("gantt.js 应包含 kind: \"milestone\" 处理", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/gantt.js"), "utf-8")
    expect(source).toContain('kind: "milestone"')
    expect(source).toContain('kind: "milestones"')
  })

  it("gantt.js 应包含添加里程碑工具栏按钮", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/gantt.js"), "utf-8")
    expect(source).toContain('data-action="add-milestone"')
    expect(source).toContain("添加里程碑")
  })

  it("gantt.js 应包含菱形绘制函数 drawDiamond", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/gantt.js"), "utf-8")
    expect(source).toContain("drawDiamond")
    expect(source).toContain("gantt-diamond")
  })

  it("gantt.js 应支持里程碑 onSchedule 回调 kind 参数", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/gantt.js"), "utf-8")
    expect(source).toContain('callbacks.onSchedule?.(result.nodeId, { date: result.previewDate }, "milestone")')
  })

  it("gantt.js 应包含 isMilestoneOverdue 函数", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/gantt.js"), "utf-8")
    expect(source).toContain("isMilestoneOverdue")
  })

  it("renderer.js 应传递 milestones 给甘特渲染", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf-8")
    expect(source).toContain("milestones: hubGanttState.milestones")
  })

  it("renderer.js 应包含里程碑回调接线", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf-8")
    expect(source).toContain("onReach:")
    expect(source).toContain("onSelectMilestone:")
    expect(source).toContain("onAddMilestone:")
  })

  it("index.html 应包含里程碑行 CSS", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/index.html"), "utf-8")
    expect(source).toContain("gantt-row-milestones")
    expect(source).toContain("gantt-row-milestone")
    expect(source).toContain("gantt-diamond")
  })

  it("gantt.js 应包含达成按钮及 onReach 触发", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/gantt.js"), "utf-8")
    expect(source).toContain("gantt-reach-btn")
    expect(source).toContain("data-reach-milestone")
    expect(source).toContain("callbacks.onReach?.(")
  })

  it("gantt.js 应传递 requirementId 到里程碑行", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/gantt.js"), "utf-8")
    expect(source).toContain("requirementId")
  })

  it("renderer.js onSelectMilestone 应先切换工作区再打开表单", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf-8")
    expect(source).toContain("openWorkspace(expandedScheduleId).then(() => openMilestoneForm(m))")
  })

  it("renderer.js renderHubGantt 应传递 requirementId", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf-8")
    expect(source).toContain("requirementId: hubGanttState.requirementId")
  })

  it("index.html 应包含达成按钮样式", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/index.html"), "utf-8")
    expect(source).toContain("gantt-reach-btn")
  })
})

describe("buildKanbanMarkup", () => {
  it("空项目应返回 kind:empty", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf8")
    const build = loadBuildKanbanMarkup(source)
    const result = build([])
    expect(result).toMatchObject({ kind: "empty", html: "" })
  })

  it("无匹配筛选应返回 kind:nomatch", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf8")
    const build = loadBuildKanbanMarkup(source)
    const items = [
      { requirementId: "req_1", requirementName: "支付改版", currentPhase: "Design", completedTasks: 1, totalTasks: 3 },
    ]
    const result = build(items, { filter: "不存在的筛选词" })
    expect(result.kind).toBe("nomatch")
    expect(result.html).toContain("empty-state")
    expect(result.html).not.toContain("kanban-card")
  })

  it("需求应按阶段分列渲染", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf8")
    const build = loadBuildKanbanMarkup(source)
    const items = [
      { requirementId: "req_1", requirementName: "支付改版", currentPhase: "Intention", completedTasks: 0, totalTasks: 3 },
      { requirementId: "req_2", requirementName: "搜索优化", currentPhase: "Design", completedTasks: 1, totalTasks: 5 },
      { requirementId: "req_3", requirementName: "会员体系", currentPhase: "Intention", completedTasks: 0, totalTasks: 2 },
    ]
    const result = build(items)
    expect(result.kind).toBe("cards")
    expect(result.html).toContain("kanban-board")
    expect(result.html).toContain("data-phase=\"Intention\"")
    expect(result.html).toContain("data-phase=\"Design\"")
    expect(result.html).toContain("kanban-column-count")
    const intentionMatch = result.html.match(/data-phase="Intention"[\s\S]*?<span class="kanban-column-count">(\d+)<\/span>/)
    expect(intentionMatch?.[1]).toBe("2")
    expect(result.html).toContain("req_1")
    expect(result.html).toContain("req_2")
    expect(result.html).toContain("req_3")
  })

  it("筛选应保留列但过滤卡片", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf8")
    const build = loadBuildKanbanMarkup(source)
    const items = [
      { requirementId: "req_1", requirementName: "支付改版", currentPhase: "Intention", completedTasks: 0, totalTasks: 3 },
      { requirementId: "req_2", requirementName: "搜索优化", currentPhase: "Design", completedTasks: 1, totalTasks: 5 },
    ]
    const result = build(items, { filter: "支付" })
    expect(result.kind).toBe("cards")
    expect(result.filtered).toHaveLength(1)
    expect(result.html).toContain("req_1")
    expect(result.html).not.toContain("req_2")
  })
})

describe("看板 tab HTML 结构", () => {
  it("index.html 应包含项目标签页", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/index.html"), "utf-8")
    expect(source).toContain("project-tab-btn")
    expect(source).toContain("data-tab=\"board\"")
    expect(source).toContain("data-tab=\"list\"")
    expect(source).toContain("data-tab=\"gantt\"")
    expect(source).toContain("data-tab=\"settings\"")
    expect(source).toContain("kanbanBoard")
    expect(source).toContain("projectSettings")
    expect(source).toContain("projectGanttHost")
  })

  it("renderer.js 应包含看板渲染和拖拽逻辑", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf-8")
    const renderProjectPageSource = extractFunction(source, "renderProjectPage")
    expect(source).toContain("function renderKanbanBoard(")
    expect(source).toContain("function renderProjectSettings(")
    expect(source).toContain("function syncProjectTabs(")
    expect(source).toContain("setupKanbanDragDrop")
    expect(source).toContain("kanbanDragData")
    expect(source).toContain("moveRequirementPhase")
    expect(renderProjectPageSource).toContain('const kanbanEmptyEl = document.getElementById("kanbanEmpty")')
  })
})

describe("Element Plus UI", () => {
  it("应通过官方组件包构建反馈 API，并渐进增强静态和动态控件", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "packages/desktop/package.json"), "utf-8"),
    ) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
    }
    const entry = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/element-plus-entry.js"),
      "utf-8",
    )
    const adapter = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/element-plus-adapter.js"),
      "utf-8",
    )
    const renderer = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/renderer.js"),
      "utf-8",
    )

    expect(packageJson.dependencies["element-plus"]).toBe("2.14.4")
    expect(packageJson.dependencies.vue).toBe("3.5.41")
    expect(packageJson.scripts.build).toContain("build:renderer")
    expect(entry).toContain("ElMessage")
    expect(entry).toContain("ElMessageBox")
    expect(entry).toContain('element-plus/dist/index.css')
    expect(adapter).toContain('query("button").forEach(enhanceButton)')
    expect(adapter).toContain("MutationObserver")
    expect(adapter).toContain('className = "el-input el-input--small octopus-el-control"')
    expect(renderer).toContain("confirmAction(")
    expect(renderer).not.toContain("window.confirm(`删除")
  })
})

describe("项目甘特模块 (PR4)", () => {
  it("gantt.js 应支持 requirements 模式", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/gantt.js"), "utf-8")
    expect(source).toContain("buildRequirementsModel")
    expect(source).toContain("mode === \"requirements\"")
    expect(source).toContain("kind: \"requirement\"")
    expect(source).toContain("data-toggle-req")
  })

  it("gantt.js 工具条应包含导出/导入 OmniPlan 按钮", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/gantt.js"), "utf-8")
    expect(source).toContain("export-omniplan")
    expect(source).toContain("import-omniplan")
    expect(source).toContain("onExportOmniPlan")
    expect(source).toContain("onImportOmniPlan")
  })

  it("gantt.js onSchedule 应传递 kind 参数", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/gantt.js"), "utf-8")
    expect(source).toContain('"requirement"')
    expect(source).toContain('"node"')
  })

  it("gantt.js 应支持 onSelectRequirement 回调", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/gantt.js"), "utf-8")
    expect(source).toContain("onSelectRequirement")
  })

  it("renderer.js 应包含项目甘特管理函数", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf-8")
    expect(source).toContain("function ensureProjectGanttMounted(")
    expect(source).toContain("function renderProjectGantt(")
    expect(source).toContain("function unmountProjectGantt(")
    expect(source).toContain("projectGanttHostEl")
    expect(source).toContain("updateRequirementSchedule")
    expect(source).toContain("exportProjectOmniPlan")
    expect(source).toContain("importProjectOmniPlan")
  })

  it("renderer.js gantt tab 应挂载项目甘特", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/renderer.js"), "utf-8")
    expect(source).toContain("renderProjectGantt()")
    expect(source).toContain("unmountProjectGantt()")
  })

  it("index.html 应包含全宽甘特宿主", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/index.html"), "utf-8")
    expect(source).toContain("projectGanttHost")
    expect(source).toContain("project-gantt-host")
  })

  it("index.html 应包含需求行 CSS", () => {
    const source = readFileSync(join(process.cwd(), "packages/desktop/src/renderer/index.html"), "utf-8")
    expect(source).toContain("gantt-row-requirement")
    expect(source).toContain("gantt-chip-req")
  })
})
