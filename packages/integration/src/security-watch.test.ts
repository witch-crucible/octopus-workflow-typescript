import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import Database from "better-sqlite3"
import { SecurityWatchClient, createSecurityWatchClient } from "./security-watch.js"

function createTestDb(dir: string): void {
  const dbDir = join(dir, "db")
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, "watcher.sqlite")
  const db = new Database(dbPath)

  db.exec(`
    CREATE TABLE scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE bulletins (
      external_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      published_at TEXT,
      url TEXT,
      raw_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE risk_items (
      risk_id TEXT PRIMARY KEY,
      bulletin_external_id TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      report_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (bulletin_external_id) REFERENCES bulletins(external_id)
    );
    CREATE TABLE findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_run_id INTEGER,
      project_id TEXT NOT NULL,
      risk_id TEXT NOT NULL,
      remediation_status TEXT NOT NULL,
      fix_method TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      analysis_snapshot_json TEXT,
      project_narrative TEXT,
      report_path TEXT,
      evidence_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (scan_run_id) REFERENCES scan_runs(id),
      FOREIGN KEY (risk_id) REFERENCES risk_items(risk_id)
    );
  `)

  db.prepare(
    `INSERT INTO bulletins (external_id, title, published_at, url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("APSB24-01", "Adobe January 2024 Security Update", "2024-01-15", "https://example.com/apsb24-01", "2024-01-15T00:00:00Z", "2024-01-15T00:00:00Z")

  db.prepare(
    `INSERT INTO bulletins (external_id, title, published_at, url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("APSB24-02", "Adobe February 2024 Security Update", "2024-02-15", "https://example.com/apsb24-02", "2024-02-15T00:00:00Z", "2024-02-15T00:00:00Z")

  db.prepare(
    `INSERT INTO risk_items (risk_id, bulletin_external_id, analysis_json, report_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "APSB24-01:test-risk",
    "APSB24-01",
    JSON.stringify({ title: "Test Risk", severity: "critical" }),
    "reports/risk_items/APSB24-01_test-risk.md",
    "2024-01-15T00:00:00Z",
    "2024-01-15T00:00:00Z",
  )

  db.prepare(
    `INSERT INTO findings (project_id, risk_id, remediation_status, fix_method, evidence_json, evidence_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("demo-shop", "APSB24-01:test-risk", "vulnerable", "upgrade", JSON.stringify({ version: "2.4.6" }), "abc123", "2024-01-16T00:00:00Z")

  db.close()
}

function createProjectReport(dir: string, projectId: string): void {
  const reportDir = join(dir, "reports", "projects", projectId)
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, "SUMMARY.md"), `# Scan summary: ${projectId}\n\n- findings: 1\n`)
}

describe("SecurityWatchClient", () => {
  let tmpDir: string
  let client: SecurityWatchClient

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sw-test-"))
    createTestDb(tmpDir)
    createProjectReport(tmpDir, "demo-shop")
    client = new SecurityWatchClient({ dataDir: tmpDir })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("healthCheck", () => {
    it("returns success:true when database is accessible", async () => {
      const result = await client.healthCheck()
      expect(result.success).toBe(true)
    })

    it("returns success:false when database is missing", async () => {
      const badClient = new SecurityWatchClient({ dataDir: "/nonexistent/path" })
      const result = await badClient.healthCheck()
      expect(result.success).toBe(false)
    })
  })

  describe("getLatestBulletins", () => {
    it("returns all bulletins ordered by created_at desc", async () => {
      const result = await client.getLatestBulletins()
      expect(result.success).toBe(true)
      const data = result.data as Array<Record<string, unknown>>
      expect(data).toHaveLength(2)
      expect((data[0] as Record<string, unknown>)["externalId"]).toBe("APSB24-02")
      expect((data[1] as Record<string, unknown>)["externalId"]).toBe("APSB24-01")
    })
  })

  describe("getProjectFindings", () => {
    it("returns findings for a project", async () => {
      const result = await client.getProjectFindings("demo-shop")
      expect(result.success).toBe(true)
      const data = result.data as Record<string, unknown>
      const findings = data["findings"] as Array<Record<string, unknown>>
      expect(findings).toHaveLength(1)
      expect(findings[0]!["projectId"]).toBe("demo-shop")
      expect(findings[0]!["remediationStatus"]).toBe("vulnerable")
    })

    it("includes SUMMARY.md content", async () => {
      const result = await client.getProjectFindings("demo-shop")
      const data = result.data as Record<string, unknown>
      expect(data["summary"] as string).toContain("Scan summary: demo-shop")
    })

    it("returns empty findings for unknown project", async () => {
      const result = await client.getProjectFindings("unknown-project")
      expect(result.success).toBe(true)
      const data = result.data as Record<string, unknown>
      expect((data["findings"] as Array<unknown>)).toHaveLength(0)
    })
  })

  describe("registerAlert", () => {
    it("returns success with service info", async () => {
      const result = await client.registerAlert("demo-shop", "1d")
      expect(result.success).toBe(true)
      const data = result.data as Record<string, unknown>
      expect(data["serviceName"]).toBe("demo-shop")
      expect(data["duration"]).toBe("1d")
    })
  })

  describe("factory function", () => {
    it("createSecurityWatchClient creates configured client", () => {
      const c = createSecurityWatchClient({ dataDir: tmpDir })
      expect(c).toBeInstanceOf(SecurityWatchClient)
      expect(c.name).toBe("security-watch")
    })
  })
})
