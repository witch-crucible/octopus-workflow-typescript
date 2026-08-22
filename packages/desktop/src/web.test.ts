import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { createServer, request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { collectBrdPromptPatch } from "./renderer/lib/brd.ts"
import { buildWorkflowGraphNodes } from "./renderer/lib/graph-model.ts"
import { canonicalizeHash, routeFromHash } from "./renderer/lib/hash-route.ts"
import {
  buildHubCardsModel,
  buildKanbanModel,
  buildRequirementCardsModel,
  milestoneBadgeData,
} from "./renderer/lib/view-models.ts"
import {
  OctopusGantt,
  buildRequirementsModel,
  milestoneDiamondPoints,
} from "./renderer/visualizations/gantt.ts"
import { createOctopusWebServer, stopExistingOctopusWeb } from "./web.js"

const temporaryDirectories: string[] = []
const childProcesses: ChildProcess[] = []
const rendererDir = join(process.cwd(), "packages/desktop/dist/renderer")

function assertRendererBuild(): void {
  expect(existsSync(join(rendererDir, "index.html")), "missing dist/renderer; run pnpm --filter @octopus/desktop build:renderer").toBe(
    true,
  )
}

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
      probe.close((error) => (error ? reject(error) : resolvePort(port)))
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
    const outgoing = request(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: endpoint.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          resolveRequest({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
          })
        })
      },
    )
    outgoing.on("error", reject)
    outgoing.end(body)
  })
}

describe("Octopus Web", () => {
  afterEach(() => {
    for (const child of childProcesses.splice(0)) {
      if (child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGKILL")
        } catch {
          /* 已退出 */
        }
      }
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("应提供 SPA 壳页与真实项目/需求 API，并允许同一状态库创建多个项目", async () => {
    assertRendererBuild()
    const root = mkdtempSync(join(tmpdir(), "octopus-web-"))
    temporaryDirectories.push(root)
    const server = await createOctopusWebServer({
      port: 0,
      storeDir: join(root, "store"),
      projectRoot: join(root, "project"),
      rendererDir,
    })
    const url = await server.listen()

    try {
      const page = await fetch(url)
      const html = await page.text()
      expect(html).toContain("Octopus Workflow")
      expect(html).toContain('id="root"')
      expect(html).toMatch(/<script\s+type="module"/)
      expect(html).toMatch(/assets\/[^"'>\s]+\.js/)
      expect(html).toMatch(/assets\/[^"'>\s]+\.css/)
      expect(html).toContain('rel="icon"')
      expect(html).toContain("app-icon")
      expect(html).not.toContain("element-plus")
      expect(html).not.toContain("element-plus-adapter")
      expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
      expect(page.headers.get("x-frame-options")).toBe("DENY")

      const appIcon = await fetch(new URL("/app-icon.png", url))
      expect(appIcon.ok).toBe(true)
      expect(appIcon.headers.get("content-type")).toContain("image/png")
      expect(Buffer.byteLength(await appIcon.arrayBuffer())).toBeGreaterThan(1000)

      const assetNames = readdirSync(join(rendererDir, "assets"))
      expect(assetNames.some((name) => /logo.*\.png$/i.test(name) || name === "logo.png")).toBe(true)
      expect(assetNames.some((name) => /mascot.*\.jpe?g$/i.test(name))).toBe(true)
      expect(
        existsSync(join(rendererDir, "logo.png")) ||
          assetNames.some((name) => /logo/i.test(name)),
      ).toBe(true)
      expect(
        existsSync(join(rendererDir, "mascot.jpg")) ||
          assetNames.some((name) => /mascot/i.test(name)),
      ).toBe(true)

      const logoPath = existsSync(join(rendererDir, "logo.png"))
        ? "/logo.png"
        : `/assets/${assetNames.find((name) => /logo/i.test(name))}`
      const mascotPath = existsSync(join(rendererDir, "mascot.jpg"))
        ? "/mascot.jpg"
        : `/assets/${assetNames.find((name) => /mascot/i.test(name))}`
      const logo = await fetch(new URL(logoPath, url))
      expect(logo.ok).toBe(true)
      expect(Buffer.byteLength(await logo.arrayBuffer())).toBeGreaterThan(1000)
      const mascot = await fetch(new URL(mascotPath, url))
      expect(mascot.ok).toBe(true)
      expect(Buffer.byteLength(await mascot.arrayBuffer())).toBeGreaterThan(1000)

      expect(await (await invoke(url, "canInit")).json()).toEqual({ result: true })

      const createdProject = await invoke(url, "createProject", "Web Test Project", "desc")
      expect(createdProject.status).toBe(200)
      const createdProjectBody = (await createdProject.json()) as {
        result: { projectId: string; name: string }
      }
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
      const initializedBody = (await initialized.json()) as {
        result: { projectId: string; requirementId: string; requirementName: string }
      }
      expect(readFileSync(join(root, "project", "workflow.yaml"), "utf-8")).toContain("name:")
      expect(initializedBody.result.requirementName).toBe("Web Test Requirement")

      expect(await (await invoke(url, "listProjects")).json()).toEqual({
        result: [createdProjectBody.result.projectId],
      })
      expect(
        await (await invoke(url, "listRequirements", createdProjectBody.result.projectId)).json(),
      ).toEqual({
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
      const definition = await invoke(
        url,
        "getWorkflowDefinition",
        initializedBody.result.requirementId,
      )
      expect(definition.status).toBe(200)
      const definitionBody = (await definition.json()) as {
        result: { nodes: Array<{ key: string; responsibleRoles: string[] }> }
      }
      expect(definitionBody.result.nodes.length).toBeGreaterThan(2)
      expect(definitionBody.result.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "prd-walkthrough",
            responsibleRoles: ["BA", "PM", "DEV", "SA"],
          }),
        ]),
      )

      const secondProject = await invoke(url, "createProject", "Repeated Project")
      expect(secondProject.status).toBe(200)
      const secondProjectBody = (await secondProject.json()) as { result: { projectId: string } }
      const repeated = await invoke(
        url,
        "initRequirement",
        secondProjectBody.result.projectId,
        "Repeated Requirement",
        undefined,
        join(root, "project-two"),
      )
      expect(repeated.status).toBe(200)
      const repeatedBody = (await repeated.json()) as { result: { requirementId: string } }

      const summaries = (await (await invoke(url, "listProjectSummaries")).json()) as {
        result: Array<{ projectId: string; name: string; requirementCount: number }>
      }
      expect(summaries.result.map((item) => item.projectId)).toEqual(
        expect.arrayContaining([
          createdProjectBody.result.projectId,
          secondProjectBody.result.projectId,
        ]),
      )
      expect(
        summaries.result.find((item) => item.projectId === createdProjectBody.result.projectId)
          ?.requirementCount,
      ).toBe(1)

      const renamed = await invoke(url, "updateProjectMeta", createdProjectBody.result.projectId, {
        name: "Renamed Web Project",
      })
      expect(renamed.status).toBe(200)
      expect(await renamed.json()).toMatchObject({
        result: { projectId: createdProjectBody.result.projectId, name: "Renamed Web Project" },
      })

      const stateBody = (await (
        await invoke(url, "getState", initializedBody.result.requirementId)
      ).json()) as {
        result: { steps: Array<{ id: string }> }
      }
      const nodeId = stateBody.result.steps[0]?.id
      expect(nodeId).toBeTruthy()
      const workspace = await invoke(
        url,
        "resolveNodeWorkspace",
        initializedBody.result.requirementId,
        nodeId,
      )
      expect(workspace.status).toBe(200)
      expect(await workspace.json()).toMatchObject({
        result: {
          nodeKey: expect.stringMatching(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          path: expect.stringContaining(`${join(root, "project")}/workflow/nodes/`),
          exists: true,
        },
      })
      const scheduled = await invoke(
        url,
        "updateNodeSchedule",
        initializedBody.result.requirementId,
        nodeId,
        {
          plannedStart: "2026-04-01",
          plannedEnd: "2026-04-03",
        },
      )
      expect(scheduled.status).toBe(200)
      expect(await scheduled.json()).toMatchObject({
        result: { nodeId, plannedStart: "2026-04-01", plannedEnd: "2026-04-03" },
      })
      const addedMilestone = await invoke(
        url,
        "addMilestone",
        initializedBody.result.requirementId,
        {
          name: "设计评审",
          date: "2026-03-12",
        },
      )
      expect(addedMilestone.status).toBe(200)
      const addedMilestoneBody = (await addedMilestone.json()) as {
        result: { id: string; name: string }
      }
      expect(addedMilestoneBody.result.name).toBe("设计评审")
      const requirementSummaries = (await (
        await invoke(url, "listRequirementSummaries", createdProjectBody.result.projectId)
      ).json()) as {
        result: Array<{
          requirementId: string
          milestoneCount?: number
          nextMilestone?: { name: string }
        }>
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

  it("空状态库重启后仍应允许初始化", async () => {
    assertRendererBuild()
    const root = mkdtempSync(join(tmpdir(), "octopus-web-empty-restart-"))
    temporaryDirectories.push(root)
    const options = {
      port: 0,
      storeDir: join(root, "store"),
      projectRoot: join(root, "project"),
      rendererDir,
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
      const projectBody = (await project.json()) as { result: { projectId: string } }
      expect(
        (
          await invoke(
            restartedUrl,
            "initRequirement",
            projectBody.result.projectId,
            "Restarted Requirement",
          )
        ).status,
      ).toBe(200)
    } finally {
      await restarted.close()
    }
  })

  it("应拒绝伪造 Host 与跨源 Origin，同时允许无 Origin 的本地客户端", async () => {
    assertRendererBuild()
    const root = mkdtempSync(join(tmpdir(), "octopus-web-origin-"))
    temporaryDirectories.push(root)
    const server = await createOctopusWebServer({
      port: 0,
      storeDir: join(root, "store"),
      rendererDir,
    })
    const url = await server.listen()
    const allowedUrl = new URL(url)

    try {
      expect(await rawInvoke(url, { Host: allowedUrl.host })).toMatchObject({ status: 200 })
      expect(
        await rawInvoke(url, { Host: allowedUrl.host, Origin: allowedUrl.origin }),
      ).toMatchObject({ status: 200 })
      expect(await rawInvoke(url, { Host: `evil.example:${allowedUrl.port}` })).toMatchObject({
        status: 403,
        body: { error: "请求 Host 不受信任" },
      })
      expect(
        await rawInvoke(url, {
          Host: allowedUrl.host,
          Origin: `http://evil.example:${allowedUrl.port}`,
        }),
      ).toMatchObject({
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

    spawnListener(
      octopusPort,
      `
      require("http").createServer((request, response) => {
        if (request.url === "/api" && request.method === "POST") {
          response.setHeader("Content-Type", "application/json")
          response.end(JSON.stringify({ result: [] }))
          return
        }
        response.statusCode = 404
        response.end()
      }).listen(process.env.TEST_PORT, "127.0.0.1")
    `,
    )
    const foreign = spawnListener(
      foreignPort,
      `
      require("http").createServer((_request, response) => {
        response.end("other")
      }).listen(process.env.TEST_PORT, "127.0.0.1")
    `,
    )
    await waitForChildListen(host, octopusPort)
    await waitForChildListen(host, foreignPort)

    expect(await stopExistingOctopusWeb(host, octopusPort)).toBe(true)
    await expect(
      fetch(`http://${host}:${octopusPort}/`, { signal: AbortSignal.timeout(400) }),
    ).rejects.toThrow()

    await expect(stopExistingOctopusWeb(host, foreignPort)).rejects.toThrow(/已被进程/)
    expect(foreign.exitCode).toBeNull()
    expect(await (await fetch(`http://${host}:${foreignPort}/`)).text()).toBe("other")

    expect(await stopExistingOctopusWeb(host, octopusPort)).toBe(false)
  })

  it("项目管理中心应按摘要卡片模型渲染每个项目", async () => {
    assertRendererBuild()
    const root = mkdtempSync(join(tmpdir(), "octopus-web-cards-"))
    temporaryDirectories.push(root)
    const server = await createOctopusWebServer({
      port: 0,
      storeDir: join(root, "store"),
      projectRoot: join(root, "project"),
      rendererDir,
    })
    const url = await server.listen()

    try {
      const first = await invoke(url, "createProject", "卡片项目甲", "甲描述")
      expect(first.status).toBe(200)
      const firstBody = (await first.json()) as { result: { projectId: string } }
      const second = await invoke(url, "createProject", "卡片项目乙", "乙描述")
      expect(second.status).toBe(200)
      const secondBody = (await second.json()) as { result: { projectId: string } }

      const summaries = (await (await invoke(url, "listProjectSummaries")).json()) as {
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
      const created = summaries.result.filter(
        (item) =>
          item.projectId === firstBody.result.projectId ||
          item.projectId === secondBody.result.projectId,
      )
      expect(created).toHaveLength(2)

      const pageHtml = await (await fetch(url)).text()
      expect(pageHtml).toContain("Octopus Workflow")
      expect(pageHtml).toContain('id="root"')
      expect(pageHtml).not.toContain("element-plus")

      expect(buildHubCardsModel([]).kind).toBe("empty")
      const nomatch = buildHubCardsModel(created, { filter: "绝不可能匹配的筛选词-xyz" })
      expect(nomatch.kind).toBe("nomatch")
      expect(nomatch.filtered).toHaveLength(0)

      const built = buildHubCardsModel(created, { lastCreatedId: firstBody.result.projectId })
      expect(built.kind).toBe("cards")
      if (built.kind === "cards") {
        expect(built.items).toHaveLength(created.length)
        for (const item of created) {
          const card = built.items.find((entry) => entry.projectId === item.projectId)
          expect(card?.displayName).toBe(item.name)
          expect(card?.teambitionBound).toBe(Boolean(item.teambitionProjectId))
        }
        expect(built.items.find((entry) => entry.projectId === firstBody.result.projectId)?.highlight).toBe(
          true,
        )
      }
    } finally {
      await server.close()
    }
  })

  it("浏览器 transport 源码应对非法 JSON 文件拒绝而不是悬挂", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/browser-api.ts"),
      "utf-8",
    )
    expect(source).toContain("JSON.parse(await file.text())")
    expect(source).toContain("reject(error)")
    expect(source).toContain("importTasks:")
    expect(() => JSON.parse("{")).toThrow()
  })
})

describe("view models", () => {
  it("需求卡片模型应按里程碑摘要产出徽章数据", () => {
    const base = {
      requirementId: "req_1",
      requirementName: "支付改版",
      description: "desc",
      currentPhase: "Design",
      completedTasks: 1,
      totalTasks: 2,
    }
    expect(milestoneBadgeData(base)).toBeNull()
    expect(
      milestoneBadgeData({
        ...base,
        milestoneCount: 2,
        nextMilestone: { id: "ms_1", name: "设计评审", date: "2026-03-12", overdue: false },
      }),
    ).toEqual({
      kind: "next",
      overdue: false,
      date: "03-12",
      name: "设计评审",
    })
    expect(
      milestoneBadgeData({
        ...base,
        milestoneCount: 1,
        nextMilestone: { id: "ms_1", name: "上线", date: "2026-03-01", overdue: true },
      }),
    ).toMatchObject({ kind: "next", overdue: true, name: "上线" })
    expect(milestoneBadgeData({ ...base, milestoneCount: 1 })).toEqual({ kind: "done" })

    const cards = buildRequirementCardsModel(
      [
        {
          ...base,
          milestoneCount: 2,
          nextMilestone: { id: "ms_1", name: "设计评审", date: "2026-03-12", overdue: false },
        },
      ],
      {},
    )
    expect(cards.kind).toBe("cards")
    if (cards.kind === "cards") {
      expect(cards.items[0]?.milestoneBadge).toEqual({
        kind: "next",
        overdue: false,
        date: "03-12",
        name: "设计评审",
      })
      expect(cards.items[0]?.phaseLabelText).toBe("设计")
    }
  })

  it("看板模型应按阶段分列，成功 kind 为 columns", () => {
    const items = [
      {
        requirementId: "req_1",
        requirementName: "支付改版",
        description: "d1",
        currentPhase: "Intention",
        completedTasks: 0,
        totalTasks: 3,
        plannedStart: "2026-01-10",
        plannedEnd: "2026-01-20",
      },
      {
        requirementId: "req_2",
        requirementName: "搜索优化",
        description: "d2",
        currentPhase: "Design",
        completedTasks: 1,
        totalTasks: 5,
      },
      {
        requirementId: "req_3",
        requirementName: "会员体系",
        description: "d3",
        currentPhase: "Intention",
        completedTasks: 0,
        totalTasks: 2,
      },
    ]
    expect(buildKanbanModel([], {}).kind).toBe("empty")
    expect(buildKanbanModel(items, { filter: "不存在的筛选词" }).kind).toBe("nomatch")

    const model = buildKanbanModel(items, { lastCreatedId: "req_2" })
    expect(model.kind).toBe("columns")
    if (model.kind === "columns") {
      expect(model.columns.length).toBeGreaterThan(2)
      const intention = model.columns.find((column) => column.phase === "Intention")
      const design = model.columns.find((column) => column.phase === "Design")
      expect(intention?.cards).toHaveLength(2)
      expect(design?.cards).toHaveLength(1)
      expect(design?.cards[0]?.highlight).toBe(true)
      expect(intention?.cards[0]?.scheduleText).toContain("→")
    }

    const filtered = buildKanbanModel(items, { filter: "支付" })
    expect(filtered.kind).toBe("columns")
    if (filtered.kind === "columns") {
      expect(filtered.filtered).toHaveLength(1)
      expect(filtered.filtered[0]?.requirementId).toBe("req_1")
      expect(filtered.columns.every((column) => column.phase)).toBe(true)
    }
  })
})

describe("hash routing", () => {
  it("路由应区分项目页 tab 并支持看板/列表/甘特/设置深链", () => {
    expect(routeFromHash("#hub")).toEqual({ view: "hub" })
    expect(routeFromHash("#project/demo")).toEqual({
      view: "project",
      projectId: "demo",
      projectTab: "board",
    })
    expect(routeFromHash("#project/demo/board")).toEqual({
      view: "project",
      projectId: "demo",
      projectTab: "board",
    })
    expect(routeFromHash("#project/demo/list")).toEqual({
      view: "project",
      projectId: "demo",
      projectTab: "table",
    })
    expect(routeFromHash("#project/demo/gantt")).toEqual({
      view: "project",
      projectId: "demo",
      projectTab: "gantt",
    })
    expect(routeFromHash("#project/demo/logs")).toEqual({
      view: "project",
      projectId: "demo",
      projectTab: "logs",
    })
    expect(routeFromHash("#project/demo/settings")).toEqual({
      view: "project",
      projectId: "demo",
      projectTab: "settings",
    })
    expect(routeFromHash("#requirement/req_1")).toEqual({
      view: "workspace",
      requirementId: "req_1",
    })
    expect(canonicalizeHash("#project/demo/list")).toBe("project/demo/table")
    expect(canonicalizeHash("project/demo/table")).toBeNull()
  })
})

describe("workflow graph model", () => {
  it("需求节点泳道应合并完整定义、显示多角色并标记未激活节点", () => {
    const nodes = buildWorkflowGraphNodes(
      { steps: [{ id: "10.1", responsibleRole: "PM", status: "PENDING", dependsOn: [] }] },
      {
        nodeIdMapping: { first: "10.1", second: "10.2" },
        nodes: [
          {
            key: "first",
            phase: "Intention",
            name: "First",
            description: "",
            responsibleRoles: ["PM"],
            dependsOn: [],
            actions: [],
          },
          {
            key: "second",
            phase: "Intention",
            name: "Second",
            description: "",
            responsibleRoles: ["PM", "BA"],
            dependsOn: ["first"],
            actions: [],
          },
        ],
      },
    )
    expect(nodes).toEqual([
      expect.objectContaining({
        id: "10.1",
        status: "PENDING",
        activated: true,
        responsibleRoles: ["PM"],
      }),
      expect.objectContaining({
        id: "10.2",
        status: "LOCKED",
        activated: false,
        responsibleRoles: ["PM", "BA"],
      }),
    ])
    expect(nodes[1]?.dependsOn).toEqual(["10.1"])

    const workspace = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/views/WorkspaceView.tsx"),
      "utf-8",
    )
    expect(workspace).toContain("buildWorkflowGraphNodes(")
    expect(workspace).toContain("nodeRoles")
  })
})

describe("gantt visualization exports", () => {
  it("应导出 requirements 模型、菱形点与 OctopusGantt API", () => {
    const model = buildRequirementsModel({
      requirements: [
        {
          id: "req-1",
          name: "Alpha",
          plannedStart: "2026-01-01",
          plannedEnd: "2026-01-10",
          steps: [],
        },
      ],
    })
    expect(model.rows.some((row) => row.kind === "requirement")).toBe(true)
    const points = milestoneDiamondPoints(10, 20, 7)
    expect(points.length).toBeGreaterThan(0)
    expect(points).toContain(",")
    expect(typeof OctopusGantt.mount).toBe("function")
    expect(typeof OctopusGantt.render).toBe("function")

    const source = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/visualizations/gantt.ts"),
      "utf-8",
    )
    expect(source).toContain('kind: "milestone"')
    expect(source).toContain('data-action="add-milestone"')
    expect(source).toContain("drawDiamond")
    expect(source).toContain("gantt-diamond")
    expect(source).toContain("isMilestoneOverdue")
    expect(source).toContain("onSelectRequirement")
    expect(source).toContain("export-omniplan")
    expect(source).toContain("onReach")
    expect(source).toContain("onAddMilestone")
  })

  it("ProjectView 应通过 GanttHost 接线甘特回调", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/views/ProjectView.tsx"),
      "utf-8",
    )
    expect(source).toContain("GanttHost")
    expect(source).toContain("onSelectRequirement")
    expect(source).toContain("exportProjectOmniPlan")
    expect(source).toContain("importProjectOmniPlan")
    expect(source).toContain("updateRequirementSchedule")
    expect(source).toContain('value="gantt"')
    expect(source).toContain('value="board"')
    expect(source).toContain("KanbanBoard")
    expect(source).toContain("ProjectLogs")
    expect(source).toContain("ProjectSettings")
    expect(source).toContain("RequirementTable")
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

  it("browser-api.ts 应注册 OmniPlan API 方法", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/browser-api.ts"),
      "utf-8",
    )
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

  it("main.ts / browser-api / ProjectSettings 应暴露 BRD 设置", () => {
    const main = readFileSync(join(process.cwd(), "packages/desktop/src/main.ts"), "utf-8")
    const api = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/browser-api.ts"),
      "utf-8",
    )
    const settings = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/views/project/ProjectSettings.tsx"),
      "utf-8",
    )
    expect(main).toContain('"octopus:getProjectBrdDesignConfig"')
    expect(main).toContain('"octopus:setProjectBrdDesignConfig"')
    expect(api).toContain("getProjectBrdDesignConfig:")
    expect(api).toContain("setProjectBrdDesignConfig:")
    expect(settings).toContain("collectBrdPromptPatch")
    expect(settings).toContain("brdPromptDrafts")
    expect(settings).toContain("BRD")
  })

  it("提示词保存应一次提交多类型草稿、恢复默认项并拒绝半条提示词", () => {
    const valid = collectBrdPromptPatch(
      {
        generate: { system: "生成系统", user: "生成用户" },
        check: { system: "检查系统", user: "检查用户" },
      },
      ["summarize-sources"],
    )
    expect(valid).toEqual({
      prompts: {
        generate: { system: "生成系统", user: "生成用户" },
        check: { system: "检查系统", user: "检查用户" },
        "summarize-sources": null,
      },
    })
    expect(collectBrdPromptPatch({ generate: { system: "仅 system", user: "" } }, []).invalid).toMatchObject({
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

  it("browser-api.ts 应注册 PR1 API 方法", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/browser-api.ts"),
      "utf-8",
    )
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

describe("日志监控模块", () => {
  it("四层 API 应暴露 readRunLogs", () => {
    const web = readFileSync(join(process.cwd(), "packages/desktop/src/web.ts"), "utf-8")
    const main = readFileSync(join(process.cwd(), "packages/desktop/src/main.ts"), "utf-8")
    const preload = readFileSync(join(process.cwd(), "packages/desktop/src/preload.cjs"), "utf-8")
    const api = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/browser-api.ts"),
      "utf-8",
    )
    expect(web).toContain('"readRunLogs"')
    expect(main).toContain('"octopus:readRunLogs"')
    expect(preload).toContain("readRunLogs:")
    expect(api).toContain("readRunLogs:")
  })

  it("ProjectLogs 应包含日志读取与轮询逻辑", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/views/project/ProjectLogs.tsx"),
      "utf-8",
    )
    expect(source).toContain("readRunLogs")
    expect(source).toContain("ProjectLogs")
  })
})

describe("React UI stack", () => {
  it("package.json 应使用 React + Tailwind，且不再依赖 Vue / Element Plus", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "packages/desktop/package.json"), "utf-8"),
    ) as {
      scripts: Record<string, string>
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies }
    expect(deps.react).toBeTruthy()
    expect(deps["react-dom"]).toBeTruthy()
    expect(deps.tailwindcss).toBeTruthy()
    expect(deps["element-plus"]).toBeUndefined()
    expect(deps.vue).toBeUndefined()
    expect(packageJson.scripts.build).toContain("build:renderer")
  })

  it("App.tsx 应装配 Hub/Project/Workspace 与 ConfirmHost/confirmAction", () => {
    const appPath = join(process.cwd(), "packages/desktop/src/renderer/App.tsx")
    expect(existsSync(appPath)).toBe(true)
    const app = readFileSync(appPath, "utf-8")
    const hub = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/views/HubView.tsx"),
      "utf-8",
    )
    const feedback = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/lib/feedback.ts"),
      "utf-8",
    )
    const confirmHost = readFileSync(
      join(process.cwd(), "packages/desktop/src/renderer/components/layout/ConfirmHost.tsx"),
      "utf-8",
    )

    expect(app).toContain("ProjectView")
    expect(app).toContain("WorkspaceView")
    expect(app).toContain("HubView")
    expect(app).toContain("ConfirmHost")
    expect(app).toContain("confirmAction")
    expect(feedback).toContain("export function confirmAction")
    expect(confirmHost).toContain("ConfirmHost")

    expect(app).not.toMatch(/window\.confirm\s*\(\s*[`'"].*删除/)
    expect(hub).not.toMatch(/window\.confirm\s*\(\s*[`'"].*删除/)
    expect(hub).toContain("confirmAction(")
  })
})
