import { createHmac } from "node:crypto"
import type { IntegrationResult } from "./index.js"

// ── 类型定义 ──────────────────────────────────────────

export interface TbTask {
  ref: string
  taskId: string | null
  projectId: string | null
  title: string
  description: string
  status: string
  parentTaskId: string | null
  dueDate: string | null
  fields: Record<string, string>
  url: string | undefined
  source: "teambition"
}

export interface WorkflowStatus {
  id: string
  name: string
}

export interface ChildTask {
  taskId: string
  uniqueId: string
  title: string
  executorId: string
  executorName: string
  isDone: boolean
}

export interface TbMember {
  userId: string
  name: string
  position: string
  email?: string
}

export interface TaskUpdate {
  taskId: string
  statusId?: string
  startDate?: string
  dueDate?: string | null
  executorId?: string
  operatorId?: string
}

// ── 配置 ────────────────────────────────────────────

export interface TeambitionIntegrationConfig {
  appId: string
  appSecret: string
  orgId: string
  gatewayBase?: string
  refStrategy?: "prefix" | "shortid" | "tql"
  timeoutMs?: number
}

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

function numericRef(ref: string): string {
  const m = ref.match(/(\d+)/)
  return m ? m[1]! : ref
}

function splitRef(ref: string): { prefix: string; num: string } {
  const m = ref.match(/^([A-Za-z]+)-?(\d+)$/)
  if (m) return { prefix: m[1]!, num: m[2]! }
  return { prefix: "", num: numericRef(ref) }
}

function mapTbMember(m: any): TbMember {
  return {
    userId: String(m.userId ?? ""),
    name: String(m.name ?? ""),
    position: String(m.title ?? ""),
    email: String(m.email ?? undefined),
  }
}

// ── Client ────────────────────────────────────────────

export class TeambitionClient {
  readonly name = "teambition"
  private readonly appId: string
  private readonly appSecret: string
  private readonly orgId: string
  private readonly gatewayBase: string
  private readonly refStrategy: "prefix" | "shortid" | "tql"
  private readonly timeoutMs: number

  constructor(config: TeambitionIntegrationConfig) {
    this.appId = config.appId
    this.appSecret = config.appSecret
    this.orgId = config.orgId
    this.gatewayBase = config.gatewayBase ?? "https://open.teambition.com/api"
    this.refStrategy = config.refStrategy ?? "prefix"
    this.timeoutMs = config.timeoutMs ?? 15_000
  }

  private get isConfigured(): boolean {
    return !!(this.appId && this.appSecret && this.orgId)
  }

  private authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${signAppToken(this.appId, this.appSecret)}`,
      "X-Tenant-Id": this.orgId,
      "X-Tenant-Type": "organization",
      "content-type": "application/json",
    }
  }

  private async request(method: "GET" | "POST" | "PUT", path: string, body?: unknown, operatorId?: string): Promise<any> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const headers = this.authHeaders()
      if (operatorId) headers["x-operator-id"] = operatorId
      const init: RequestInit & { headers: Record<string, string> } = { method, headers, signal: ctrl.signal }
      if (body !== undefined) init.body = JSON.stringify(body)
      const res = await fetch(`${this.gatewayBase}${path}`, init)
      const text = await res.text()
      if (!res.ok) throw new Error(`TB ${res.status} ${method} ${path}: ${text.slice(0, 300)}`)
      const json = text ? JSON.parse(text) : {}
      if (typeof json.code === "number" && json.code >= 400) {
        const scopes = json?.accessDeniedDetail?.requiredScopes as string[] | undefined
        throw new Error(
          `TB ${json.code} ${method} ${path}: ${json.errorMessage ?? json.errorCode ?? "未知错误"}` +
            (scopes?.length ? `（需在开发者中心开通权限：${scopes.join(", ")}）` : ""),
        )
      }
      return json
    } finally {
      clearTimeout(timer)
    }
  }

  private async tbGet(path: string): Promise<any> {
    return this.request("GET", path)
  }

  private async tbPost(path: string, body: unknown): Promise<any> {
    return this.request("POST", path, body)
  }

  private async tbPut(path: string, body: unknown, operatorId: string): Promise<any> {
    return this.request("PUT", path, body, operatorId)
  }

  private async tbBatchMembers(userIds: string[]): Promise<TbMember[]> {
    if (userIds.length === 0) return []
    const r = await this.tbPost("/org/member/batchGet", { orgId: this.orgId, userIds })
    const list = Array.isArray(r.result) ? r.result : []
    return list.map(mapTbMember)
  }

  /** 项目工作流状态列表 */
  private async tbProjectStatusesRaw(projectId: string): Promise<WorkflowStatus[]> {
    const r = await this.tbGet(`/v3/project/${encodeURIComponent(projectId)}/taskflowstatus/search`)
    const list = Array.isArray(r.result) ? r.result : []
    return list
      .map((s: any) => ({
        id: String(s.id ?? s._id ?? s.taskflowstatusId ?? ""),
        name: String(s.name ?? ""),
      }))
      .filter((s: WorkflowStatus) => s.id && s.name)
  }

  /** 通过任务状态名称（tfsId → 项目 taskflowstatus 列表解析） */
  private async withStatusName(t: TbTask, raw: any): Promise<TbTask> {
    const tfsId = raw?.tfsId ? String(raw.tfsId) : ""
    if (!tfsId || !t.projectId) return t
    try {
      const list = await this.tbProjectStatusesRaw(t.projectId)
      const found = list.find((s) => s.id === tfsId)
      if (found) t.status = found.name
    } catch {
      /* 状态名解析失败不影响任务解析 */
    }
    return t
  }

  private mapTask(task: any, ref: string): TbTask {
    const fields: Record<string, string> = {}
    if (typeof task.priority === "number") fields["优先级"] = String(task.priority)
    if (task.dueDate) fields["截止"] = String(task.dueDate).slice(0, 10)
    const cfVals: string[] = []
    for (const cf of task.customfields ?? []) {
      for (const v of cf.value ?? []) if (v?.title) cfVals.push(String(v.title))
    }
    if (cfVals.length) fields["自定义字段"] = cfVals.join(" / ")

    return {
      ref,
      taskId: task.taskId ? String(task.taskId) : null,
      projectId: task.projectId ? String(task.projectId) : null,
      title: String(task.content ?? "").trim() || `任务 ${ref}`,
      description: String(task.note ?? "").trim(),
      status: task.isDone ? "已完成" : task.isArchived ? "回收站" : "进行中",
      parentTaskId: task.parentTaskId ? String(task.parentTaskId) : null,
      dueDate: task.dueDate ? String(task.dueDate) : null,
      fields,
      url: task.taskId ? `https://www.teambition.com/task/${task.taskId}` : undefined,
      source: "teambition",
    }
  }

  /** TQL 按 uniqueId 搜任务 → taskId → 详情 */
  private async tqlByUniqueId(num: string, ref: string, projectId: string | null): Promise<TbTask | null> {
    const tql = projectId ? `projectId = "${projectId}" AND uniqueId = ${num}` : `uniqueId = ${num}`
    const search = await this.tbGet(`/v2/all-task/search?tql=${encodeURIComponent(tql)}&pageSize=1`)
    const taskId = Array.isArray(search.result) ? search.result[0] : undefined
    if (!taskId) return null
    const detail = await this.tbGet(`/v3/task/query?taskId=${encodeURIComponent(taskId)}`)
    const task = detail.result?.[0] ?? null
    if (!task) return null
    return this.withStatusName(this.mapTask(task, ref), task)
  }

  // ── 健康检查 ──────────────────────────────────────

  async healthCheck(): Promise<IntegrationResult> {
    if (!this.isConfigured) {
      return { success: false, message: "Teambition 未配置（缺少 appId/appSecret/orgId）" }
    }
    try {
      await this.tbGet("/v3/project/query?pageSize=1")
      return { success: true, message: "Teambition API 可用" }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `Teambition 不可用: ${message}`, error: message }
    }
  }

  // ── 项目解析 ──────────────────────────────────────

  async resolveProject(prefix: string): Promise<IntegrationResult> {
    try {
      const r = await this.tbGet(`/v3/project/query?uniqueIdPrefix=${encodeURIComponent(prefix)}`)
      const p = r.result?.[0]
      if (!p) return { success: true, message: `项目前缀 "${prefix}" 未匹配到项目`, data: null }
      return {
        success: true,
        message: "项目解析成功",
        data: { id: String(p.id ?? p._id), name: String(p.name ?? "") },
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `项目解析失败: ${message}`, error: message }
    }
  }

  // ── 任务解析 ──────────────────────────────────────

  async resolveTask(ref: string, projectId?: string): Promise<IntegrationResult> {
    try {
      if (!this.isConfigured) throw new Error("Teambition 未配置")
      const task = await this.resolveTaskInternal(ref, projectId)
      return { success: true, message: task ? "任务解析成功" : "未找到任务", data: task ?? null }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `任务解析失败: ${message}`, error: message }
    }
  }

  private async resolveTaskInternal(ref: string, _projectId?: string): Promise<TbTask | null> {
    if (/^[0-9a-f]{24}$/i.test(ref)) {
      const detail = await this.tbGet(`/v3/task/query?taskId=${encodeURIComponent(ref)}`)
      const task = detail.result?.[0] ?? null
      if (!task) return null
      return this.withStatusName(this.mapTask(task, ref), task)
    }

    const n = numericRef(ref)

    if (this.refStrategy === "prefix") {
      const { prefix, num } = splitRef(ref)
      if (!prefix) return this.tqlByUniqueId(num, ref, null)
      const r = await this.tbGet(`/v3/project/query?uniqueIdPrefix=${encodeURIComponent(prefix)}`)
      const pid = r.result?.[0]?.id ?? r.result?.[0]?._id ?? null
      if (!pid) return null
      return this.tqlByUniqueId(num, ref, pid)
    }

    if (this.refStrategy === "tql") {
      return this.tqlByUniqueId(n, ref, null)
    }

    // shortid 策略
    const candidates = ref === n ? [ref] : [ref, n]
    for (const c of candidates) {
      const detail = await this.tbGet(`/v3/task/query?shortIds=${encodeURIComponent(c)}`)
      const task = detail.result?.[0] ?? null
      if (task) return this.withStatusName(this.mapTask(task, ref), task)
    }
    return null
  }

  // ── 任务更新 ──────────────────────────────────────

  async updateTask(update: TaskUpdate): Promise<IntegrationResult> {
    try {
      const { taskId, operatorId } = update
      if (!operatorId) {
        return { success: false, message: "任务更新缺 operatorId（TB 要求 x-operator-id 必填）" }
      }
      const t = encodeURIComponent(taskId)
      const applied: string[] = []
      if (update.statusId !== undefined) {
        await this.tbPut(`/v3/task/${t}/taskflowstatus`, { taskflowstatusId: update.statusId }, operatorId)
        applied.push("statusId")
      }
      if (update.executorId !== undefined) {
        await this.tbPut(`/v3/task/${t}/executor`, { executorId: update.executorId }, operatorId)
        applied.push("executorId")
      }
      if (update.startDate !== undefined) {
        await this.tbPut(`/v3/task/${t}/startDate`, { startDate: update.startDate }, operatorId)
        applied.push("startDate")
      }
      if (update.dueDate !== undefined) {
        await this.tbPut(`/v3/task/${t}/dueDate`, { dueDate: update.dueDate }, operatorId)
        applied.push("dueDate")
      }
      return { success: true, message: `任务已更新（${applied.join(", ")}）`, data: { applied } }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `任务更新失败: ${message}`, error: message }
    }
  }

  // ── 任务参与者 ────────────────────────────────────

  async taskParticipants(taskId: string): Promise<IntegrationResult> {
    try {
      const detail = await this.tbGet(`/v3/task/query?taskId=${encodeURIComponent(taskId)}`)
      const task = detail.result?.[0]
      if (!task) return { success: true, message: "任务不存在", data: { members: [], parentMembers: [] } }

      const involve: string[] = Array.isArray(task.involveMembers) ? task.involveMembers.map(String) : []
      let parentInvolve: string[] = []
      if (task.parentTaskId) {
        const pd = await this.tbGet(`/v3/task/query?taskId=${encodeURIComponent(String(task.parentTaskId))}`)
        const parent = pd.result?.[0]
        if (parent && Array.isArray(parent.involveMembers)) parentInvolve = parent.involveMembers.map(String)
      }

      const all = [...new Set([...involve, ...parentInvolve])]
      const detailed = await this.tbBatchMembers(all)
      const byId = new Map(detailed.map((m) => [m.userId, m]))
      const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((m): m is TbMember => !!m)
      return { success: true, message: "获取参与者成功", data: { members: pick(involve), parentMembers: pick(parentInvolve) } }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `获取参与者失败: ${message}`, error: message }
    }
  }

  // ── 我的待办 ──────────────────────────────────────

  async myTasks(userId: string, projectId?: string): Promise<IntegrationResult> {
    try {
      const parts = [`executorId = "${userId}"`, "isDone = false"]
      if (projectId) parts.push(`projectId = "${projectId}"`)
      const tql = `${parts.join(" AND ")} ORDER BY updated DESC`
      const search = await this.tbGet(`/v2/all-task/search?tql=${encodeURIComponent(tql)}&pageSize=20`)
      const ids: string[] = Array.isArray(search.result) ? search.result.map(String) : []
      if (ids.length === 0) return { success: true, message: "暂无待办", data: [] }

      const detail = await this.tbGet(`/v3/task/query?taskId=${encodeURIComponent(ids.join(","))}`)
      const list = Array.isArray(detail.result) ? detail.result : []
      const tasks = list.map((t: any) => ({
        taskId: String(t.taskId ?? ""),
        uniqueId: t.uniqueId != null ? String(t.uniqueId) : "",
        title: String(t.content ?? "").trim(),
        parentTaskId: t.parentTaskId ? String(t.parentTaskId) : "",
        parentUniqueId: "",
        updated: t.updated ? String(t.updated) : "",
        dueDate: t.dueDate ? String(t.dueDate) : "",
        created: t.created ? String(t.created) : "",
      }))

      const parentIds = [...new Set(tasks.map((t: any) => t.parentTaskId).filter(Boolean))]
      if (parentIds.length) {
        const pd = await this.tbGet(`/v3/task/query?taskId=${encodeURIComponent(parentIds.join(","))}`)
        const byId = new Map(
          (Array.isArray(pd.result) ? pd.result : []).map((p: any) => [
            String(p.taskId ?? ""),
            p.uniqueId != null ? String(p.uniqueId) : "",
          ]),
        )
        for (const t of tasks) {
          if (t.parentTaskId) t.parentUniqueId = byId.get(t.parentTaskId) ?? ""
        }
      }
      return { success: true, message: `获取到 ${tasks.length} 个待办`, data: tasks }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `获取待办失败: ${message}`, error: message }
    }
  }

  // ── 子任务列表 ────────────────────────────────────

  async taskChildren(parentTaskId: string): Promise<IntegrationResult> {
    try {
      const r = await this.tbGet(`/v3/task/query?parentTaskId=${encodeURIComponent(parentTaskId)}`)
      const list = Array.isArray(r.result) ? r.result : []
      const children: ChildTask[] = list.map((t: any) => ({
        taskId: String(t.taskId ?? ""),
        uniqueId: t.uniqueId != null ? String(t.uniqueId) : "",
        title: String(t.content ?? "").trim(),
        executorId: t.executorId ? String(t.executorId) : "",
        executorName: "",
        isDone: !!t.isDone,
      }))
      const execIds = [...new Set(children.map((c) => c.executorId).filter(Boolean))]
      if (execIds.length) {
        try {
          const members = await this.tbBatchMembers(execIds)
          const byId = new Map(members.map((m) => [m.userId, m.name]))
          for (const c of children) c.executorName = byId.get(c.executorId) ?? ""
        } catch {
          /* fail-open */
        }
      }
      return { success: true, message: `获取到 ${children.length} 个子任务`, data: children }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `获取子任务失败: ${message}`, error: message }
    }
  }

  // ── 项目工作流状态 ────────────────────────────────

  async projectStatuses(projectId: string): Promise<IntegrationResult> {
    try {
      const list = await this.tbProjectStatusesRaw(projectId)
      return { success: true, message: `获取到 ${list.length} 个工作流状态`, data: list }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `获取工作流状态失败: ${message}`, error: message }
    }
  }

  // ── 搜索成员 ──────────────────────────────────────

  async searchMembers(query: string): Promise<IntegrationResult> {
    try {
      const r = await this.tbGet(`/org/member/search?query=${encodeURIComponent(query)}&pageSize=20`)
      const list = Array.isArray(r.result) ? r.result : []
      return { success: true, message: `搜索到 ${list.length} 个成员`, data: list.map(mapTbMember) }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `搜索成员失败: ${message}`, error: message }
    }
  }

  // ── 解析成员 ──────────────────────────────────────

  async resolveMember(emailOrName: string): Promise<IntegrationResult> {
    try {
      const list = await this.tbGet(`/org/member/search?query=${encodeURIComponent(emailOrName)}&pageSize=20`)
      const result = Array.isArray(list.result) ? list.result.map(mapTbMember) : []

      let hit: TbMember | null = null
      const lower = emailOrName.toLowerCase()
      hit = result.find((m: TbMember) => m.email?.toLowerCase() === lower) ?? null
      if (!hit) {
        const exact = result.filter((m: TbMember) => m.name === emailOrName)
        if (exact.length === 1) hit = exact[0]
        else if (exact.length > 1) {
          return {
            success: false,
            message: `成员 "${emailOrName}" 匹配到 ${exact.length} 人，无法自动确定`,
            data: { candidates: result },
          }
        }
      }
      return { success: true, message: hit ? "成员解析成功" : "未找到成员", data: hit ?? null }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `成员解析失败: ${message}`, error: message }
    }
  }
}

/** 创建 Teambition 集成实例 */
export function createTeambitionClient(config: TeambitionIntegrationConfig): TeambitionClient {
  return new TeambitionClient(config)
}
