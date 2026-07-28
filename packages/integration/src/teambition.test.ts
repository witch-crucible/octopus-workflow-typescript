import { describe, it, expect, vi, beforeEach } from "vitest"
import { TeambitionClient, createTeambitionClient } from "./teambition.js"
import type { TaskUpdate } from "./teambition.js"

function mockResponse(body: unknown, status = 200, ok?: boolean) {
  return {
    ok: ok ?? status < 400,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("TeambitionClient", () => {
  describe("healthCheck", () => {
    it("returns success:false when credentials are missing", async () => {
      const client = new TeambitionClient({ appId: "", appSecret: "", orgId: "" })
      const result = await client.healthCheck()
      expect(result.success).toBe(false)
      expect(result.message).toContain("未配置")
    })

    it("returns success:true when API responds", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ result: [] }))
      const client = new TeambitionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.healthCheck()
      expect(result.success).toBe(true)
    })
  })

  describe("JWT authentication", () => {
    it("sends HS256 JWT in Authorization header", async () => {
      let authHeader = ""
      globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
        authHeader = opts?.headers?.["authorization"] ?? ""
        return Promise.resolve(mockResponse({ result: [] }))
      })
      const client = new TeambitionClient({ appId: "test-app", appSecret: "test-secret", orgId: "test-org" })
      await client.healthCheck()

      const token = authHeader.replace("Bearer ", "")
      const parts = token.split(".")
      expect(parts).toHaveLength(3)

      const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString())
      expect(header.alg).toBe("HS256")
      expect(header.typ).toBe("JWT")

      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString())
      expect(payload._appId).toBe("test-app")
      expect(payload.exp).toBeGreaterThan(payload.iat)
    })

    it("includes X-Tenant-Id and X-Tenant-Type headers", async () => {
      let headers: Record<string, string> = {}
      globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
        headers = opts?.headers ?? {}
        return Promise.resolve(mockResponse({ result: [] }))
      })
      const client = new TeambitionClient({ appId: "a", appSecret: "s", orgId: "test-org" })
      await client.healthCheck()

      expect(headers["X-Tenant-Id"]).toBe("test-org")
      expect(headers["X-Tenant-Type"]).toBe("organization")
    })
  })

  describe("resolveTask", () => {
    it("prefix strategy: DIOR-123 -> project -> TQL -> detail", async () => {
      const calls: string[] = []
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        calls.push(url)
        if (url.includes("uniqueIdPrefix=DIOR")) {
          return Promise.resolve(mockResponse({ result: [{ id: "proj-1", uniqueIdPrefix: "DIOR" }] }))
        }
        if (url.includes("all-task/search")) {
          return Promise.resolve(mockResponse({ result: ["task-1"] }))
        }
        if (url.includes("task/query?taskId=")) {
          return Promise.resolve(mockResponse({
            result: [{ taskId: "task-1", content: "Test Task", projectId: "proj-1", isDone: false, tfsId: "st-1" }],
          }))
        }
        if (url.includes("taskflowstatus/search")) {
          return Promise.resolve(mockResponse({ result: [{ id: "st-1", name: "进行中" }] }))
        }
        return Promise.resolve(mockResponse({}))
      })
      const client = new TeambitionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.resolveTask("DIOR-123")
      expect(result.success).toBe(true)
      const task = result.data as any
      expect(task.ref).toBe("DIOR-123")
      expect(task.title).toBe("Test Task")
      expect(task.status).toBe("进行中")
      expect(calls.some((c) => c.includes("uniqueIdPrefix=DIOR"))).toBe(true)
      expect(calls.some((c) => c.includes("all-task/search"))).toBe(true)
    })

    it("shortid strategy: direct shortIds query", async () => {
      const calls: string[] = []
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        calls.push(url)
        if (url.includes("task/query?shortIds=")) {
          return Promise.resolve(mockResponse({
            result: [{ taskId: "t-1", content: "ShortId Task", projectId: "proj-1", isDone: false }],
          }))
        }
        return Promise.resolve(mockResponse({}))
      })
      const client = new TeambitionClient({ appId: "a", appSecret: "s", orgId: "o", refStrategy: "shortid" })
      const result = await client.resolveTask("DIOR-456")
      expect(result.success).toBe(true)
      expect(calls.some((c) => c.includes("shortIds=DIOR-456"))).toBe(true)
    })

    it("tql strategy: enterprise-wide uniqueId search", async () => {
      const calls: string[] = []
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        calls.push(url)
        if (url.includes("all-task/search")) {
          return Promise.resolve(mockResponse({ result: ["task-789"] }))
        }
        if (url.includes("task/query?taskId=")) {
          return Promise.resolve(mockResponse({
            result: [{ taskId: "task-789", content: "TQL Task", projectId: "proj-1", isDone: false }],
          }))
        }
        return Promise.resolve(mockResponse({}))
      })
      const client = new TeambitionClient({ appId: "a", appSecret: "s", orgId: "o", refStrategy: "tql" })
      const result = await client.resolveTask("789")
      expect(result.success).toBe(true)
      expect(calls.some((c) => c.includes("all-task/search"))).toBe(true)
    })
  })

  describe("updateTask", () => {
    it("sends one PUT when only statusId is provided", async () => {
      const putCalls: string[] = []
      globalThis.fetch = vi.fn().mockImplementation((url: string, opts: any) => {
        if (opts?.method === "PUT") putCalls.push(url)
        return Promise.resolve(mockResponse({}))
      })
      const client = new TeambitionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const update: TaskUpdate = { taskId: "t-1", statusId: "st-2", operatorId: "op-1" }
      const result = await client.updateTask(update)
      expect(result.success).toBe(true)
      expect(putCalls).toHaveLength(1)
      expect(putCalls[0]).toContain("taskflowstatus")
    })

    it("sends four PUTs when all fields are provided", async () => {
      const putCalls: string[] = []
      globalThis.fetch = vi.fn().mockImplementation((url: string, opts: any) => {
        if (opts?.method === "PUT") putCalls.push(url)
        return Promise.resolve(mockResponse({}))
      })
      const client = new TeambitionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const update: TaskUpdate = {
        taskId: "t-1",
        statusId: "st-2",
        executorId: "ex-3",
        startDate: "2026-07-01",
        dueDate: "2026-07-15",
        operatorId: "op-1",
      }
      const result = await client.updateTask(update)
      expect(result.success).toBe(true)
      expect(putCalls).toHaveLength(4)
    })

    it("returns error when operatorId is missing", async () => {
      const client = new TeambitionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const update: TaskUpdate = { taskId: "t-1", statusId: "st-2" }
      const result = await client.updateTask(update)
      expect(result.success).toBe(false)
      expect(result.message).toContain("operatorId")
    })
  })

  describe("gateway error handling", () => {
    it("handles HTTP 200 with body.code >= 400 as error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockResponse({ code: 403, errorCode: "FORBIDDEN", errorMessage: "无权限" }, 200, true),
      )
      const client = new TeambitionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.resolveProject("DIOR")
      expect(result.success).toBe(false)
      expect(result.message).toContain("403")
    })
  })

  describe("factory function", () => {
    it("createTeambitionClient creates configured client", () => {
      const client = createTeambitionClient({ appId: "a", appSecret: "s", orgId: "o" })
      expect(client).toBeInstanceOf(TeambitionClient)
      expect(client.name).toBe("teambition")
    })
  })
})
