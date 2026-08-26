import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { readSqliteSources } from "./sqlite-import.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function sqlitePath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "octopus-import-"))
  roots.push(root)
  return join(root, name)
}

function createV1(path: string): void {
  const db = new Database(path)
  try {
    db.exec(`
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    const state = {
      schemaVersion: 4,
      projectId: "legacy",
      projectName: "旧项目",
      description: "desc",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      currentPhase: "Intention",
      phaseStatus: {},
      steps: [],
      checklists: {},
      heinrich: { majorDefects: 0, minorDefects: 0, trivialDefects: 0, observations: [], triggerCounts: {} },
      artifacts: [],
      metadata: {},
      aiGatingEnabled: false,
      aiGateResults: [],
    }
    db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)").run(
      "legacy",
      "旧项目",
      JSON.stringify(state),
      "2025-01-01T00:00:00.000Z",
    )
  } finally {
    db.close()
  }
}

function createV2(path: string, projectName = "P"): void {
  const db = new Database(path)
  try {
    db.exec(`
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE requirements (
        requirement_id TEXT PRIMARY KEY,
        parent_project_id TEXT NOT NULL,
        requirement_name TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)").run(
      "proj_v2",
      projectName,
      "",
      JSON.stringify({ projectId: "proj_v2", name: projectName }),
      "2026-01-01T00:00:00.000Z",
    )
  } finally {
    db.close()
  }
}

describe("SQLite 一次性导入标准化", () => {
  it("v1 确定性转换为 proj_wrap_ 容器和原 ID 需求", () => {
    const path = sqlitePath("v1.sqlite")
    createV1(path)
    const dataset = readSqliteSources([path])
    expect(dataset.sources[0]).toMatchObject({ version: "1" })
    expect(dataset.rows.capy_projects[0]?.["project_id"]).toBe("proj_wrap_legacy")
    expect(dataset.rows.capy_requirements[0]).toMatchObject({
      requirement_id: "legacy",
      parent_project_id: "proj_wrap_legacy",
    })
  })

  it("相同来源重复合并幂等", () => {
    const path = sqlitePath("v2.sqlite")
    createV2(path)
    const dataset = readSqliteSources([path, path])
    expect(dataset.rows.capy_projects).toHaveLength(1)
    expect(dataset.sources).toHaveLength(2)
  })

  it("相同主键内容不同立即报冲突", () => {
    const first = sqlitePath("first.sqlite")
    const second = sqlitePath("second.sqlite")
    createV2(first, "P1")
    createV2(second, "P2")
    expect(() => readSqliteSources([first, second])).toThrow("来源冲突")
  })
})
