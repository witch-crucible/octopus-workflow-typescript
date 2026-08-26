import { verifyRemoteDatabase } from "../packages/context/src/sqlite-import.js"

const result = await verifyRemoteDatabase()
console.log("PostgreSQL 核心状态库核验")
for (const [table, count] of Object.entries(result.counts)) {
  const digest = result.digests[table as keyof typeof result.digests]
  console.log(`  ${table}: rows=${count}${digest ? ` sha256=${digest}` : ""}`)
}

const expected: Record<string, number> = {
  capy_projects: 3,
  capy_requirements: 4,
  capy_workflow_runs: 0,
  capy_workflow_events: 0,
  capy_integration_health: 0,
}
for (const [table, count] of Object.entries(expected)) {
  if (result.counts[table as keyof typeof result.counts] !== count) {
    throw new Error(`${table} 行数不符合首次切换预期 ${count}`)
  }
}
console.log("首次切换预期已满足：3 个项目、4 个需求、运行/事件/健康记录均为 0")
