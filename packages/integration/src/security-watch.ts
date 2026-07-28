import Database from "better-sqlite3"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { IntegrationResult, MonitoringIntegration } from "./index.js"

export interface SecurityWatchConfig {
  dataDir: string
}

interface BulletinRow {
  external_id: string
  title: string
  published_at: string | null
  url: string | null
  created_at: string
  updated_at: string
}

interface FindingRow {
  project_id: string
  risk_id: string
  remediation_status: string
  fix_method: string
  evidence_json: string
  analysis_snapshot_json: string | null
  project_narrative: string | null
  report_path: string | null
  created_at: string
  bulletin_external_id: string
}

export class SecurityWatchClient implements MonitoringIntegration {
  readonly name = "security-watch"
  private readonly dataDir: string
  private db: Database.Database | null = null

  constructor(config: SecurityWatchConfig) {
    this.dataDir = config.dataDir
  }

  private getDb(): Database.Database {
    if (!this.db) {
      this.db = new Database(join(this.dataDir, "db", "watcher.sqlite"))
    }
    return this.db
  }

  private get reportsDir(): string {
    return join(this.dataDir, "reports")
  }

  async healthCheck(): Promise<IntegrationResult> {
    try {
      const db = this.getDb()
      db.prepare("SELECT 1").get()
      return { success: true, message: "安全监控数据源可用" }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `安全监控不可用: ${message}`, error: message }
    }
  }

  async getLatestBulletins(): Promise<IntegrationResult> {
    try {
      const db = this.getDb()
      const rows = db
        .prepare(
          `SELECT external_id, title, published_at, url, created_at, updated_at
           FROM bulletins
           ORDER BY created_at DESC`,
        )
        .all() as BulletinRow[]

      const bulletins = rows.map((r) => ({
        externalId: r.external_id,
        title: r.title,
        publishedAt: r.published_at,
        url: r.url,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))

      return { success: true, message: `获取到 ${bulletins.length} 个公告`, data: bulletins }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `获取公告失败: ${message}`, error: message }
    }
  }

  async getProjectFindings(projectId: string): Promise<IntegrationResult> {
    try {
      const db = this.getDb()
      const rows = db
        .prepare(
          `SELECT f.project_id, f.risk_id, f.remediation_status, f.fix_method,
                  f.evidence_json, f.analysis_snapshot_json, f.project_narrative,
                  f.report_path, f.created_at,
                  r.bulletin_external_id
           FROM findings f
           JOIN risk_items r ON f.risk_id = r.risk_id
           WHERE f.project_id = ?
           ORDER BY f.created_at DESC`,
        )
        .all(projectId) as FindingRow[]

      const findings = rows.map((r) => {
        const finding: Record<string, unknown> = {
          projectId: r.project_id,
          riskId: r.risk_id,
          bulletinExternalId: r.bulletin_external_id,
          remediationStatus: r.remediation_status,
          fixMethod: r.fix_method,
          createdAt: r.created_at,
          reportPath: r.report_path,
        }
        if (r.project_narrative) finding["projectNarrative"] = r.project_narrative
        if (r.evidence_json) {
          try {
            finding["evidence"] = JSON.parse(r.evidence_json) as unknown
          } catch {
            finding["evidence"] = r.evidence_json
          }
        }
        if (r.analysis_snapshot_json) {
          try {
            finding["analysisSnapshot"] = JSON.parse(r.analysis_snapshot_json) as unknown
          } catch {
            finding["analysisSnapshot"] = r.analysis_snapshot_json
          }
        }
        return finding
      })

      let summary = ""
      try {
        const summaryPath = join(this.reportsDir, "projects", projectId, "SUMMARY.md")
        summary = await readFile(summaryPath, "utf-8")
      } catch {
        summary = ""
      }

      return {
        success: true,
        message: `获取到 ${findings.length} 个扫描结果`,
        data: { findings, summary },
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `获取扫描结果失败: ${message}`, error: message }
    }
  }

  async registerAlert(serviceName: string, duration: "1d" | "1w" | "1y"): Promise<IntegrationResult> {
    return {
      success: true,
      message: `安全监控已注册：${serviceName}（周期 ${duration}）`,
      data: { serviceName, duration },
    }
  }
}

export function createSecurityWatchClient(config: SecurityWatchConfig): SecurityWatchClient {
  return new SecurityWatchClient(config)
}
