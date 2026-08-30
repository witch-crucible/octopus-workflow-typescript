import { index, integer, pgTable, serial, text } from "drizzle-orm/pg-core"

export const octopusMeta = pgTable("capy_octopus_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
})

export const projects = pgTable("capy_projects", {
  projectId: text("project_id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  stateJson: text("state_json").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("capy_projects_updated_at_idx").on(table.updatedAt),
])

export const requirements = pgTable("capy_requirements", {
  requirementId: text("requirement_id").primaryKey(),
  parentProjectId: text("parent_project_id").notNull().references(
    () => projects.projectId,
    { onDelete: "cascade" },
  ),
  requirementName: text("requirement_name").notNull(),
  stateJson: text("state_json").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("capy_requirements_project_idx").on(table.parentProjectId, table.updatedAt),
])

export const workflowRuns = pgTable("capy_workflow_runs", {
  id: text("id").primaryKey(),
  requirementId: text("requirement_id").notNull().references(
    () => requirements.requirementId,
    { onDelete: "cascade" },
  ),
  nodeId: text("node_id").notNull(),
  status: text("status").notNull(),
  forced: integer("forced").notNull(),
  pid: integer("pid"),
  currentAction: integer("current_action"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  heartbeatAt: text("heartbeat_at"),
  exitCode: integer("exit_code"),
  error: text("error"),
  stdoutPath: text("stdout_path").notNull(),
  stderrPath: text("stderr_path").notNull(),
}, (table) => [
  index("capy_workflow_runs_requirement_idx").on(
    table.requirementId,
    table.nodeId,
    table.startedAt,
  ),
])

export const workflowEvents = pgTable("capy_workflow_events", {
  sequence: serial("sequence").primaryKey(),
  requirementId: text("requirement_id").notNull().references(
    () => requirements.requirementId,
    { onDelete: "cascade" },
  ),
  runId: text("run_id"),
  nodeId: text("node_id"),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("capy_workflow_events_requirement_idx").on(table.requirementId, table.sequence),
])

export const integrationHealth = pgTable("capy_integration_health", {
  service: text("service").primaryKey(),
  healthy: integer("healthy").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  message: text("message").notNull(),
  checkedAt: text("checked_at").notNull(),
})

export const persistenceSchema = {
  octopusMeta,
  projects,
  requirements,
  workflowRuns,
  workflowEvents,
  integrationHealth,
}
