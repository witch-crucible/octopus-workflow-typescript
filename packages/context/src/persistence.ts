import { isAbsolute, resolve } from "node:path"
import postgres, { type Sql } from "postgres"
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import type { WorkflowState } from "@octopus/core/workflow.js"
import type { Project } from "@octopus/core/project.js"
import { ProjectId, RequirementId } from "@octopus/core/branded-ids.js"
import { createEmptyState, migrateWorkflowState } from "@octopus/core/workflow.js"
import { createEmptyProject } from "@octopus/core/project.js"
import { PersistenceError, StoreError } from "@octopus/core/errors.js"
import type {
  IntegrationHealth,
  NodeRun,
  NodeRunStatus,
  WorkflowEvent,
} from "@octopus/core/execution.js"
import { describeDatabaseUrl, resolveDatabaseUrl } from "./database-config.js"
import {
  integrationHealth,
  octopusMeta,
  persistenceSchema,
  projects,
  requirements,
  workflowEvents,
  workflowRuns,
} from "./db/schema.js"
import type { CreateRunInput, ExecutionStore } from "./execution.js"
import type { StateStore, StoreConfig } from "./index.js"

export const STORE_SCHEMA_VERSION = "2"

export type PersistenceDatabase = PgDatabase<PgQueryResultHKT, typeof persistenceSchema>

export interface PersistenceStoreOptions extends Partial<StoreConfig> {
  databaseUrl?: string
}

export interface PersistenceStore extends StateStore, ExecutionStore {
  close(): Promise<void>
}

/** 创建生产 PostgreSQL 存储；连接探针与 schema 检查均在返回前完成。 */
export async function createPersistenceStore(
  options: PersistenceStoreOptions = {},
): Promise<PersistenceStore> {
  const storeDir = options.storeDir ?? ".octo"
  const databaseUrl = resolveDatabaseUrl({
    ...(options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl }),
    storeDir,
  })
  const target = describeDatabaseUrl(databaseUrl)
  let client: Sql
  try {
    client = postgres(databaseUrl, { prepare: false })
  } catch {
    throw new PersistenceError(
      "DATABASE_UNAVAILABLE",
      `DATABASE_URL 无效（${target}）；请检查 PostgreSQL 连接串格式`,
    )
  }
  const database = drizzle(client, { schema: persistenceSchema }) as unknown as PersistenceDatabase
  try {
    await database.execute(sql`select 1`)
  } catch {
    await client.end({ timeout: 1 }).catch(() => undefined)
    throw new PersistenceError(
      "DATABASE_UNAVAILABLE",
      `无法连接 PostgreSQL ${target}；请检查 DATABASE_URL、网络和 Supabase 项目状态`,
    )
  }

  const store = new PostgresPersistenceStore(database, storeDir, async () => {
    await client.end({ timeout: 5 })
  })
  try {
    await store.assertSchemaVersion()
  } catch (cause) {
    await store.close().catch(() => undefined)
    if (cause instanceof PersistenceError) throw cause
    throw new PersistenceError(
      "DATABASE_SCHEMA_MISMATCH",
      `PostgreSQL ${target} 尚未迁移到 Octopus schema v${STORE_SCHEMA_VERSION}；请执行 pnpm db:migrate`,
    )
  }
  return store
}

/** 供 PGlite 测试和数据库工具复用与生产完全相同的 repository。 */
export async function createPersistenceStoreFromDatabase(
  database: PersistenceDatabase,
  options: { storeDir?: string; close?: () => Promise<void>; checkSchema?: boolean } = {},
): Promise<PersistenceStore> {
  const store = new PostgresPersistenceStore(
    database,
    options.storeDir ?? ".octo",
    options.close ?? (async () => undefined),
  )
  if (options.checkSchema !== false) await store.assertSchemaVersion()
  return store
}

class PostgresPersistenceStore implements PersistenceStore {
  private closed = false

  constructor(
    private readonly database: PersistenceDatabase,
    private readonly originalStoreDir: string,
    private readonly closeClient: () => Promise<void>,
  ) {}

  async assertSchemaVersion(): Promise<void> {
    let rows: Array<{ value: string }>
    try {
      rows = await this.database
        .select({ value: octopusMeta.value })
        .from(octopusMeta)
        .where(eq(octopusMeta.key, "schema_version"))
        .limit(1)
    } catch {
      throw new PersistenceError(
        "DATABASE_SCHEMA_MISMATCH",
        `数据库 schema 未迁移；请执行 pnpm db:migrate`,
      )
    }
    if (rows[0]?.value !== STORE_SCHEMA_VERSION) {
      throw new PersistenceError(
        "DATABASE_SCHEMA_MISMATCH",
        `数据库 schema 版本为 ${rows[0]?.value ?? "未设置"}，需要 v${STORE_SCHEMA_VERSION}；请执行 pnpm db:migrate`,
      )
    }
  }

  getStorePath(): string {
    return this.originalStoreDir
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.closeClient()
  }

  async load(requirementId: string): Promise<WorkflowState> {
    const rows = await this.database
      .select({ stateJson: requirements.stateJson, parentProjectId: requirements.parentProjectId })
      .from(requirements)
      .where(eq(requirements.requirementId, requirementId))
      .limit(1)
    const row = rows[0]
    if (!row) throw new StoreError("STORE_LOAD_FAILED", `无法加载需求 ${requirementId}`)
    return migrateWorkflowState(JSON.parse(row.stateJson), {
      projectId: ProjectId(row.parentProjectId),
    })
  }

  async save(state: WorkflowState): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await saveRequirement(transaction as PersistenceDatabase, state)
    })
  }

  async update(
    requirementId: string,
    updater: (state: WorkflowState) => WorkflowState,
  ): Promise<WorkflowState> {
    return retryTransaction(() =>
      this.database.transaction(
        async (transaction) => {
          const tx = transaction as PersistenceDatabase
          const rows = await tx
            .select({
              stateJson: requirements.stateJson,
              parentProjectId: requirements.parentProjectId,
            })
            .from(requirements)
            .where(eq(requirements.requirementId, requirementId))
            .for("update")
            .limit(1)
          const row = rows[0]
          if (!row) throw new StoreError("STORE_LOAD_FAILED", `无法加载需求 ${requirementId}`)
          const current = migrateWorkflowState(JSON.parse(row.stateJson), {
            projectId: ProjectId(row.parentProjectId),
          })
          return saveRequirement(tx, updater(current))
        },
        { isolationLevel: "serializable" },
      ),
    )
  }

  async listProjects(): Promise<string[]> {
    const rows = await this.database
      .select({ projectId: projects.projectId })
      .from(projects)
      .orderBy(desc(projects.updatedAt))
    return rows.map((row) => row.projectId)
  }

  async loadProject(projectId: string): Promise<Project> {
    return requireProject(this.database, projectId)
  }

  async saveProject(project: Project): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await saveProject(transaction as PersistenceDatabase, project)
    })
  }

  async updateProject(projectId: string, updater: (project: Project) => Project): Promise<Project> {
    return retryTransaction(() =>
      this.database.transaction(
        async (transaction) => {
          const tx = transaction as PersistenceDatabase
          const current = await requireProject(tx, projectId, true)
          return saveProject(tx, updater(current))
        },
        { isolationLevel: "serializable" },
      ),
    )
  }

  async createProject(name: string, description?: string): Promise<Project> {
    const projectId = ProjectId(`proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    const project = createEmptyProject(projectId, name, description ?? "")
    await this.database.transaction(async (transaction) => {
      await saveProject(transaction as PersistenceDatabase, project)
    })
    return project
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.database.delete(projects).where(eq(projects.projectId, projectId))
  }

  async listRequirements(projectId?: string): Promise<string[]> {
    const base = this.database
      .select({ requirementId: requirements.requirementId })
      .from(requirements)
    const rows =
      projectId === undefined
        ? await base.orderBy(desc(requirements.updatedAt))
        : await base
            .where(eq(requirements.parentProjectId, projectId))
            .orderBy(desc(requirements.updatedAt))
    return rows.map((row) => row.requirementId)
  }

  async createRequirement(
    projectId: string,
    name: string,
    description?: string,
    projectRoot?: string,
  ): Promise<WorkflowState> {
    return retryTransaction(() =>
      this.database.transaction(
        async (transaction) => {
          const tx = transaction as PersistenceDatabase
          await requireProject(tx, projectId, true)
          const requirementId = RequirementId(
            `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          )
          const state = createEmptyState(
            ProjectId(projectId),
            requirementId,
            name,
            description ?? "",
            projectRoot,
          )
          return saveRequirement(tx, state)
        },
        { isolationLevel: "serializable" },
      ),
    )
  }

  async deleteRequirement(requirementId: string): Promise<void> {
    await this.database.delete(requirements).where(eq(requirements.requirementId, requirementId))
  }

  async createRun(input: CreateRunInput): Promise<NodeRun> {
    const now = new Date().toISOString()
    const id = input.id ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    await this.database.insert(workflowRuns).values({
      id,
      requirementId: input.requirementId,
      nodeId: input.nodeId,
      status: "QUEUED",
      forced: input.forced ? 1 : 0,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
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

  async getRun(runId: string): Promise<NodeRun | undefined> {
    const rows = await this.database
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1)
    return rows[0] ? toRun(rows[0]) : undefined
  }

  async listRuns(requirementId: string, nodeId?: string): Promise<NodeRun[]> {
    const where =
      nodeId === undefined
        ? eq(workflowRuns.requirementId, requirementId)
        : and(eq(workflowRuns.requirementId, requirementId), eq(workflowRuns.nodeId, nodeId))
    const rows = await this.database
      .select()
      .from(workflowRuns)
      .where(where)
      .orderBy(sql`${workflowRuns.startedAt} DESC NULLS FIRST`, desc(workflowRuns.id))
    return rows.map(toRun)
  }

  async updateRun(runId: string, patch: Partial<NodeRun>): Promise<NodeRun> {
    const values = runPatch(patch)
    const rows =
      Object.keys(values).length === 0
        ? await this.database.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1)
        : await this.database
            .update(workflowRuns)
            .set(values)
            .where(eq(workflowRuns.id, runId))
            .returning()
    const row = rows[0]
    if (!row) throw new Error(`运行不存在: ${runId}`)
    return toRun(row)
  }

  async transitionRun(
    runId: string,
    from: readonly NodeRunStatus[],
    patch: Partial<NodeRun>,
  ): Promise<NodeRun | undefined> {
    if (from.length === 0) return undefined
    const values = runPatch(patch)
    if (Object.keys(values).length === 0) throw new Error("运行状态转换 patch 不能为空")
    const rows = await this.database
      .update(workflowRuns)
      .set(values)
      .where(and(eq(workflowRuns.id, runId), inArray(workflowRuns.status, from)))
      .returning()
    return rows[0] ? toRun(rows[0]) : undefined
  }

  async appendEvent(event: Omit<WorkflowEvent, "sequence">): Promise<WorkflowEvent> {
    const rows = await this.database
      .insert(workflowEvents)
      .values({
        requirementId: event.requirementId,
        runId: event.runId ?? null,
        nodeId: event.nodeId ?? null,
        type: event.type,
        payloadJson: JSON.stringify(event.payload),
        createdAt: event.createdAt,
      })
      .returning({ sequence: workflowEvents.sequence })
    const sequence = rows[0]?.sequence
    if (sequence === undefined) throw new StoreError("STORE_SAVE_FAILED", "无法写入工作流事件")
    return { ...event, sequence }
  }

  async eventsAfter(requirementId: string, sequence: number): Promise<WorkflowEvent[]> {
    const rows = await this.database
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.requirementId, requirementId),
          sql`${workflowEvents.sequence} > ${sequence}`,
        ),
      )
      .orderBy(workflowEvents.sequence)
    return rows.map((row) => ({
      sequence: row.sequence,
      requirementId: row.requirementId,
      ...(row.runId !== null ? { runId: row.runId } : {}),
      ...(row.nodeId !== null ? { nodeId: row.nodeId } : {}),
      type: row.type as WorkflowEvent["type"],
      payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
      createdAt: row.createdAt,
    }))
  }

  async saveIntegrationHealth(health: IntegrationHealth): Promise<void> {
    await this.database
      .insert(integrationHealth)
      .values({
        service: health.service,
        healthy: health.healthy ? 1 : 0,
        latencyMs: health.latencyMs,
        message: health.message,
        checkedAt: health.checkedAt,
      })
      .onConflictDoUpdate({
        target: integrationHealth.service,
        set: {
          healthy: health.healthy ? 1 : 0,
          latencyMs: health.latencyMs,
          message: health.message,
          checkedAt: health.checkedAt,
        },
      })
  }

  async listIntegrationHealth(): Promise<IntegrationHealth[]> {
    const rows = await this.database
      .select()
      .from(integrationHealth)
      .orderBy(integrationHealth.service)
    return rows.map((row) => ({
      service: row.service,
      healthy: row.healthy === 1,
      latencyMs: row.latencyMs,
      message: row.message,
      checkedAt: row.checkedAt,
    }))
  }

  async purge(before: string): Promise<number> {
    return this.database.transaction(async (transaction) => {
      const tx = transaction as PersistenceDatabase
      const removed = await tx
        .delete(workflowRuns)
        .where(and(isNotNull(workflowRuns.finishedAt), lt(workflowRuns.finishedAt, before)))
        .returning({ id: workflowRuns.id })
      await tx.delete(workflowEvents).where(lt(workflowEvents.createdAt, before))
      await tx.delete(integrationHealth).where(lt(integrationHealth.checkedAt, before))
      return removed.length
    })
  }
}

async function requireProject(
  database: PersistenceDatabase,
  projectId: string,
  lock = false,
): Promise<Project> {
  const query = database
    .select({ stateJson: projects.stateJson })
    .from(projects)
    .where(eq(projects.projectId, projectId))
  const rows = lock ? await query.for("update").limit(1) : await query.limit(1)
  if (!rows[0]) throw new StoreError("STORE_LOAD_FAILED", `无法加载项目 ${projectId}`)
  return JSON.parse(rows[0].stateJson) as Project
}

async function saveProject(database: PersistenceDatabase, project: Project): Promise<Project> {
  const updatedAt = new Date().toISOString()
  project.updatedAt = updatedAt
  await database
    .insert(projects)
    .values({
      projectId: project.projectId,
      name: project.name,
      description: project.description,
      stateJson: JSON.stringify(project),
      updatedAt,
    })
    .onConflictDoUpdate({
      target: projects.projectId,
      set: {
        name: project.name,
        description: project.description,
        stateJson: JSON.stringify(project),
        updatedAt,
      },
    })
  return project
}

async function saveRequirement(
  database: PersistenceDatabase,
  state: WorkflowState,
): Promise<WorkflowState> {
  const updatedAt = new Date().toISOString()
  state.updatedAt = updatedAt
  await database
    .insert(requirements)
    .values({
      requirementId: state.requirementId,
      parentProjectId: state.projectId,
      requirementName: state.requirementName,
      stateJson: JSON.stringify(state),
      updatedAt,
    })
    .onConflictDoUpdate({
      target: requirements.requirementId,
      set: {
        parentProjectId: state.projectId,
        requirementName: state.requirementName,
        stateJson: JSON.stringify(state),
        updatedAt,
      },
    })
  return state
}

async function retryTransaction<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (cause) {
      const code = (cause as { code?: string }).code
      if ((code !== "40001" && code !== "40P01") || attempt >= 2) {
        if (code === "40001" || code === "40P01") {
          throw new PersistenceError(
            "DATABASE_CONFLICT",
            "数据库事务冲突，有限重试后仍未成功；请稍后重试",
          )
        }
        throw cause
      }
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 5 * 2 ** attempt + Math.floor(Math.random() * 10))
      })
    }
  }
}

type RunRow = typeof workflowRuns.$inferSelect

function runPatch(patch: Partial<NodeRun>): Partial<typeof workflowRuns.$inferInsert> {
  const values: Partial<typeof workflowRuns.$inferInsert> = {}
  if (patch.status !== undefined) values.status = patch.status
  if (patch.forced !== undefined) values.forced = patch.forced ? 1 : 0
  if (Object.hasOwn(patch, "pid")) values.pid = patch.pid ?? null
  if (Object.hasOwn(patch, "currentAction")) values.currentAction = patch.currentAction ?? null
  if (Object.hasOwn(patch, "startedAt")) values.startedAt = patch.startedAt ?? null
  if (Object.hasOwn(patch, "finishedAt")) values.finishedAt = patch.finishedAt ?? null
  if (Object.hasOwn(patch, "heartbeatAt")) values.heartbeatAt = patch.heartbeatAt ?? null
  if (Object.hasOwn(patch, "exitCode")) values.exitCode = patch.exitCode ?? null
  if (Object.hasOwn(patch, "error")) values.error = patch.error ?? null
  if (patch.stdoutPath !== undefined) values.stdoutPath = patch.stdoutPath
  if (patch.stderrPath !== undefined) values.stderrPath = patch.stderrPath
  return values
}

function toRun(row: RunRow): NodeRun {
  return {
    id: row.id,
    requirementId: row.requirementId,
    nodeId: row.nodeId,
    status: row.status as NodeRunStatus,
    forced: row.forced === 1,
    ...(row.pid !== null ? { pid: row.pid } : {}),
    ...(row.currentAction !== null ? { currentAction: row.currentAction } : {}),
    ...(row.startedAt !== null ? { startedAt: row.startedAt } : {}),
    ...(row.finishedAt !== null ? { finishedAt: row.finishedAt } : {}),
    ...(row.heartbeatAt !== null ? { heartbeatAt: row.heartbeatAt } : {}),
    ...(row.exitCode !== null ? { exitCode: row.exitCode } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    stdoutPath: row.stdoutPath,
    stderrPath: row.stderrPath,
  }
}

export function absoluteStoreDir(storeDir: string): string {
  return isAbsolute(storeDir) ? storeDir : resolve(storeDir)
}
