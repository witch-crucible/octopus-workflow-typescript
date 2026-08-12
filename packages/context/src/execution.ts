/**
 * 执行记录与监控事件存储。
 *
 * 运行记录独立于项目聚合状态，worker 可以只更新自己的行，避免并行任务
 * 通过整个 WorkflowState 的读写互相覆盖。
 */

import Database from "better-sqlite3"
import { existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import type { IntegrationHealth, NodeRun, NodeRunStatus, WorkflowEvent } from "@octopus/core/execution.js"

export interface CreateRunInput {
  readonly id?: string
  projectId: string
  nodeId: string
  forced: boolean
  stdoutPath: string
  stderrPath: string
}

export interface ExecutionStore {
  createRun(input: CreateRunInput): NodeRun
  getRun(runId: string): NodeRun | undefined
  listRuns(projectId: string, nodeId?: string): NodeRun[]
  updateRun(runId: string, patch: Partial<NodeRun>): NodeRun
  transitionRun(runId: string, from: readonly NodeRunStatus[], patch: Partial<NodeRun>): NodeRun | undefined
  appendEvent(event: Omit<WorkflowEvent, "sequence">): WorkflowEvent
  eventsAfter(projectId: string, sequence: number): WorkflowEvent[]
  saveIntegrationHealth(health: IntegrationHealth): void
  listIntegrationHealth(): IntegrationHealth[]
  purge(before: string): number
}

interface RunRow {
  id: string
  project_id: string
  node_id: string
  status: NodeRunStatus
  forced: number
  pid: number | null
  current_action: number | null
  started_at: string | null
  finished_at: string | null
  heartbeat_at: string | null
  exit_code: number | null
  error: string | null
  stdout_path: string
  stderr_path: string
}

interface EventRow {
  sequence: number
  project_id: string
  run_id: string | null
  node_id: string | null
  type: WorkflowEvent["type"]
  payload_json: string
  created_at: string
}

/** 创建与 StateStore 共用的执行存储。 */
export function createExecutionStore(storeDir: string): ExecutionStore {
  return new SqliteExecutionStore(storeDir)
}

class SqliteExecutionStore implements ExecutionStore {
  private readonly databasePath: string

  constructor(storeDir: string) {
    const absoluteStoreDir = resolve(storeDir)
    if (!existsSync(absoluteStoreDir)) mkdirSync(absoluteStoreDir, { recursive: true })
    this.databasePath = join(absoluteStoreDir, "state.sqlite")
    this.withDatabase(() => undefined)
  }

  private withDatabase<T>(callback: (db: Database.Database) => T): T {
    const db = new Database(this.databasePath)
    try {
      db.pragma("journal_mode = WAL")
      db.pragma("busy_timeout = 5000")
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          status TEXT NOT NULL,
          forced INTEGER NOT NULL,
          pid INTEGER,
          current_action INTEGER,
          started_at TEXT,
          finished_at TEXT,
          heartbeat_at TEXT,
          exit_code INTEGER,
          error TEXT,
          stdout_path TEXT NOT NULL,
          stderr_path TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS workflow_runs_project_idx ON workflow_runs(project_id, node_id, started_at);
        CREATE TABLE IF NOT EXISTS workflow_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          run_id TEXT,
          node_id TEXT,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS workflow_events_project_idx ON workflow_events(project_id, sequence);
        CREATE TABLE IF NOT EXISTS integration_health (
          service TEXT PRIMARY KEY,
          healthy INTEGER NOT NULL,
          latency_ms INTEGER NOT NULL,
          message TEXT NOT NULL,
          checked_at TEXT NOT NULL
        ) STRICT;
      `)
      return callback(db)
    } finally {
      db.close()
    }
  }

  createRun(input: CreateRunInput): NodeRun {
    const now = new Date().toISOString()
    const id = input.id ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.withDatabase((db) => {
      db.prepare(
        `INSERT INTO workflow_runs(id, project_id, node_id, status, forced, stdout_path, stderr_path)
         VALUES (?, ?, ?, 'QUEUED', ?, ?, ?)`,
      ).run(id, input.projectId, input.nodeId, input.forced ? 1 : 0, input.stdoutPath, input.stderrPath)
    })
    return {
      id,
      projectId: input.projectId,
      nodeId: input.nodeId,
      status: "QUEUED",
      forced: input.forced,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      heartbeatAt: now,
    }
  }

  getRun(runId: string): NodeRun | undefined {
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as RunRow | undefined
      return row ? toRun(row) : undefined
    })
  }

  listRuns(projectId: string, nodeId?: string): NodeRun[] {
    return this.withDatabase((db) => {
      const rows = (nodeId
        ? db.prepare("SELECT * FROM workflow_runs WHERE project_id = ? AND node_id = ? ORDER BY rowid DESC").all(projectId, nodeId)
        : db.prepare("SELECT * FROM workflow_runs WHERE project_id = ? ORDER BY rowid DESC").all(projectId)) as RunRow[]
      return rows.map(toRun)
    })
  }

  updateRun(runId: string, patch: Partial<NodeRun>): NodeRun {
    return this.withDatabase((db) => {
      const { assignments, values } = runPatch(runId, patch)

      const row = assignments.length > 0
        ? db
            .prepare(`UPDATE workflow_runs SET ${assignments.join(", ")} WHERE id=@runId RETURNING *`)
            .get(values) as RunRow | undefined
        : db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as RunRow | undefined
      if (!row) throw new Error(`运行不存在: ${runId}`)
      return toRun(row)
    })
  }

  transitionRun(runId: string, from: readonly NodeRunStatus[], patch: Partial<NodeRun>): NodeRun | undefined {
    if (from.length === 0) return undefined
    return this.withDatabase((db) => {
      const { assignments, values } = runPatch(runId, patch)
      if (assignments.length === 0) throw new Error("运行状态转换 patch 不能为空")
      const placeholders = from.map((_, index) => `@from${index}`)
      for (const [index, status] of from.entries()) values[`from${index}`] = status
      const row = db
        .prepare(
          `UPDATE workflow_runs SET ${assignments.join(", ")}
           WHERE id=@runId AND status IN (${placeholders.join(", ")}) RETURNING *`,
        )
        .get(values) as RunRow | undefined
      return row ? toRun(row) : undefined
    })
  }

  appendEvent(event: Omit<WorkflowEvent, "sequence">): WorkflowEvent {
    return this.withDatabase((db) => {
      const result = db.prepare(
        `INSERT INTO workflow_events(project_id, run_id, node_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        event.projectId,
        event.runId ?? null,
        event.nodeId ?? null,
        event.type,
        JSON.stringify(event.payload),
        event.createdAt,
      )
      return { ...event, sequence: Number(result.lastInsertRowid) }
    })
  }

  eventsAfter(projectId: string, sequence: number): WorkflowEvent[] {
    return this.withDatabase((db) => {
      const rows = db.prepare(
        "SELECT * FROM workflow_events WHERE project_id = ? AND sequence > ? ORDER BY sequence ASC",
      ).all(projectId, sequence) as EventRow[]
      return rows.map((row) => ({
        sequence: row.sequence,
        projectId: row.project_id,
        ...(row.run_id !== null ? { runId: row.run_id } : {}),
        ...(row.node_id !== null ? { nodeId: row.node_id } : {}),
        type: row.type,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        createdAt: row.created_at,
      }))
    })
  }

  saveIntegrationHealth(health: IntegrationHealth): void {
    this.withDatabase((db) => {
      db.prepare(
        `INSERT INTO integration_health(service, healthy, latency_ms, message, checked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(service) DO UPDATE SET healthy=excluded.healthy,
           latency_ms=excluded.latency_ms, message=excluded.message, checked_at=excluded.checked_at`,
      ).run(health.service, health.healthy ? 1 : 0, health.latencyMs, health.message, health.checkedAt)
    })
  }

  listIntegrationHealth(): IntegrationHealth[] {
    return this.withDatabase((db) => {
      const rows = db.prepare("SELECT * FROM integration_health ORDER BY service").all() as Array<{
        service: string
        healthy: number
        latency_ms: number
        message: string
        checked_at: string
      }>
      return rows.map((row) => ({
        service: row.service,
        healthy: row.healthy === 1,
        latencyMs: row.latency_ms,
        message: row.message,
        checkedAt: row.checked_at,
      }))
    })
  }

  purge(before: string): number {
    return this.withDatabase((db) => {
      const result = db.prepare("DELETE FROM workflow_runs WHERE finished_at IS NOT NULL AND finished_at < ?").run(before)
      db.prepare("DELETE FROM workflow_events WHERE created_at < ?").run(before)
      return result.changes
    })
  }
}

function runPatch(runId: string, patch: Partial<NodeRun>): {
  assignments: string[]
  values: Record<string, unknown>
} {
  const assignments: string[] = []
  const values: Record<string, unknown> = { runId }
  const set = (property: keyof NodeRun, column: string, value: unknown): void => {
    if (!Object.hasOwn(patch, property)) return
    assignments.push(`${column}=@${property}`)
    values[property] = value
  }

  set("status", "status", patch.status)
  set("forced", "forced", patch.forced ? 1 : 0)
  set("pid", "pid", patch.pid ?? null)
  set("currentAction", "current_action", patch.currentAction ?? null)
  set("startedAt", "started_at", patch.startedAt ?? null)
  set("finishedAt", "finished_at", patch.finishedAt ?? null)
  set("heartbeatAt", "heartbeat_at", patch.heartbeatAt ?? null)
  set("exitCode", "exit_code", patch.exitCode ?? null)
  set("error", "error", patch.error ?? null)
  set("stdoutPath", "stdout_path", patch.stdoutPath)
  set("stderrPath", "stderr_path", patch.stderrPath)
  return { assignments, values }
}

function toRun(row: RunRow): NodeRun {
  return {
    id: row.id,
    projectId: row.project_id,
    nodeId: row.node_id,
    status: row.status,
    forced: row.forced === 1,
    ...(row.pid !== null ? { pid: row.pid } : {}),
    ...(row.current_action !== null ? { currentAction: row.current_action } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    stdoutPath: row.stdout_path,
    stderrPath: row.stderr_path,
  }
}
