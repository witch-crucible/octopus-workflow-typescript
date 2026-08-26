import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import Database from "better-sqlite3"
import postgres from "postgres"
import type { WorkflowState } from "@octopus/core/workflow.js"
import type { Project } from "@octopus/core/project.js"
import { ProjectId, RequirementId } from "@octopus/core/branded-ids.js"
import { createEmptyProject } from "@octopus/core/project.js"
import { createEmptyState, migrateWorkflowState } from "@octopus/core/workflow.js"
import type {
  IntegrationHealth,
  NodeRun,
  NodeRunStatus,
  WorkflowEvent,
} from "@octopus/core/execution.js"
import { StoreError } from "@octopus/core/errors.js"
import type { CreateRunInput, ExecutionStore } from "./execution.js"
import type { StateStore, StoreConfig } from "./index.js"
import { readSqliteSources } from "./sqlite-import.js"

const TABLES = [
  "capy_projects",
  "capy_requirements",
  "capy_workflow_runs",
  "capy_workflow_events",
  "capy_integration_health",
] as const
type Table = (typeof TABLES)[number]
type Row = {
  [key: string]: unknown
  state_json?: unknown
  parent_project_id?: unknown
  project_id?: unknown
  requirement_id?: unknown
  sequence?: unknown
  run_id?: unknown
  node_id?: unknown
  type?: unknown
  payload_json?: unknown
  created_at?: unknown
  service?: unknown
  healthy?: unknown
  latency_ms?: unknown
  message?: unknown
  checked_at?: unknown
  forced?: unknown
  id?: unknown
  status?: unknown
  pid?: unknown
  current_action?: unknown
  started_at?: unknown
  finished_at?: unknown
  heartbeat_at?: unknown
  exit_code?: unknown
  error?: unknown
  stdout_path?: unknown
  stderr_path?: unknown
}

export type SyncState = "never-synced" | "synced" | "pending" | "syncing" | "error"
export interface SyncStatus {
  state: SyncState
  localRevision: number
  lastSyncedLocalRevision: number
  remoteRevision?: number
  lastSyncedAt?: string
  lastError?: string
}

export interface SqlitePersistenceStore extends StateStore, ExecutionStore {
  close(): Promise<void>
  getSyncStatus(): Promise<SyncStatus>
  syncWithSupabase(): Promise<SyncStatus>
}

export async function createSqlitePersistenceStore(
  options: Partial<StoreConfig> = {},
): Promise<SqlitePersistenceStore> {
  const storeDir = resolve(options.storeDir ?? ".octo")
  await mkdir(storeDir, { recursive: true })
  const path = join(storeDir, "octopus.sqlite")
  const legacyPath = join(storeDir, "state.sqlite")
  if (!existsSync(path) && existsSync(legacyPath)) {
    const source = readSqliteSources([legacyPath])
    const store = new SqliteStore(path, storeDir)
    store.importRows(source.rows)
    return store
  }
  return new SqliteStore(path, storeDir)
}

class SqliteStore implements SqlitePersistenceStore {
  private readonly db: Database.Database
  private closed = false

  constructor(
    private readonly path: string,
    private readonly storeDir: string,
  ) {
    this.db = new Database(path)
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("foreign_keys = ON")
    this.db.pragma("busy_timeout = 5000")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capy_octopus_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capy_projects (project_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capy_requirements (requirement_id TEXT PRIMARY KEY NOT NULL, parent_project_id TEXT NOT NULL REFERENCES capy_projects(project_id) ON DELETE CASCADE, requirement_name TEXT NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capy_workflow_runs (id TEXT PRIMARY KEY NOT NULL, requirement_id TEXT NOT NULL REFERENCES capy_requirements(requirement_id) ON DELETE CASCADE, node_id TEXT NOT NULL, status TEXT NOT NULL, forced INTEGER NOT NULL, pid INTEGER, current_action INTEGER, started_at TEXT, finished_at TEXT, heartbeat_at TEXT, exit_code INTEGER, error TEXT, stdout_path TEXT NOT NULL, stderr_path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capy_workflow_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, requirement_id TEXT NOT NULL REFERENCES capy_requirements(requirement_id) ON DELETE CASCADE, run_id TEXT, node_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capy_integration_health (service TEXT PRIMARY KEY NOT NULL, healthy INTEGER NOT NULL, latency_ms INTEGER NOT NULL, message TEXT NOT NULL, checked_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS capy_projects_updated_at_idx ON capy_projects(updated_at);
      CREATE INDEX IF NOT EXISTS capy_requirements_project_idx ON capy_requirements(parent_project_id, updated_at);
      CREATE INDEX IF NOT EXISTS capy_workflow_events_requirement_idx ON capy_workflow_events(requirement_id, sequence);
      CREATE INDEX IF NOT EXISTS capy_workflow_runs_requirement_idx ON capy_workflow_runs(requirement_id, node_id, started_at);
    `)
    this.meta("schema_version", "2")
    for (const [key, value] of [
      ["local_revision", "0"],
      ["last_synced_local_revision", "0"],
    ])
      this.db
        .prepare("INSERT OR IGNORE INTO capy_octopus_meta (key,value) VALUES (?,?)")
        .run(key, value)
  }

  private meta(key: string, value?: string): string | undefined {
    if (value !== undefined) {
      this.db
        .prepare(
          "INSERT INTO capy_octopus_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, value)
      return value
    }
    return (
      this.db.prepare("SELECT value FROM capy_octopus_meta WHERE key=?").get(key) as
        | { value: string }
        | undefined
    )?.value
  }
  private revision(): number {
    return Number(this.meta("local_revision") ?? 0)
  }
  private touch(): void {
    this.meta("local_revision", String(this.revision() + 1))
  }
  private tx<T>(fn: () => T): T {
    return this.db.transaction(() => {
      const result = fn()
      this.touch()
      return result
    })()
  }
  private rows(table: Table): Row[] {
    return this.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() as Row[]
  }
  private digest(): string {
    const hash = createHash("sha256")
    for (const table of TABLES) hash.update(JSON.stringify(this.rows(table)))
    return hash.digest("hex")
  }

  importRows(rows: Record<Table, Row[]>): void {
    this.tx(() => {
      for (const table of [...TABLES].reverse()) this.db.prepare(`DELETE FROM ${table}`).run()
      for (const table of TABLES)
        for (const row of rows[table]) {
          const keys = Object.keys(row)
          this.db
            .prepare(
              `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
            )
            .run(...keys.map((key) => row[key]))
        }
    })
  }
  getStorePath(): string {
    return this.storeDir
  }
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.db.close()
    }
  }
  async load(id: string): Promise<WorkflowState> {
    const row = this.db
      .prepare("SELECT state_json,parent_project_id FROM capy_requirements WHERE requirement_id=?")
      .get(id) as Row | undefined
    if (!row) throw new StoreError("STORE_LOAD_FAILED", `无法加载需求 ${id}`)
    return migrateWorkflowState(JSON.parse(String(row.state_json)), {
      projectId: ProjectId(String(row.parent_project_id)),
    })
  }
  async save(state: WorkflowState): Promise<void> {
    this.tx(() => this.saveRequirement(state))
  }
  async update(
    id: string,
    updater: (state: WorkflowState) => WorkflowState,
  ): Promise<WorkflowState> {
    return this.tx(() => {
      const next = updater(this.loadSync(id))
      this.saveRequirement(next)
      return next
    })
  }
  private loadSync(id: string): WorkflowState {
    const row = this.db
      .prepare("SELECT state_json,parent_project_id FROM capy_requirements WHERE requirement_id=?")
      .get(id) as Row | undefined
    if (!row) throw new StoreError("STORE_LOAD_FAILED", `无法加载需求 ${id}`)
    return migrateWorkflowState(JSON.parse(String(row.state_json)), {
      projectId: ProjectId(String(row.parent_project_id)),
    })
  }
  private saveRequirement(state: WorkflowState): void {
    const now = new Date().toISOString()
    state.updatedAt = now
    this.db
      .prepare(
        "INSERT INTO capy_requirements(requirement_id,parent_project_id,requirement_name,state_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(requirement_id) DO UPDATE SET parent_project_id=excluded.parent_project_id,requirement_name=excluded.requirement_name,state_json=excluded.state_json,updated_at=excluded.updated_at",
      )
      .run(state.requirementId, state.projectId, state.requirementName, JSON.stringify(state), now)
  }
  async listProjects(): Promise<string[]> {
    return (
      this.db
        .prepare("SELECT project_id FROM capy_projects ORDER BY updated_at DESC")
        .all() as Row[]
    ).map((r) => String(r.project_id))
  }
  async loadProject(id: string): Promise<Project> {
    const row = this.db
      .prepare("SELECT state_json FROM capy_projects WHERE project_id=?")
      .get(id) as Row | undefined
    if (!row) throw new StoreError("STORE_LOAD_FAILED", `无法加载项目 ${id}`)
    return JSON.parse(String(row.state_json)) as Project
  }
  async saveProject(project: Project): Promise<void> {
    this.tx(() => this.saveProjectSync(project))
  }
  private saveProjectSync(project: Project): void {
    const now = new Date().toISOString()
    project.updatedAt = now
    this.db
      .prepare(
        "INSERT INTO capy_projects(project_id,name,description,state_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET name=excluded.name,description=excluded.description,state_json=excluded.state_json,updated_at=excluded.updated_at",
      )
      .run(project.projectId, project.name, project.description, JSON.stringify(project), now)
  }
  async updateProject(id: string, updater: (p: Project) => Project): Promise<Project> {
    return this.tx(() => {
      const next = updater(this.loadProjectSync(id))
      this.saveProjectSync(next)
      return next
    })
  }
  private loadProjectSync(id: string): Project {
    const row = this.db
      .prepare("SELECT state_json FROM capy_projects WHERE project_id=?")
      .get(id) as Row | undefined
    if (!row) throw new StoreError("STORE_LOAD_FAILED", `无法加载项目 ${id}`)
    return JSON.parse(String(row.state_json)) as Project
  }
  async createProject(name: string, description = ""): Promise<Project> {
    return this.tx(() => {
      const p = createEmptyProject(
        ProjectId(`proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        name,
        description,
      )
      this.saveProjectSync(p)
      return p
    })
  }
  async deleteProject(id: string): Promise<void> {
    this.tx(() => {
      this.db.prepare("DELETE FROM capy_projects WHERE project_id=?").run(id)
    })
  }
  async listRequirements(projectId?: string): Promise<string[]> {
    const rows = this.db
      .prepare(
        projectId === undefined
          ? "SELECT requirement_id FROM capy_requirements ORDER BY updated_at DESC"
          : "SELECT requirement_id FROM capy_requirements WHERE parent_project_id=? ORDER BY updated_at DESC",
      )
      .all(...(projectId === undefined ? [] : [projectId])) as Row[]
    return rows.map((r) => String(r.requirement_id))
  }
  async createRequirement(
    projectId: string,
    name: string,
    description = "",
    projectRoot?: string,
  ): Promise<WorkflowState> {
    return this.tx(() => {
      this.loadProjectSync(projectId)
      const state = createEmptyState(
        ProjectId(projectId),
        RequirementId(`req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        name,
        description,
        projectRoot,
      )
      this.saveRequirement(state)
      return state
    })
  }
  async deleteRequirement(id: string): Promise<void> {
    this.tx(() => {
      this.db.prepare("DELETE FROM capy_requirements WHERE requirement_id=?").run(id)
    })
  }

  async createRun(input: CreateRunInput): Promise<NodeRun> {
    return this.tx(() => {
      const now = new Date().toISOString()
      const id = input.id ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      this.db
        .prepare(
          "INSERT INTO capy_workflow_runs(id,requirement_id,node_id,status,forced,stdout_path,stderr_path,heartbeat_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          input.requirementId,
          input.nodeId,
          "QUEUED",
          input.forced ? 1 : 0,
          input.stdoutPath,
          input.stderrPath,
          now,
        )
      return {
        id,
        requirementId: input.requirementId,
        nodeId: input.nodeId,
        status: "QUEUED",
        forced: input.forced,
        stdoutPath: input.stdoutPath,
        stderrPath: input.stderrPath,
        heartbeatAt: now,
      }
    })
  }
  async getRun(id: string): Promise<NodeRun | undefined> {
    const row = this.db.prepare("SELECT * FROM capy_workflow_runs WHERE id=?").get(id) as
      | Row
      | undefined
    return row ? toRun(row) : undefined
  }
  async listRuns(requirementId: string, nodeId?: string): Promise<NodeRun[]> {
    const rows = this.db
      .prepare(
        nodeId === undefined
          ? "SELECT * FROM capy_workflow_runs WHERE requirement_id=? ORDER BY started_at IS NOT NULL, started_at DESC, id DESC"
          : "SELECT * FROM capy_workflow_runs WHERE requirement_id=? AND node_id=? ORDER BY started_at IS NOT NULL, started_at DESC, id DESC",
      )
      .all(...(nodeId === undefined ? [requirementId] : [requirementId, nodeId])) as Row[]
    return rows.map(toRun)
  }
  async updateRun(id: string, patch: Partial<NodeRun>): Promise<NodeRun> {
    return this.tx(() => {
      const current = this.db.prepare("SELECT * FROM capy_workflow_runs WHERE id=?").get(id) as
        | Row
        | undefined
      if (!current) throw new Error(`运行不存在: ${id}`)
      const values = runPatch(patch)
      if (Object.keys(values).length) {
        const keys = Object.keys(values)
        this.db
          .prepare(
            `UPDATE capy_workflow_runs SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`,
          )
          .run(...keys.map((k) => values[k]), id)
      }
      return toRun(this.db.prepare("SELECT * FROM capy_workflow_runs WHERE id=?").get(id) as Row)
    })
  }
  async transitionRun(
    id: string,
    from: readonly NodeRunStatus[],
    patch: Partial<NodeRun>,
  ): Promise<NodeRun | undefined> {
    if (!from.length) return undefined
    return this.tx(() => {
      const values = runPatch(patch)
      const keys = Object.keys(values)
      if (!keys.length) throw new Error("运行状态转换 patch 不能为空")
      const result = this.db
        .prepare(
          `UPDATE capy_workflow_runs SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=? AND status IN (${from.map(() => "?").join(",")})`,
        )
        .run(...keys.map((k) => values[k]), id, ...from)
      return result.changes
        ? toRun(this.db.prepare("SELECT * FROM capy_workflow_runs WHERE id=?").get(id) as Row)
        : undefined
    })
  }
  async appendEvent(event: Omit<WorkflowEvent, "sequence">): Promise<WorkflowEvent> {
    return this.tx(() => {
      const result = this.db
        .prepare(
          "INSERT INTO capy_workflow_events(requirement_id,run_id,node_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          event.requirementId,
          event.runId ?? null,
          event.nodeId ?? null,
          event.type,
          JSON.stringify(event.payload),
          event.createdAt,
        )
      return { ...event, sequence: Number(result.lastInsertRowid) }
    })
  }
  async eventsAfter(requirementId: string, sequence: number): Promise<WorkflowEvent[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM capy_workflow_events WHERE requirement_id=? AND sequence>? ORDER BY sequence",
      )
      .all(requirementId, sequence) as Row[]
    return rows.map((r) => ({
      sequence: Number(r.sequence),
      requirementId: String(r.requirement_id),
      ...(r.run_id === null ? {} : { runId: String(r.run_id) }),
      ...(r.node_id === null ? {} : { nodeId: String(r.node_id) }),
      type: String(r.type) as WorkflowEvent["type"],
      payload: JSON.parse(String(r.payload_json)) as Record<string, unknown>,
      createdAt: String(r.created_at),
    }))
  }
  async saveIntegrationHealth(h: IntegrationHealth): Promise<void> {
    this.tx(() => {
      this.db
        .prepare(
          "INSERT INTO capy_integration_health(service,healthy,latency_ms,message,checked_at) VALUES(?,?,?,?,?) ON CONFLICT(service) DO UPDATE SET healthy=excluded.healthy,latency_ms=excluded.latency_ms,message=excluded.message,checked_at=excluded.checked_at",
        )
        .run(h.service, h.healthy ? 1 : 0, h.latencyMs, h.message, h.checkedAt)
    })
  }
  async listIntegrationHealth(): Promise<IntegrationHealth[]> {
    return this.rows("capy_integration_health").map((r) => ({
      service: String(r.service),
      healthy: Number(r.healthy) === 1,
      latencyMs: Number(r.latency_ms),
      message: String(r.message),
      checkedAt: String(r.checked_at),
    }))
  }
  async purge(before: string): Promise<number> {
    return this.tx(() => {
      const result = this.db
        .prepare("DELETE FROM capy_workflow_runs WHERE finished_at IS NOT NULL AND finished_at<?")
        .run(before)
      this.db.prepare("DELETE FROM capy_workflow_events WHERE created_at<?").run(before)
      this.db.prepare("DELETE FROM capy_integration_health WHERE checked_at<?").run(before)
      return result.changes
    })
  }
  async getSyncStatus(): Promise<SyncStatus> {
    const localRevision = this.revision()
    const synced = Number(this.meta("last_synced_local_revision") ?? 0)
    const error = this.meta("last_sync_error")
    const remote = this.meta("last_remote_revision")
    const syncedAt = this.meta("last_synced_at")
    const result: SyncStatus = {
      state: error
        ? "error"
        : localRevision > synced
          ? "pending"
          : syncedAt
            ? "synced"
            : "never-synced",
      localRevision,
      lastSyncedLocalRevision: synced,
    }
    if (remote) result.remoteRevision = Number(remote)
    if (syncedAt) result.lastSyncedAt = syncedAt
    if (error) result.lastError = error
    return result
  }
  async syncWithSupabase(): Promise<SyncStatus> {
    const url = process.env["DATABASE_URL"]
    if (!url) throw new Error("未配置 DATABASE_URL；本地数据库仍可离线运行")
    const targetRevision = this.revision()
    const snapshot = Object.fromEntries(TABLES.map((table) => [table, this.rows(table)])) as Record<
      Table,
      Row[]
    >
    const digest = this.digest()
    const client = postgres(url, { prepare: false })
    try {
      const remoteRevision = await client.begin(async (transaction) => {
        const metaRows = await transaction.unsafe<{ value: string }[]>(
          "SELECT value FROM public.capy_octopus_meta WHERE key = 'snapshot_revision'",
        )
        const revision = Number(metaRows[0]?.value ?? 0) + 1
        for (const table of [...TABLES].reverse())
          await transaction.unsafe(`DELETE FROM public.${table}`)
        for (const table of TABLES) {
          for (const row of snapshot[table]) {
            const columns = Object.keys(row)
            const values = columns.map((column) => row[column])
            await transaction.unsafe(
              `INSERT INTO public.${table} (${columns.join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`,
              values as never[],
            )
          }
        }
        const metadata: Array<[string, string]> = [
          ["snapshot_revision", String(revision)],
          ["snapshot_digest", digest],
          ["snapshot_updated_at", new Date().toISOString()],
          ["snapshot_source", "octopus-single-machine"],
        ]
        for (const [key, value] of metadata) {
          await transaction.unsafe(
            "INSERT INTO public.capy_octopus_meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
            [key, value],
          )
        }
        return revision
      })
      const syncedAt = new Date().toISOString()
      this.meta("last_remote_revision", String(remoteRevision))
      this.meta("last_snapshot_digest", digest)
      this.meta("last_synced_at", syncedAt)
      this.meta("last_sync_error", "")
      if (this.revision() === targetRevision)
        this.meta("last_synced_local_revision", String(targetRevision))
      return this.getSyncStatus()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "远端快照同步失败"
      this.meta("last_sync_error", message.slice(0, 500))
      throw new Error("Supabase 快照同步失败；本地数据未改变")
    } finally {
      await client.end({ timeout: 5 }).catch(() => undefined)
    }
  }
}

function runPatch(patch: Partial<NodeRun>): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const [from, to] of [
    ["status", "status"],
    ["stdoutPath", "stdout_path"],
    ["stderrPath", "stderr_path"],
    ["pid", "pid"],
    ["currentAction", "current_action"],
    ["startedAt", "started_at"],
    ["finishedAt", "finished_at"],
    ["heartbeatAt", "heartbeat_at"],
    ["exitCode", "exit_code"],
    ["error", "error"],
  ] as const)
    if (Object.hasOwn(patch, from)) v[to] = patch[from] ?? null
  if (patch["forced"] !== undefined) v["forced"] = patch["forced"] ? 1 : 0
  return v
}
function toRun(r: Row): NodeRun {
  return {
    id: String(r.id),
    requirementId: String(r.requirement_id),
    nodeId: String(r.node_id),
    status: String(r.status) as NodeRunStatus,
    forced: Number(r.forced) === 1,
    ...(r.pid === null ? {} : { pid: Number(r.pid) }),
    ...(r.current_action === null ? {} : { currentAction: Number(r.current_action) }),
    ...(r.started_at === null ? {} : { startedAt: String(r.started_at) }),
    ...(r.finished_at === null ? {} : { finishedAt: String(r.finished_at) }),
    ...(r.heartbeat_at === null ? {} : { heartbeatAt: String(r.heartbeat_at) }),
    ...(r.exit_code === null ? {} : { exitCode: Number(r.exit_code) }),
    ...(r.error === null ? {} : { error: String(r.error) }),
    stdoutPath: String(r.stdout_path),
    stderrPath: String(r.stderr_path),
  }
}
