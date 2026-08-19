import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  TeambitionVersionClient,
  createTeambitionVersionClient,
  buildVersionUrl,
  unwrapVersionList,
  mapVersion,
  redactSecrets,
  sanitizeFixture,
} from "./teambition-version.js"
import type { TbVersion } from "./teambition-version.js"
import listVersionsFixture from "../fixtures/teambition-version/list-versions.json" with { type: "json" }
import getVersionFixture from "../fixtures/teambition-version/get-version.json" with { type: "json" }

function mockResponse(body: unknown, status = 200, ok?: boolean) {
  return {
    ok: ok ?? status < 400,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("TeambitionVersionClient", () => {
  describe("healthCheck", () => {
    it("returns success:false with Chinese message when unconfigured", async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock
      const client = new TeambitionVersionClient({})
      const result = await client.healthCheck()
      expect(result.success).toBe(false)
      expect(result.message).toContain("未配置")
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("with credentials but unconfirmed list returns success:false and 0 fetch", async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.healthCheck()
      expect(result.success).toBe(false)
      expect(result.message).toContain("尚未确认")
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe("JWT authentication", () => {
    it("sends lowercase authorization header with HS256 JWT containing _appId", async () => {
      let authHeader = ""
      globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
        authHeader = opts?.headers?.authorization ?? opts?.headers?.Authorization ?? ""
        return Promise.resolve(mockResponse({}))
      })
      const client = new TeambitionVersionClient({ appId: "test-app", appSecret: "test-secret", orgId: "test-org" })
      const result = await client.updateVersionNote("repo1", "ver1", "hello")
      expect(result.success).toBe(true)
      expect(authHeader.startsWith("Bearer ")).toBe(true)

      const token = authHeader.replace("Bearer ", "")
      const parts = token.split(".")
      expect(parts).toHaveLength(3)
      const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString())
      expect(header.alg).toBe("HS256")
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString())
      expect(payload._appId).toBe("test-app")
      expect(payload.exp).toBeGreaterThan(payload.iat)
    })
  })

  describe("auto auth fallback", () => {
    it("retries with session cookie after 401 when sessionCookie configured", async () => {
      const calls: Array<{ headers: Record<string, string> }> = []
      globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
        calls.push(opts)
        if (calls.length === 1) return Promise.resolve(mockResponse("unauthorized", 401))
        return Promise.resolve(mockResponse({}))
      })
      const client = new TeambitionVersionClient({
        appId: "a",
        appSecret: "s",
        orgId: "o",
        sessionCookie: "sid=abc123",
      })
      const result = await client.updateVersionNote("r", "v", "x")
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(2)
      expect(calls[1]!.headers["Cookie"]).toBe("sid=abc123")
    })

    it("does not retry when no session credentials configured", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse("unauthorized", 401))
      globalThis.fetch = fetchMock
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.updateVersionNote("r", "v", "x")
      expect(result.success).toBe(false)
      expect(result.message).toContain("鉴权失败")
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe("updateVersionNote", () => {
    it("sends correct URL, body, headers and optional Referer", async () => {
      const calls: Array<{ url: string; init: any }> = []
      globalThis.fetch = vi.fn().mockImplementation((url: string, init: any) => {
        calls.push({ url, init })
        return Promise.resolve(mockResponse({ result: { note: "server-note" } }))
      })
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "org" })
      const result = await client.updateVersionNote("repo1", "ver1", "note-text", {
        tbProjectId: "proj1",
        pluginId: "plug1",
      })
      expect(result.success).toBe(true)
      expect(result.message).toBe("版本说明已更新")
      expect(result.data).toEqual({ repoId: "repo1", versionId: "ver1", note: "server-note" })

      const call = calls[0]!
      expect(call.url).toBe("https://www.teambition.com/version-manage/api/v1/repositories/repo1/versions/ver1/note")
      expect(JSON.parse(call.init.body)).toEqual({ note: "note-text" })
      expect(call.init.headers["x-timezone"]).toBe("8")
      expect(call.init.headers["accept"]).toBe("application/json")
      expect(call.init.headers["content-type"]).toBe("application/json")
      expect(call.init.headers["x-request-id"]).toBeTruthy()
      expect(call.init.headers["X-Tenant-Id"]).toBe("org")
      expect(call.init.headers["X-Tenant-Type"]).toBe("organization")
      const referer = call.init.headers["Referer"] ?? call.init.headers.referer
      expect(referer).toBe("https://www.teambition.com/project/proj1/plugin/plug1/repo/repo1/version/ver1")
    })

    it("omits Referer when ids cannot build a page URL", async () => {
      const calls: Array<{ init: any }> = []
      globalThis.fetch = vi.fn().mockImplementation((_url: string, init: any) => {
        calls.push({ init })
        return Promise.resolve(mockResponse({}))
      })
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.updateVersionNote("r", "v", "x")
      expect(result.success).toBe(true)
      const headers = calls[0]!.init.headers
      expect(headers["Referer"] ?? headers.referer).toBeUndefined()
    })

    it("keeps request note when response has no note field", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ ok: true }))
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.updateVersionNote("r", "v", "")
      expect(result.success).toBe(true)
      expect(result.data).toEqual({ repoId: "r", versionId: "v", note: "" })
    })

    it("validates note must be a string", async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.updateVersionNote("r", "v", 123 as unknown as string)
      expect(result.success).toBe(false)
      expect(result.message).toBe("note 必须是字符串")
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("returns Chinese failure message for HTTP 500", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ error: "server boom" }, 500))
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.updateVersionNote("r", "v", "x")
      expect(result.success).toBe(false)
      expect(result.message).toContain("更新版本说明失败")
      expect(result.message).toContain("500")
    })

    it("redacts session cookie from message and error on 401", async () => {
      const secretCookie = "session_cookie=abc123secret"
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse(`{"error":"unauthorized cookie=${secretCookie}"}`, 401))
      const client = new TeambitionVersionClient({
        appId: "a",
        appSecret: "s",
        orgId: "o",
        sessionCookie: secretCookie,
      })
      const result = await client.updateVersionNote("r", "v", "x")
      expect(result.success).toBe(false)
      expect(result.message).not.toContain(secretCookie)
      expect(result.error).not.toContain(secretCookie)
    })

    it("auth failure without referer appends pluginId/tbProjectId hint", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse("denied", 403))
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.updateVersionNote("r", "v", "x")
      expect(result.success).toBe(false)
      expect(result.message).toContain("补齐 pluginId 与 tbProjectId")
    })
  })

  describe("unconfirmed GET endpoints", () => {
    it("listVersions returns UNCONFIRMED Chinese with 0 fetch", async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.listVersions("repo1")
      expect(result.success).toBe(false)
      expect(result.message).toContain("版本列表端点尚未确认")
      expect(result.error).toBe("UNCONFIRMED_ENDPOINT")
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("getVersion returns UNCONFIRMED Chinese with 0 fetch", async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.getVersion("repo1", "ver1")
      expect(result.success).toBe(false)
      expect(result.message).toContain("版本详情端点尚未确认")
      expect(result.error).toBe("UNCONFIRMED_ENDPOINT")
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("getRepository returns UNCONFIRMED Chinese with 0 fetch", async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.getRepository("repo1")
      expect(result.success).toBe(false)
      expect(result.message).toContain("版本仓库端点尚未确认")
      expect(result.error).toBe("UNCONFIRMED_ENDPOINT")
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("listRepositories returns UNCONFIRMED Chinese with 0 fetch", async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.listRepositories({ tbProjectId: "p", pluginId: "pl" })
      expect(result.success).toBe(false)
      expect(result.message).toContain("版本仓库端点尚未确认")
      expect(result.error).toBe("UNCONFIRMED_ENDPOINT")
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe("argument validation", () => {
    it("empty repoId does not fetch", async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.listVersions("")
      expect(result.success).toBe(false)
      expect(result.message).toBe("repoId 不能为空")
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("empty versionId does not fetch", async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock
      const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      const result = await client.getVersion("r", "")
      expect(result.success).toBe(false)
      expect(result.message).toBe("versionId 不能为空")
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe("factory function", () => {
    it("createTeambitionVersionClient creates configured client", () => {
      const client = createTeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
      expect(client).toBeInstanceOf(TeambitionVersionClient)
      expect(client.name).toBe("teambition-version")
    })
  })
})

describe("buildVersionUrl", () => {
  it("returns TB page URL when all four ids present (fixed www host)", () => {
    expect(buildVersionUrl({ tbProjectId: "p", pluginId: "pl", repoId: "r", versionId: "v" })).toBe(
      "https://www.teambition.com/project/p/plugin/pl/repo/r/version/v",
    )
  })

  it("returns undefined when any id is missing and does not follow versionManageBase", () => {
    expect(buildVersionUrl({ tbProjectId: "p", repoId: "r", versionId: "v" })).toBeUndefined()
    expect(buildVersionUrl({ pluginId: "pl", repoId: "r", versionId: "v" })).toBeUndefined()
    expect(buildVersionUrl({ repoId: "r", versionId: "v" })).toBeUndefined()
    expect(buildVersionUrl({ tbProjectId: "p", pluginId: "pl", repoId: "r", versionId: "" })).toBeUndefined()
  })
})

describe("unwrapVersionList", () => {
  it("handles all candidate envelopes", () => {
    const item = { id: "v1" }
    const cases: Array<[unknown, unknown[]]> = [
      [[item], [item]],
      [{ result: [item] }, [item]],
      [{ data: [item] }, [item]],
      [{ items: [item] }, [item]],
      [{ versions: [item] }, [item]],
      [{ result: { list: [item] } }, [item]],
      [{ data: { list: [item] } }, [item]],
    ]
    for (const [input, expected] of cases) {
      expect(unwrapVersionList(input)).toEqual(expected)
    }
  })

  it("returns [] for unknown envelopes", () => {
    expect(unwrapVersionList({ foo: "bar" })).toEqual([])
    expect(unwrapVersionList(null)).toEqual([])
    expect(unwrapVersionList("nope")).toEqual([])
    expect(unwrapVersionList(42)).toEqual([])
  })
})

describe("mapVersion", () => {
  it("maps the list fixture through unwrapVersionList", () => {
    const versions = unwrapVersionList(listVersionsFixture)
      .map((item) => mapVersion(item, "id_repo"))
      .filter((v): v is TbVersion => v !== null)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({
      versionId: "id_ver",
      repoId: "id_repo",
      name: "2026.08.19",
      status: "规划中",
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      note: "https://example.test/note",
    })
  })

  it("maps the get-version detail fixture (getVersion maps through this)", () => {
    const detail = (getVersionFixture as { result: unknown }).result
    const version = mapVersion(detail, "id_repo")
    expect(version).not.toBeNull()
    expect(version).toMatchObject({
      versionId: "id_ver",
      repoId: "id_repo",
      name: "2026.08.19",
      status: "规划中",
    })
  })

  it("returns null when versionId is missing and defaults name to versionId", () => {
    expect(mapVersion({ name: "x" }, "r")).toBeNull()
    expect(mapVersion("string", "r")).toBeNull()
    const version = mapVersion({ id: "v1" }, "r")
    expect(version).not.toBeNull()
    expect(version!.name).toBe("v1")
  })

  it("falls back across candidate keys", () => {
    const version = mapVersion({ _id: "a", title: "T", state: "S", start: "2026-01-01", dueDate: "2026-02-01" }, "r")
    expect(version).toMatchObject({
      versionId: "a",
      name: "T",
      status: "S",
      startDate: "2026-01-01",
      endDate: "2026-02-01",
    })
  })
})

describe("redactSecrets", () => {
  it("removes secret literals, Cookie/authorization header lines and truncates", () => {
    const text = `line1\nCookie: sid=topsecret\nauthorization: Bearer abc\nsecret is topsecret\n${"x".repeat(400)}`
    const out = redactSecrets(text, ["topsecret"])
    expect(out).not.toContain("topsecret")
    expect(out).not.toContain("Cookie: sid")
    expect(out).not.toContain("authorization: Bearer")
    expect(out.length).toBeLessThanOrEqual(300)
  })
})

describe("sanitizeFixture", () => {
  it("removes token keys and replaces real URLs and ids", () => {
    const input = {
      accessToken: "secret-token",
      cookie: "sid=1",
      email: "a@example.com",
      tenant: "aaaabbbbccccddddeeeeffff",
      url: "https://docs.example.com/sheet/abc",
      items: [
        { id: "1234567890abcdef12345678", name: "张三", phone: "13800138000", title: "版本A" },
        { id: "1234567890abcdef12345678", note: "https://x.dev/a" },
      ],
    }
    const out = sanitizeFixture(input) as Record<string, unknown>
    expect("accessToken" in out).toBe(false)
    expect("cookie" in out).toBe(false)
    expect("email" in out).toBe(false)
    expect(out["tenant"]).toBe("id_repo")
    expect(out["url"]).toBe("https://example.test/note")
    const items = out["items"] as unknown[]
    expect((items[0] as Record<string, unknown>)["id"]).toBe("id_ver")
    expect((items[0] as Record<string, unknown>)["name"]).toBe("redacted")
    expect((items[0] as Record<string, unknown>)["phone"]).toBe("redacted")
    expect(items[1]).toEqual({ id: "id_ver", note: "https://example.test/note" })
  })

  it("assigns id kinds in order of appearance and stays stable", () => {
    const out = sanitizeFixture({
      a: "111111111111111111111111",
      b: "222222222222222222222222",
      c: "333333333333333333333333",
      d: "444444444444444444444444",
      e: "555555555555555555555555",
      a2: "111111111111111111111111",
    }) as Record<string, unknown>
    expect(out["a"]).toBe("id_repo")
    expect(out["b"]).toBe("id_ver")
    expect(out["c"]).toBe("id_proj")
    expect(out["d"]).toBe("id_plugin")
    expect(out["e"]).toBe("id_tenant")
    expect(out["a2"]).toBe("id_repo")
  })
})