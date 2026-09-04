import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import type { Command } from "commander"

export function buildStorageCommands(program: Command, engine: WorkflowEngine): void {
  const storage = program.command("storage").description("管理本地与 CloudBase 必要数据同步")

  storage
    .command("status")
    .description("查看同步状态（不访问远端）")
    .option("--json", "以 JSON 格式输出")
    .action(async (options: { json?: boolean }) => {
      try {
        const status = await engine.getStorageSyncStatus()
        if (options.json) {
          console.log(JSON.stringify(status, null, 2))
          return
        }
        console.log(`远端同步状态: ${status.state}`)
        console.log(`本地总修订: ${status.localRevision}`)
        console.log(`必要数据修订: ${status.remoteDataRevision}`)
        console.log(`已同步必要数据修订: ${status.lastSyncedRemoteDataRevision}`)
        if (status.lastSyncedAt) console.log(`最近同步时间: ${status.lastSyncedAt}`)
        if (status.lastError) console.log(`最近错误: ${status.lastError}`)
      } catch (error) {
        console.error(`❌ 获取存储同步状态失败: ${(error as Error).message}`)
        process.exit(1)
      }
    })

  storage
    .command("sync")
    .description("通过 CloudBase PG REST 显式同步项目和需求")
    .option("--json", "以 JSON 格式输出")
    .action(async (options: { json?: boolean }) => {
      try {
        const status = await engine.syncRemoteStorage()
        if (options.json) {
          console.log(JSON.stringify(status, null, 2))
          return
        }
        console.log("✅ CloudBase 必要数据同步完成")
        console.log(`   项目/需求修订: ${status.lastSyncedRemoteDataRevision}`)
        console.log("   运行记录、审计事件和集成健康状态仍只保存在本地 SQLite")
      } catch (error) {
        console.error(`❌ CloudBase 必要数据同步失败: ${(error as Error).message}`)
        process.exit(1)
      }
    })
}
