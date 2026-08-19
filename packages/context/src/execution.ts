/**
 * 执行记录与监控事件存储。
 *
 * 运行记录独立于需求聚合状态，worker 可以只更新自己的行，避免并行任务
 * 通过整个 WorkflowState 的读写互相覆盖。
 */

import Database from "better-sqlite3"
import { existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import type { IntegrationHealth, NodeRun, NodeRunStatus, WorkflowEvent } from "@octopus/core/execution.js"
import { ensureStoreSchema } from "./schema.js"

export interface CreateRunInput {
  readonly id?: string
  requirementId: string
  nodeId: string
  forced: boolean
  stdoutPath: string
  stderrPath: string
}

export interface ExecutionStore {
  createRun(input: CreateRunInput): NodeRun
  getRun(runId: string): NodeRun | undefined
  listRuns(requirementId: string, nodeId?: string): NodeRun[]
  updateRun(runId: string, patch: Partial<NodeRun>): NodeRun
  transitionRun(runId: string, from: readonly NodeRunStatus[], patch: Partial<NodeRun>): NodeRun | undefined
  appendEvent(event: Omit<WorkflowEvent, "sequence">): WorkflowEvent
  eventsAfter(requirementId: string, sequence: number): WorkflowEvent[]
  saveIntegrationHealth(health: IntegrationHealth): void
  listIntegrationHealth(): IntegrationHealth[]
  purge(before: string): number
}

interface RunRow {
  id: string
  requirement_id: string
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
  requirement_id: string
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
      ensureStoreSchema(db)
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
        `INSERT INTO workflow_runs(id, requirement_id, node_id, status, forced, stdout_path, stderr_path)
         VALUES (?, ?, ?, 'QUEUED', ?, ?, ?)`,
      ).run(id, input.requirementId, input.nodeId, input.forced ? 1 : 0, input.stdoutPath, input.stderrPath)
    })
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
  }

  getRun(runId: string): NodeRun | undefined {
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as RunRow | undefined
      return row ? toRun(row) : undefined
    })
  }

  listRuns(requirementId: string, nodeId?: string): NodeRun[] {
    return this.withDatabase((db) => {
      const rows = (nodeId
        ? db.prepare("SELECT * FROM workflow_runs WHERE requirement_id = ? AND node_id = ? ORDER BY rowid DESC").all(requirementId, nodeId)
        : db.prepare("SELECT * FROM workflow_runs WHERE requirement_id = ? ORDER BY rowid DESC").all(requirementId)) as RunRow[]
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
        `INSERT INTO workflow_events(requirement_id, run_id, node_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
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

  eventsAfter(requirementId: string, sequence: number): WorkflowEvent[] {
    return this.withDatabase((db) => {
      const rows = db.prepare(
        "SELECT * FROM workflow_events WHERE requirement_id = ? AND sequence > ? ORDER BY sequence ASC",
      ).all(requirementId, sequence) as EventRow[]
      return rows.map((row) => ({
        sequence: row.sequence,
        requirementId: row.requirement_id,
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
      db.prepare("DELETE FROM integration_health WHERE checked_at < ?").run(before)
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
    requirementId: row.requirement_id,
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
