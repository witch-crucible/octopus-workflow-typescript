import { createHmac, randomUUID } from "node:crypto"
import type { IntegrationResult } from "./index.js"

// ── 类型定义 ──────────────────────────────────────────

export type TbVersionAuthMode = "auto" | "app-jwt" | "session" | "user-token"

export interface TeambitionVersionConfig {
  appId?: string
  appSecret?: string
  orgId?: string
  /** 默认 https://www.teambition.com */
  versionManageBase?: string
  sessionCookie?: string
  userAccessToken?: string
  /** 默认 auto：先 app JWT，401/403 且有会话凭据时重试一次 */
  versionAuth?: TbVersionAuthMode
  /** 默认 15000 */
  timeoutMs?: number
}

export interface TbVersion {
  versionId: string
  repoId: string
  name: string
  status?: string
  /** 原样字符串，不做 TZ 换算 */
  startDate?: string
  endDate?: string
  note?: string
  /** 由 buildVersionUrl 填 */
  url?: string
  /** 仅测试 / 探针；引擎不要依赖 */
  raw?: unknown
}

export interface TbVersionRepository {
  repoId: string
  name?: string
  pluginId?: string
  tbProjectId?: string
}

// ── 端点常量（PR1 全部 unconfirmed；探针实际 2xx 后才逐个改为 confirmed）──

export const VERSION_LIST_ENDPOINT: "unconfirmed" | "confirmed" = "unconfirmed"
export const VERSION_LIST_PATH = "/version-manage/api/v1/repositories/:repoId/versions"
export const VERSION_DETAIL_ENDPOINT: "unconfirmed" | "confirmed" = "unconfirmed"
export const VERSION_DETAIL_PATH = "/version-manage/api/v1/repositories/:repoId/versions/:versionId"
export const VERSION_REPO_ENDPOINT: "unconfirmed" | "confirmed" = "unconfirmed"
export const VERSION_REPO_PATH = "/version-manage/api/v1/repositories/:repoId"
export const VERSION_REPO_LIST_ENDPOINT: "unconfirmed" | "confirmed" = "unconfirmed"
export const VERSION_REPO_LIST_PATH = "/version-manage/api/v1/projects/:tbProjectId/plugins/:pluginId/repositories"

// ── 工具函数 ──────────────────────────────────────────

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url")
}

function signAppToken(appId: string, appSecret: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64({ alg: "HS256", typ: "JWT" })
  const payload = b64({ _appId: appId, iat: now, exp: now + 3600 })
  const head = `${header}.${payload}`
  const sig = createHmac("sha256", appSecret).update(head).digest("base64url")
  return `${head}.${sig}`
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/**
 * TB 网页 URL，host 写死 www.teambition.com。
 * 不用 versionManageBase（那是 API origin，可被测服覆盖）。
 */
export function buildVersionUrl(ids: {
  tbProjectId?: string
  pluginId?: string
  repoId: string
  versionId: string
}): string | undefined {
  const { tbProjectId, pluginId, repoId, versionId } = ids
  if (!tbProjectId || !pluginId || !repoId || !versionId) return undefined
  return `https://www.teambition.com/project/${tbProjectId}/plugin/${pluginId}/repo/${repoId}/version/${versionId}`
}

/** 从 JSON 抽出版本数组。候选信封：自身即数组，或 result / data / items / versions，或 result.list / data.list。 */
export function unwrapVersionList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>
    for (const key of ["result", "data", "items", "versions"]) {
      const value = obj[key]
      if (Array.isArray(value)) return value as unknown[]
    }
    for (const key of ["result", "data"]) {
      const value = obj[key]
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const inner = (value as Record<string, unknown>)["list"]
        if (Array.isArray(inner)) return inner as unknown[]
      }
    }
  }
  return []
}

/** 字段映射必须集中在此。缺 versionId 丢弃；name 缺省为 versionId。 */
export function mapVersion(raw: unknown, repoId: string): TbVersion | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const versionId = firstString(obj["id"], obj["_id"], obj["versionId"])
  if (!versionId) return null
  const version: TbVersion = {
    versionId,
    repoId,
    name: firstString(obj["name"], obj["title"], obj["versionName"]) ?? versionId,
    raw,
  }
  const status = firstString(obj["status"], obj["state"], obj["statusName"])
  if (status !== undefined) version.status = status
  const startDate = firstString(obj["startDate"], obj["start"], obj["planStart"], obj["beginDate"])
  if (startDate !== undefined) version.startDate = startDate
  const endDate = firstString(obj["endDate"], obj["end"], obj["planEnd"], obj["dueDate"])
  if (endDate !== undefined) version.endDate = endDate
  const note = firstString(obj["note"], obj["description"])
  if (note !== undefined) version.note = note
  return version
}

/** 去掉 secret 字面量、Cookie:/authorization: 行；截断 300 字。 */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[REDACTED]")
  }
  const lines = out.split(/\r?\n/)
  const scrubbed = lines.map((line) =>
    /^(cookie|authorization)\s*:/i.test(line.trim()) ? "[REDACTED_HEADER]" : line,
  )
  return scrubbed.join("\n").slice(0, 300)
}

/**
 * 脱敏探针输出：
 * - 24 位 hex / 像 TB id 的字符串 → id_repo / id_ver / id_proj / id_plugin / id_tenant（按出现顺序稳定替换）
 * - http(s):// URL → https://example.test/note
 * - 键名匹配 /cookie|token|authorization|secret|email/i 的字段删除
 * - 中文姓名 / 手机号 → redacted
 */
export function sanitizeFixture(value: unknown): unknown {
  const idKinds = ["id_repo", "id_ver", "id_proj", "id_plugin", "id_tenant"]
  const idMap = new Map<string, string>()

  function walk(v: unknown): unknown {
    if (typeof v === "string") {
      if (/^https?:\/\//.test(v)) return "https://example.test/note"
      if (/^[0-9a-f]{24}$/i.test(v)) {
        const existing = idMap.get(v)
        if (existing) return existing
        const kind = idKinds[idMap.size % idKinds.length]!
        idMap.set(v, kind)
        return kind
      }
      if (/[\u4e00-\u9fff]/u.test(v) || /^1[3-9]\d{9}$/.test(v)) return "redacted"
      return v
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(v)) {
        if (/cookie|token|authorization|secret|email/i.test(key)) continue
        out[key] = walk(value)
      }
      return out
    }
    return v
  }

  return walk(value)
}

// ── 内部错误 ──────────────────────────────────────────

interface TbVersionHttpError extends Error {
  status?: number
  detail?: string
  httpText?: string
}

// ── Client ────────────────────────────────────────────

export class TeambitionVersionClient {
  readonly name = "teambition-version"
  private readonly appId: string | undefined
  private readonly appSecret: string | undefined
  private readonly orgId: string | undefined
  private readonly versionManageBase: string
  private readonly sessionCookie: string | undefined
  private readonly userAccessToken: string | undefined
  private readonly versionAuth: TbVersionAuthMode
  private readonly timeoutMs: number

  constructor(config: TeambitionVersionConfig) {
    this.appId = config.appId
    this.appSecret = config.appSecret
    this.orgId = config.orgId
    this.versionManageBase = config.versionManageBase ?? "https://www.teambition.com"
    this.sessionCookie = config.sessionCookie
    this.userAccessToken = config.userAccessToken
    this.versionAuth = config.versionAuth ?? "auto"
    this.timeoutMs = config.timeoutMs ?? 15_000
  }

  private get hasAppJwt(): boolean {
    return !!(this.appId && this.appSecret && this.orgId)
  }

  private get hasSession(): boolean {
    return !!(this.sessionCookie || this.userAccessToken)
  }

  private get isConfigured(): boolean {
    return this.hasAppJwt || this.hasSession
  }

  private get secrets(): string[] {
    const list: string[] = []
    if (this.sessionCookie) list.push(this.sessionCookie)
    if (this.userAccessToken) list.push(this.userAccessToken)
    if (this.appSecret) list.push(this.appSecret)
    return list
  }

  private redact(text: string): string {
    return redactSecrets(text, this.secrets)
  }

  private requestModes(): Array<"app-jwt" | "session" | "user-token"> {
    const mode = this.versionAuth
    if (mode === "app-jwt") return this.hasAppJwt ? ["app-jwt"] : []
    if (mode === "session") return this.sessionCookie ? ["session"] : []
    if (mode === "user-token") return this.userAccessToken ? ["user-token"] : []
    const modes: Array<"app-jwt" | "session" | "user-token"> = []
    if (this.hasAppJwt) modes.push("app-jwt")
    if (this.sessionCookie) modes.push("session")
    if (this.userAccessToken) modes.push("user-token")
    return modes
  }

  private async requestOnce(
    method: "GET" | "PUT",
    path: string,
    mode: "app-jwt" | "session" | "user-token",
    opts: { body?: unknown; referer?: string },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      "x-timezone": "8",
      "x-request-id": randomUUID(),
    }
    if (this.orgId) headers["X-Tenant-Id"] = this.orgId
    if (mode === "app-jwt") {
      headers["authorization"] = `Bearer ${signAppToken(this.appId!, this.appSecret!)}`
      headers["X-Tenant-Type"] = "organization"
    } else if (mode === "session" && this.sessionCookie) {
      headers["Cookie"] = this.sessionCookie
    } else if (mode === "user-token" && this.userAccessToken) {
      headers["authorization"] = `Bearer ${this.userAccessToken}`
    }
    if (opts.referer) headers["Referer"] = opts.referer

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const init: RequestInit & { headers: Record<string, string> } = {
        method,
        headers,
        signal: ctrl.signal,
      }
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
      const res = await fetch(`${this.versionManageBase}${path}`, init)
      const text = await res.text()
      const scrubbed = this.redact(text)
      if (!res.ok) {
        const err = new Error(`TB ${res.status} ${method} ${path}: ${scrubbed}`) as TbVersionHttpError
        err.status = res.status
        err.httpText = scrubbed
        throw err
      }
      return text ? JSON.parse(text) : {}
    } catch (cause) {
      if (cause instanceof Error && (cause as TbVersionHttpError).status !== undefined) throw cause
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new Error(this.redact(message))
    } finally {
      clearTimeout(timer)
    }
  }

  private async request(
    method: "GET" | "PUT",
    path: string,
    opts: { body?: unknown; referer?: string } = {},
  ): Promise<unknown> {
    const modes = this.requestModes()
    if (modes.length === 0) {
      throw new Error("Teambition 版本管理未配置（缺少 app JWT 或会话凭据）")
    }
    const failures: string[] = []
    for (const mode of modes) {
      try {
        return await this.requestOnce(method, path, mode, opts)
      } catch (cause) {
        const status = Number((cause as TbVersionHttpError).status ?? 0)
        if (status === 401 || status === 403) {
          failures.push(cause instanceof Error ? cause.message : String(cause))
          continue
        }
        throw cause
      }
    }
    const err = new Error("Teambition 版本管理鉴权失败（app JWT 与会话均被拒绝）") as TbVersionHttpError
    err.status = 401
    err.detail = this.redact(failures.join(" | "))
    throw err
  }

  private unwrapHttpError(cause: unknown): { message: string; status: number; detail: string; httpText: string } {
    const status = Number((cause as TbVersionHttpError).status ?? 0)
    const message = cause instanceof Error ? cause.message : String(cause)
    return {
      message,
      status,
      detail: (cause as TbVersionHttpError).detail ?? message,
      httpText: (cause as TbVersionHttpError).httpText ?? message,
    }
  }

  // ── 健康检查 ──────────────────────────────────────

  async healthCheck(): Promise<IntegrationResult> {
    if (!this.isConfigured) {
      return { success: false, message: "Teambition 版本管理未配置（缺少 app JWT 或会话凭据）" }
    }
    if (VERSION_LIST_ENDPOINT === "unconfirmed") {
      return {
        success: false,
        message: "Teambition 版本管理凭据已配置，但远端列表端点尚未确认（需先跑契约探针）",
      }
    }
    try {
      await this.request("GET", "/version-manage/api/v1/")
      return { success: true, message: "Teambition 版本管理 API 可达" }
    } catch (cause) {
      const { message, status, detail } = this.unwrapHttpError(cause)
      if (status === 401 || status === 403) {
        return { success: false, message: "Teambition 版本管理鉴权失败（app JWT 与会话均被拒绝）", error: detail }
      }
      return { success: false, message: `Teambition 版本管理不可用: ${message}`, error: message }
    }
  }

  // ── 仓库 ──────────────────────────────────────────

  async listRepositories(query: { tbProjectId?: string; pluginId?: string }): Promise<IntegrationResult> {
    if (VERSION_REPO_LIST_ENDPOINT === "unconfirmed") {
      return { success: false, message: "Teambition 版本仓库端点尚未确认（需先跑契约探针）", error: "UNCONFIRMED_ENDPOINT" }
    }
    try {
      const tbProjectId = query?.tbProjectId ?? ""
      const pluginId = query?.pluginId ?? ""
      const path = VERSION_REPO_LIST_PATH
        .replace(":tbProjectId", encodeURIComponent(tbProjectId))
        .replace(":pluginId", encodeURIComponent(pluginId))
      const json = await this.request("GET", path)
      const unwrapped =
        Array.isArray(json) ? json : Array.isArray((json as Record<string, unknown>)?.["result"])
          ? ((json as Record<string, unknown>)["result"] as unknown[])
          : []
      const repos = unwrapped.map(mapRepository).filter((r): r is TbVersionRepository => r !== null)
      return { success: true, message: `获取到 ${repos.length} 个版本仓库`, data: repos }
    } catch (cause) {
      const { message, status, detail } = this.unwrapHttpError(cause)
      if (status === 401 || status === 403) {
        return { success: false, message, error: detail }
      }
      return { success: false, message: `获取版本仓库列表失败: ${message}`, error: message }
    }
  }

  async getRepository(repoId: string): Promise<IntegrationResult> {
    if (!repoId) return { success: false, message: "repoId 不能为空" }
    if (VERSION_REPO_ENDPOINT === "unconfirmed") {
      return { success: false, message: "Teambition 版本仓库端点尚未确认（需先跑契约探针）", error: "UNCONFIRMED_ENDPOINT" }
    }
    try {
      const path = VERSION_REPO_PATH.replace(":repoId", encodeURIComponent(repoId))
      const json = await this.request("GET", path)
      const repo = mapRepository(pickDetailObject(json))
      if (!repo) return { success: false, message: "版本仓库无法解析" }
      return { success: true, message: "版本仓库获取成功", data: repo }
    } catch (cause) {
      const { message, status, detail } = this.unwrapHttpError(cause)
      if (status === 401 || status === 403) {
        return { success: false, message, error: detail }
      }
      return { success: false, message: `获取版本仓库失败: ${message}`, error: message }
    }
  }

  // ── 版本 ──────────────────────────────────────────

  async listVersions(repoId: string): Promise<IntegrationResult> {
    if (!repoId) return { success: false, message: "repoId 不能为空" }
    if (VERSION_LIST_ENDPOINT === "unconfirmed") {
      return { success: false, message: "Teambition 版本列表端点尚未确认（需先跑契约探针）", error: "UNCONFIRMED_ENDPOINT" }
    }
    try {
      const path = VERSION_LIST_PATH.replace(":repoId", encodeURIComponent(repoId))
      const json = await this.request("GET", path)
      const versions = unwrapVersionList(json)
        .map((item) => mapVersion(item, repoId))
        .filter((v): v is TbVersion => v !== null)
      return { success: true, message: `获取到 ${versions.length} 个版本`, data: versions }
    } catch (cause) {
      const { message, status, detail } = this.unwrapHttpError(cause)
      if (status === 401 || status === 403) {
        return { success: false, message, error: detail }
      }
      return { success: false, message: `获取版本列表失败: ${message}`, error: message }
    }
  }

  async getVersion(repoId: string, versionId: string): Promise<IntegrationResult> {
    if (!repoId) return { success: false, message: "repoId 不能为空" }
    if (!versionId) return { success: false, message: "versionId 不能为空" }
    if (VERSION_DETAIL_ENDPOINT === "unconfirmed") {
      return { success: false, message: "Teambition 版本详情端点尚未确认（需先跑契约探针）", error: "UNCONFIRMED_ENDPOINT" }
    }
    try {
      const path = VERSION_DETAIL_PATH
        .replace(":repoId", encodeURIComponent(repoId))
        .replace(":versionId", encodeURIComponent(versionId))
      const json = await this.request("GET", path)
      const version = mapVersion(pickDetailObject(json), repoId)
      if (!version) return { success: false, message: "版本详情无法解析" }
      return { success: true, message: "版本详情获取成功", data: version }
    } catch (cause) {
      const { message, status, detail } = this.unwrapHttpError(cause)
      if (status === 401 || status === 403) {
        return { success: false, message, error: detail }
      }
      return { success: false, message: `获取版本详情失败: ${message}`, error: message }
    }
  }

  // ── 写 note（路径/body CONFIRMED；鉴权 UNCONFIRMED）──

  async updateVersionNote(
    repoId: string,
    versionId: string,
    note: string,
    ids?: { tbProjectId?: string; pluginId?: string },
  ): Promise<IntegrationResult> {
    if (!repoId) return { success: false, message: "repoId 不能为空" }
    if (!versionId) return { success: false, message: "versionId 不能为空" }
    if (typeof note !== "string") return { success: false, message: "note 必须是字符串" }
    const urlIds: { tbProjectId?: string; pluginId?: string; repoId: string; versionId: string } = {
      repoId,
      versionId,
    }
    if (ids?.tbProjectId) urlIds.tbProjectId = ids.tbProjectId
    if (ids?.pluginId) urlIds.pluginId = ids.pluginId
    const referer = buildVersionUrl(urlIds)
    const path = `/version-manage/api/v1/repositories/${encodeURIComponent(repoId)}/versions/${encodeURIComponent(versionId)}/note`
    const opts: { body: { note: string }; referer?: string } = { body: { note } }
    if (referer) opts.referer = referer
    try {
      const json = await this.request("PUT", path, opts)
      const data: { repoId: string; versionId: string; note: string } = { repoId, versionId, note }
      const responseNote = extractNote(json)
      if (responseNote !== undefined) data.note = responseNote
      return { success: true, message: "版本说明已更新", data }
    } catch (cause) {
      const { message, status, detail, httpText } = this.unwrapHttpError(cause)
      if (status === 401 || status === 403) {
        return {
          success: false,
          message: referer ? message : `${message}若仍 403，请补齐 pluginId 与 tbProjectId 以便带 Referer`,
          error: detail,
        }
      }
      if (status > 0) {
        return {
          success: false,
          message: `更新版本说明失败: TB ${status} PUT /note: ${httpText.slice(0, 300)}`,
          error: message,
        }
      }
      return { success: false, message: `更新版本说明失败: ${message}`, error: message }
    }
  }
}

export function createTeambitionVersionClient(config: TeambitionVersionConfig): TeambitionVersionClient {
  return new TeambitionVersionClient(config)
}

// ── 内部辅助 ──────────────────────────────────────────

function pickDetailObject(json: unknown): unknown {
  if (Array.isArray(json)) return json[0]
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>
    if (obj["result"] !== undefined) return obj["result"]
    if (obj["data"] !== undefined) return obj["data"]
    return obj
  }
  return json
}

function mapRepository(raw: unknown): TbVersionRepository | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const repoId = firstString(obj["id"], obj["_id"], obj["repoId"])
  if (!repoId) return null
  const repo: TbVersionRepository = { repoId }
  const name = firstString(obj["name"])
  if (name !== undefined) repo.name = name
  const pluginId = firstString(obj["pluginId"])
  if (pluginId !== undefined) repo.pluginId = pluginId
  const tbProjectId = firstString(obj["tbProjectId"], obj["projectId"])
  if (tbProjectId !== undefined) repo.tbProjectId = tbProjectId
  return repo
}

function extractNote(json: unknown): string | undefined {
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>
    if (typeof obj["note"] === "string") return obj["note"]
    if (obj["result"] && typeof obj["result"] === "object") {
      const inner = obj["result"] as Record<string, unknown>
      if (typeof inner["note"] === "string") return inner["note"]
    }
  }
  return undefined
}