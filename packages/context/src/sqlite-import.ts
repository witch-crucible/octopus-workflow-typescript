import { createHash } from "node:crypto"
import { resolve } from "node:path"
import Database from "better-sqlite3"
import postgres, { type Sql, type TransactionSql } from "postgres"
import { ProjectId, RequirementId } from "@octopus/core/branded-ids.js"
import { createEmptyProject } from "@octopus/core/project.js"
import { migrateWorkflowState } from "@octopus/core/workflow.js"
import { PersistenceError } from "@octopus/core/errors.js"
import { describeDatabaseUrl, resolveDatabaseUrl } from "./database-config.js"
import { STORE_SCHEMA_VERSION } from "./persistence.js"

const TABLES = [
  "capy_projects",
  "capy_requirements",
  "capy_workflow_runs",
  "capy_workflow_events",
  "capy_integration_health",
] as const
type TableName = (typeof TABLES)[number]
type DataRow = Record<string, string | number | null>
type QueryClient = Sql | TransactionSql

const PRIMARY_KEYS: Record<TableName, string> = {
  capy_projects: "project_id",
  capy_requirements: "requirement_id",
  capy_workflow_runs: "id",
  capy_workflow_events: "sequence",
  capy_integration_health: "service",
}

export interface SqliteSourceSummary {
  path: string
  version: "1" | "2"
  counts: Record<TableName, number>
}

export interface ImportDataset {
  rows: Record<TableName, DataRow[]>
  sources: SqliteSourceSummary[]
}

export interface ImportReport {
  applied: boolean
  sources: SqliteSourceSummary[]
  conflicts: Array<{ table: TableName; key: string; location: "source" | "target" }>
  skipped: Record<TableName, number>
  counts: Record<TableName, number>
  digests: Record<TableName, string>
}

/** 只读加载多个 SQLite，自动识别 v1/v2 并在内存中去重。 */
export function readSqliteSources(sourcePaths: readonly string[]): ImportDataset {
  if (sourcePaths.length === 0) throw new Error("至少需要一个 --source <state.sqlite>")
  const combined = emptyRows()
  const sources: SqliteSourceSummary[] = []

  for (const sourcePath of sourcePaths) {
    const path = resolve(sourcePath)
    const db = new Database(path, { readonly: true, fileMustExist: true })
    try {
      const version = detectVersion(db)
      const rows = version === "1" ? readV1(db) : readV2(db)
      sources.push({ path, version, counts: rowCounts(rows) })
      mergeRows(combined, rows, "source")
    } finally {
      db.close()
    }
  }
  sortRows(combined)
  return { rows: combined, sources }
}

export async function importSqliteDataset(options: {
  dataset: ImportDataset
  apply: boolean
  databaseUrl?: string
}): Promise<ImportReport> {
  const databaseUrl = resolveDatabaseUrl(
    options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl },
  )
  const target = describeDatabaseUrl(databaseUrl)
  const client = createSafeClient(databaseUrl, target)
  try {
    await assertRemoteSchema(client, target)
    const remoteRows = await readRemoteRows(client)
    const conflicts: ImportReport["conflicts"] = []
    const skipped = zeroCounts()
    for (const table of TABLES) {
      const remoteByKey = byPrimaryKey(table, remoteRows[table])
      for (const row of options.dataset.rows[table]) {
        const key = String(row[PRIMARY_KEYS[table]])
        const remote = remoteByKey.get(key)
        if (!remote) continue
        if (canonicalRow(remote) === canonicalRow(row)) skipped[table]++
        else conflicts.push({ table, key, location: "target" })
      }
    }

    if (conflicts.length > 0) {
      return report(options.dataset, false, conflicts, skipped)
    }
    if (!options.apply) return report(options.dataset, false, [], skipped)

    await client.begin(async (transaction) => {
      for (const table of TABLES) {
        for (const row of options.dataset.rows[table]) {
          await insertRow(transaction, table, row)
        }
      }
      await transaction.unsafe(`
        SELECT setval(
          pg_get_serial_sequence('public.capy_workflow_events', 'sequence'),
          COALESCE((SELECT MAX(sequence) FROM public.capy_workflow_events), 0) + 1,
          false
        )
      `)
      const importedRemote = await readRemoteRows(transaction)
      assertMatchingDataset(options.dataset.rows, importedRemote)
    })

    return report(options.dataset, true, [], skipped)
  } catch (cause) {
    if (cause instanceof PersistenceError) throw cause
    throw new PersistenceError(
      "DATABASE_UNAVAILABLE",
      `SQLite 导入访问 PostgreSQL ${target} 失败；事务已回滚`,
    )
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined)
  }
}

export async function verifyRemoteDatabase(
  options: { databaseUrl?: string } = {},
): Promise<{
  counts: Record<TableName | "capy_octopus_meta" | "capy_drizzle_migrations", number>
  digests: Record<TableName, string>
}> {
  const databaseUrl = resolveDatabaseUrl(
    options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl },
  )
  const target = describeDatabaseUrl(databaseUrl)
  const client = createSafeClient(databaseUrl, target)
  try {
    await assertRemoteSchema(client, target)
    const rows = await readRemoteRows(client)
    const meta = await client.unsafe<DataRow[]>(
      "SELECT * FROM public.capy_octopus_meta ORDER BY key",
    )
    const ledger = await client.unsafe<DataRow[]>(
      "SELECT * FROM public.capy_drizzle_migrations ORDER BY id",
    )
    return {
      counts: {
        ...rowCounts(rows),
        capy_octopus_meta: meta.length,
        capy_drizzle_migrations: ledger.length,
      },
      digests: tableDigests(rows),
    }
  } catch (cause) {
    if (cause instanceof PersistenceError) throw cause
    throw new PersistenceError("DATABASE_UNAVAILABLE", `数据库核验访问 PostgreSQL ${target} 失败`)
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined)
  }
}

function createSafeClient(databaseUrl: string, target: string): Sql {
  try {
    return postgres(databaseUrl, { prepare: false })
  } catch {
    throw new PersistenceError(
      "DATABASE_UNAVAILABLE",
      `数据库连接串无效（${target}）；请检查 URL 格式`,
    )
  }
}

function detectVersion(db: Database.Database): "1" | "2" {
  const requirementTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='requirements'")
    .get()
  if (requirementTable) return "2"
  const projectColumns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>
  if (projectColumns.some((column) => column.name === "project_name")) return "1"
  throw new Error("无法识别 SQLite schema；仅支持 Octopus v1/v2 state.sqlite")
}

function readV2(db: Database.Database): Record<TableName, DataRow[]> {
  return {
    capy_projects: readTable(db, "projects"),
    capy_requirements: readTable(db, "requirements"),
    capy_workflow_runs: readTable(db, "workflow_runs"),
    capy_workflow_events: readTable(db, "workflow_events"),
    capy_integration_health: readTable(db, "integration_health"),
  }
}

function readV1(db: Database.Database): Record<TableName, DataRow[]> {
  const result = emptyRows()
  const legacyProjects = readTable(db, "projects")
  for (const row of legacyProjects) {
    const legacyId = String(row["project_id"])
    const name = String(row["project_name"])
    const updatedAt = String(row["updated_at"])
    const containerId = ProjectId(`proj_wrap_${legacyId}`)
    const project = {
      ...createEmptyProject(containerId, name, ""),
      createdAt: updatedAt,
      updatedAt,
    }
    const state = migrateWorkflowState(JSON.parse(String(row["state_json"])), {
      projectId: containerId,
    })
    state.projectId = containerId
    state.requirementId = RequirementId(legacyId)
    state.requirementName = state.requirementName || name
    result.capy_projects.push({
      project_id: containerId,
      name,
      description: "",
      state_json: JSON.stringify(project),
      updated_at: updatedAt,
    })
    result.capy_requirements.push({
      requirement_id: legacyId,
      parent_project_id: containerId,
      requirement_name: state.requirementName,
      state_json: JSON.stringify(state),
      updated_at: updatedAt,
    })
  }
  result.capy_workflow_runs = normalizeLegacyForeignKey(readTable(db, "workflow_runs"))
  result.capy_workflow_events = normalizeLegacyForeignKey(readTable(db, "workflow_events"))
  result.capy_integration_health = readTable(db, "integration_health")
  return result
}

function normalizeLegacyForeignKey(rows: DataRow[]): DataRow[] {
  return rows.map((row) => {
    const normalized = { ...row }
    if (!("requirement_id" in normalized) && "project_id" in normalized) {
      normalized["requirement_id"] = normalized["project_id"] ?? null
      delete normalized["project_id"]
    }
    return normalized
  })
}

function readTable(db: Database.Database, table: string): DataRow[] {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  if (!exists) return []
  return db.prepare(`SELECT * FROM ${table}`).all() as DataRow[]
}

async function assertRemoteSchema(client: Sql, target: string): Promise<void> {
  try {
    const rows = await client<{ value: string }[]>`
      SELECT value FROM public.capy_octopus_meta WHERE key = 'schema_version'
    `
    if (rows[0]?.value !== STORE_SCHEMA_VERSION) throw new Error("schema version mismatch")
  } catch {
    throw new PersistenceError(
      "DATABASE_SCHEMA_MISMATCH",
      `PostgreSQL ${target} 尚未迁移到 Octopus schema v${STORE_SCHEMA_VERSION}；请执行 pnpm db:migrate`,
    )
  }
}

async function readRemoteRows(client: QueryClient): Promise<Record<TableName, DataRow[]>> {
  const rows = emptyRows()
  for (const table of TABLES) {
    const key = PRIMARY_KEYS[table]
    rows[table] = await client.unsafe<DataRow[]>(`SELECT * FROM public.${table} ORDER BY ${key}`)
  }
  return rows
}

async function insertRow(client: QueryClient, table: TableName, row: DataRow): Promise<void> {
  const columns = Object.keys(row)
  const values = columns.map((column) => row[column] ?? null)
  const quoted = columns.map((column) => `"${column}"`).join(", ")
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ")
  await client.unsafe(
    `INSERT INTO public.${table} (${quoted}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
    values as never[],
  )
}

function mergeRows(
  target: Record<TableName, DataRow[]>,
  incoming: Record<TableName, DataRow[]>,
  location: "source",
): void {
  for (const table of TABLES) {
    const index = byPrimaryKey(table, target[table])
    for (const row of incoming[table]) {
      const key = String(row[PRIMARY_KEYS[table]])
      const existing = index.get(key)
      if (existing && canonicalRow(existing) !== canonicalRow(row)) {
        throw new Error(`SQLite 来源冲突: ${table} 主键 ${key} 内容不同（${location}）`)
      }
      if (!existing) {
        target[table].push(row)
        index.set(key, row)
      }
    }
  }
}

function assertMatchingDataset(
  expected: Record<TableName, DataRow[]>,
  actual: Record<TableName, DataRow[]>,
): void {
  for (const table of TABLES) {
    if (expected[table].length !== actual[table].length) {
      throw new Error(`${table} 行数不一致: ${expected[table].length} != ${actual[table].length}`)
    }
    if (
      digestRows(expected[table], PRIMARY_KEYS[table]) !==
      digestRows(actual[table], PRIMARY_KEYS[table])
    ) {
      throw new Error(`${table} SHA-256 摘要不一致`)
    }
  }
}

function report(
  dataset: ImportDataset,
  applied: boolean,
  conflicts: ImportReport["conflicts"],
  skipped: Record<TableName, number>,
): ImportReport {
  return {
    applied,
    sources: dataset.sources,
    conflicts,
    skipped,
    counts: rowCounts(dataset.rows),
    digests: tableDigests(dataset.rows),
  }
}

function emptyRows(): Record<TableName, DataRow[]> {
  return {
    capy_projects: [],
    capy_requirements: [],
    capy_workflow_runs: [],
    capy_workflow_events: [],
    capy_integration_health: [],
  }
}

function zeroCounts(): Record<TableName, number> {
  return rowCounts(emptyRows())
}

function rowCounts(rows: Record<TableName, DataRow[]>): Record<TableName, number> {
  return Object.fromEntries(TABLES.map((table) => [table, rows[table].length])) as Record<
    TableName,
    number
  >
}

function tableDigests(rows: Record<TableName, DataRow[]>): Record<TableName, string> {
  return Object.fromEntries(
    TABLES.map((table) => [table, digestRows(rows[table], PRIMARY_KEYS[table])]),
  ) as Record<TableName, string>
}

function sortRows(rows: Record<TableName, DataRow[]>): void {
  for (const table of TABLES) {
    const key = PRIMARY_KEYS[table]
    rows[table].sort((left, right) => String(left[key]).localeCompare(String(right[key])))
  }
}

function byPrimaryKey(table: TableName, rows: DataRow[]): Map<string, DataRow> {
  const key = PRIMARY_KEYS[table]
  return new Map(rows.map((row) => [String(row[key]), row]))
}

function digestRows(rows: DataRow[], primaryKey: string): string {
  const sorted = [...rows].sort((left, right) =>
    String(left[primaryKey]).localeCompare(String(right[primaryKey])),
  )
  return createHash("sha256").update(sorted.map(canonicalRow).join("\n")).digest("hex")
}

function canonicalRow(row: DataRow): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))),
  )
}
