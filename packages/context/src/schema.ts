/**
 * SQLite schema 初始化与 v1→v2 迁移。
 *
 * v1: projects 表存工作流状态（旧「项目」= 现「需求」）
 * v2: projects 为容器；requirements 存工作流状态；执行表按 requirement_id 关联
 */

import type Database from "better-sqlite3"
import type { Project } from "@octopus/core/project.js"
import { ProjectId, RequirementId } from "@octopus/core/branded-ids.js"
import { createEmptyProject } from "@octopus/core/project.js"
import { migrateWorkflowState } from "@octopus/core/workflow.js"

export const STORE_SCHEMA_VERSION = "2"

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

function tableColumns(db: Database.Database, name: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function readMeta(db: Database.Database, key: string): string | undefined {
  if (!tableExists(db, "octopus_meta")) return undefined
  const row = db.prepare("SELECT value FROM octopus_meta WHERE key = ?").get(key) as { value: string } | undefined
  return row?.value
}

function writeMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO octopus_meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value)
}

function createV2Tables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS octopus_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS requirements (
      requirement_id TEXT PRIMARY KEY,
      parent_project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      requirement_name TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS requirements_project_idx
      ON requirements(parent_project_id, updated_at);
  `)
}

function ensureExecutionTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      requirement_id TEXT NOT NULL REFERENCES requirements(requirement_id) ON DELETE CASCADE,
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
    CREATE INDEX IF NOT EXISTS workflow_runs_requirement_idx
      ON workflow_runs(requirement_id, node_id, started_at);

    CREATE TABLE IF NOT EXISTS workflow_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      requirement_id TEXT NOT NULL REFERENCES requirements(requirement_id) ON DELETE CASCADE,
      run_id TEXT,
      node_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workflow_events_requirement_idx
      ON workflow_events(requirement_id, sequence);

    CREATE TABLE IF NOT EXISTS integration_health (
      service TEXT PRIMARY KEY,
      healthy INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      message TEXT NOT NULL,
      checked_at TEXT NOT NULL
    ) STRICT;
  `)
}

function isLegacyProjectsTable(db: Database.Database): boolean {
  if (!tableExists(db, "projects")) return false
  const cols = tableColumns(db, "projects")
  // v1 projects 有 project_name；v2 projects 有 name
  return cols.has("project_name") && !cols.has("name")
}

function migrateV1ToV2(db: Database.Database): void {
  // 关闭外键以便重建引用表
  db.pragma("foreign_keys = OFF")

  const legacyRows = db.prepare(
    "SELECT project_id, project_name, state_json, updated_at FROM projects",
  ).all() as Array<{
    project_id: string
    project_name: string
    state_json: string
    updated_at: string
  }>

  const hasRuns = tableExists(db, "workflow_runs")
  const hasEvents = tableExists(db, "workflow_events")
  const runRows = hasRuns
    ? db.prepare("SELECT * FROM workflow_runs").all() as Array<Record<string, unknown>>
    : []
  const eventRows = hasEvents
    ? db.prepare("SELECT * FROM workflow_events").all() as Array<Record<string, unknown>>
    : []
  const healthRows = tableExists(db, "integration_health")
    ? db.prepare("SELECT * FROM integration_health").all() as Array<Record<string, unknown>>
    : []

  db.exec(`
    DROP TABLE IF EXISTS workflow_events;
    DROP TABLE IF EXISTS workflow_runs;
    DROP TABLE IF EXISTS integration_health;
    ALTER TABLE projects RENAME TO projects_v1_legacy;
  `)

  createV2Tables(db)
  ensureExecutionTables(db)

  const insertProject = db.prepare(
    `INSERT INTO projects(project_id, name, description, state_json, updated_at)
     VALUES (@projectId, @name, @description, @stateJson, @updatedAt)`,
  )
  const insertRequirement = db.prepare(
    `INSERT INTO requirements(requirement_id, parent_project_id, requirement_name, state_json, updated_at)
     VALUES (@requirementId, @parentProjectId, @requirementName, @stateJson, @updatedAt)`,
  )

  for (const row of legacyRows) {
    const projectId = ProjectId(`proj_${row.project_id.replace(/^proj_/, "")}`)
    // 若生成冲突则用时间戳
    let finalProjectId = projectId
    if (row.project_id === String(projectId)) {
      finalProjectId = ProjectId(`proj_wrap_${row.project_id}`)
    }

    const project: Project = {
      ...createEmptyProject(finalProjectId, row.project_name, ""),
      updatedAt: row.updated_at,
      createdAt: row.updated_at,
    }

    const requirementId = RequirementId(row.project_id)
    const migratedState = migrateWorkflowState(JSON.parse(row.state_json), { projectId: finalProjectId })
    migratedState.requirementId = requirementId
    migratedState.requirementName = migratedState.requirementName || row.project_name
    migratedState.projectId = finalProjectId

    insertProject.run({
      projectId: finalProjectId,
      name: project.name,
      description: project.description,
      stateJson: JSON.stringify(project),
      updatedAt: project.updatedAt,
    })
    insertRequirement.run({
      requirementId,
      parentProjectId: finalProjectId,
      requirementName: migratedState.requirementName,
      stateJson: JSON.stringify(migratedState),
      updatedAt: row.updated_at,
    })
  }

  const insertRun = db.prepare(
    `INSERT INTO workflow_runs(
      id, requirement_id, node_id, status, forced, pid, current_action,
      started_at, finished_at, heartbeat_at, exit_code, error, stdout_path, stderr_path
    ) VALUES (
      @id, @requirement_id, @node_id, @status, @forced, @pid, @current_action,
      @started_at, @finished_at, @heartbeat_at, @exit_code, @error, @stdout_path, @stderr_path
    )`,
  )
  for (const run of runRows) {
    insertRun.run({
      id: run["id"],
      requirement_id: run["project_id"] ?? run["requirement_id"],
      node_id: run["node_id"],
      status: run["status"],
      forced: run["forced"],
      pid: run["pid"] ?? null,
      current_action: run["current_action"] ?? null,
      started_at: run["started_at"] ?? null,
      finished_at: run["finished_at"] ?? null,
      heartbeat_at: run["heartbeat_at"] ?? null,
      exit_code: run["exit_code"] ?? null,
      error: run["error"] ?? null,
      stdout_path: run["stdout_path"],
      stderr_path: run["stderr_path"],
    })
  }

  const insertEvent = db.prepare(
    `INSERT INTO workflow_events(sequence, requirement_id, run_id, node_id, type, payload_json, created_at)
     VALUES (@sequence, @requirement_id, @run_id, @node_id, @type, @payload_json, @created_at)`,
  )
  for (const event of eventRows) {
    insertEvent.run({
      sequence: event["sequence"],
      requirement_id: event["project_id"] ?? event["requirement_id"],
      run_id: event["run_id"] ?? null,
      node_id: event["node_id"] ?? null,
      type: event["type"],
      payload_json: event["payload_json"],
      created_at: event["created_at"],
    })
  }

  const insertHealth = db.prepare(
    `INSERT INTO integration_health(service, healthy, latency_ms, message, checked_at)
     VALUES (@service, @healthy, @latency_ms, @message, @checked_at)`,
  )
  for (const health of healthRows) {
    insertHealth.run({
      service: health["service"],
      healthy: health["healthy"],
      latency_ms: health["latency_ms"],
      message: health["message"],
      checked_at: health["checked_at"],
    })
  }

  db.exec("DROP TABLE IF EXISTS projects_v1_legacy")
  writeMeta(db, "schema_version", STORE_SCHEMA_VERSION)
  db.pragma("foreign_keys = ON")
}

/**
 * 确保数据库为 v2 schema。StateStore 与 ExecutionStore 共用。
 */
export function ensureStoreSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL")
  db.pragma("busy_timeout = 5000")

  db.exec(`
    CREATE TABLE IF NOT EXISTS octopus_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `)

  const version = readMeta(db, "schema_version")

  if (isLegacyProjectsTable(db) || version === "1") {
    if (isLegacyProjectsTable(db)) {
      migrateV1ToV2(db)
    } else {
      // schema_version=1 但表已是空/异常：直接建 v2
      createV2Tables(db)
      ensureExecutionTables(db)
      writeMeta(db, "schema_version", STORE_SCHEMA_VERSION)
    }
  } else {
    createV2Tables(db)
    ensureExecutionTables(db)
    if (version !== STORE_SCHEMA_VERSION) {
      writeMeta(db, "schema_version", STORE_SCHEMA_VERSION)
    }
  }

  db.pragma("foreign_keys = ON")
}
