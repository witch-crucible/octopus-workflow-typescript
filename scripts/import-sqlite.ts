import { importSqliteDataset, readSqliteSources } from "../packages/context/src/sqlite-import.js"

const args = process.argv.slice(2)
const sources: string[] = []
let apply = false
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === "--apply") {
    apply = true
    continue
  }
  if (arg === "--source") {
    const source = args[++index]
    if (!source) throw new Error("--source 缺少路径")
    sources.push(source)
    continue
  }
  throw new Error(`未知参数: ${arg}`)
}

const dataset = readSqliteSources(sources)
const report = await importSqliteDataset({ dataset, apply })

console.log(apply ? "SQLite 导入结果（apply）" : "SQLite 导入预检（dry-run）")
for (const source of report.sources) {
  console.log(`来源: ${source.path}  schema=v${source.version}`)
  for (const [table, count] of Object.entries(source.counts)) console.log(`  ${table}: ${count}`)
}
console.log("目标表摘要:")
for (const [table, count] of Object.entries(report.counts)) {
  const digest = report.digests[table as keyof typeof report.digests]
  const skipped = report.skipped[table as keyof typeof report.skipped]
  console.log(`  ${table}: rows=${count} skipped=${skipped} sha256=${digest}`)
}
if (report.conflicts.length > 0) {
  for (const conflict of report.conflicts) {
    console.error(`冲突: ${conflict.table} 主键=${conflict.key} 位置=${conflict.location}`)
  }
  process.exitCode = 1
} else if (!apply) {
  console.log("dry-run 完成；确认后追加 --apply 执行整事务导入")
} else {
  console.log("导入和远端摘要核验完成")
}
