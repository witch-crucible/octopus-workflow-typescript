/**
 * `octopus version` —— Teambition 版本计划管理。
 *
 * 子命令:
 *   list <projectId> [--refresh] [--json]
 *   show <projectId> <versionId> [--json]
 *   sync <projectId> [--json]
 *   default <projectId> [--set <versionId>] [--clear] [--json]
 *   bind <requirementId> --version <versionId> [--json]
 *   unbind <requirementId> [--json]
 *   note <projectId> <versionId> [--set <text>] [--json]
 *   members <projectId> [--version <versionId>] [--json]
 *   show-req <requirementId> [--json]
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

function fmtDate(value: string | undefined): string {
  return value ?? "-"
}

function countRequirementsByVersion(engine: WorkflowEngine, projectId: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of engine.listVersionRequirements(projectId)) {
    counts.set(item.versionId, (counts.get(item.versionId) ?? 0) + 1)
  }
  return counts
}

function printVersionRows(
  engine: WorkflowEngine,
  projectId: string,
  versions: Array<{
    versionId: string
    name: string
    status?: string
    startDate?: string
    endDate?: string
  }>,
): void {
  const counts = countRequirementsByVersion(engine, projectId)
  const repoId = engine.getProject(projectId).teambitionVersion?.repoId ?? ""
  console.log(`📌 版本（${versions.length}）  仓库 ${repoId}`)
  console.log()
  for (const v of versions) {
    console.log(
      `   ${v.name}   ${v.status ?? ""}   ${fmtDate(v.startDate)} → ${fmtDate(v.endDate)}   需求 ${counts.get(v.versionId) ?? 0}`,
    )
  }
  console.log()
}

export function buildVersionCommands(program: Command, engine: WorkflowEngine): void {
  const version = program.command("version").description("管理 Teambition 版本计划")

  version
    .command("list")
    .description("列出项目版本（默认用缓存，--refresh 强制同步）")
    .argument("<projectId>", "项目 ID")
    .option("--refresh", "强制从 Teambition 同步")
    .option("--json", "以 JSON 格式输出")
    .action(async (projectId: string, options: { refresh?: boolean; json?: boolean }) => {
      try {
        const versions = await engine.listProjectVersions(
          projectId,
          options.refresh === undefined ? undefined : { refresh: options.refresh },
        )
        if (options.json) {
          console.log(JSON.stringify(versions, null, 2))
          return
        }
        if (versions.length === 0) {
          console.log("该仓库暂无版本。")
          return
        }
        printVersionRows(engine, projectId, versions)
      } catch (err) {
        console.error(`❌ 列出版本失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  version
    .command("show")
    .description("查看单个版本")
    .argument("<projectId>", "项目 ID")
    .argument("<versionId>", "版本 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (projectId: string, versionId: string, options: { json?: boolean }) => {
      try {
        const v = await engine.getProjectVersion(projectId, versionId)
        if (options.json) {
          console.log(JSON.stringify(v, null, 2))
          return
        }
        console.log(`${v.name}   ${v.status ?? ""}`)
        console.log(`   版本 ID: ${v.versionId}`)
        console.log(`   仓库: ${v.repoId}`)
        console.log(`   时间: ${fmtDate(v.startDate)} → ${fmtDate(v.endDate)}`)
        if (v.note !== undefined) console.log(`   说明: ${v.note}`)
        if (v.url !== undefined) console.log(`   URL: ${v.url}`)
      } catch (err) {
        console.error(`❌ 查看版本失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  version
    .command("sync")
    .description("强制同步项目版本列表")
    .argument("<projectId>", "项目 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (projectId: string, options: { json?: boolean }) => {
      try {
        const versions = await engine.syncProjectVersions(projectId)
        if (options.json) {
          console.log(JSON.stringify(versions, null, 2))
          return
        }
        console.log(`✅ 已同步版本（${versions.length}）`)
        if (versions.length > 0) printVersionRows(engine, projectId, versions)
      } catch (err) {
        console.error(`❌ 同步版本失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  version
    .command("default")
    .description("查看或设置项目默认版本")
    .argument("<projectId>", "项目 ID")
    .option("--set <versionId>", "设置默认版本")
    .option("--clear", "清除默认版本")
    .option("--json", "以 JSON 格式输出")
    .action((projectId: string, options: { set?: string; clear?: boolean; json?: boolean }) => {
      try {
        const project = engine.getProject(projectId)
        if (options.clear) {
          engine.setProjectDefaultVersion(projectId, null)
          if (options.json) {
            console.log(JSON.stringify({ projectId, defaultVersionId: null }, null, 2))
            return
          }
          console.log(`✅ 已清除默认版本: ${projectId}`)
          return
        }
        if (options.set !== undefined) {
          const updated = engine.setProjectDefaultVersion(projectId, options.set)
          const current = updated.teambitionVersion?.defaultVersionId ?? null
          if (options.json) {
            console.log(JSON.stringify({ projectId, defaultVersionId: current }, null, 2))
            return
          }
          console.log(`✅ 已设置默认版本: ${current}`)
          return
        }
        const current = project.teambitionVersion?.defaultVersionId ?? null
        if (options.json) {
          console.log(JSON.stringify({ projectId, defaultVersionId: current }, null, 2))
          return
        }
        console.log(current === null ? "📌 默认版本: 未设置" : `📌 默认版本: ${current}`)
      } catch (err) {
        console.error(`❌ 设置默认版本失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  version
    .command("bind")
    .description("把需求绑定到版本")
    .argument("<requirementId>", "需求 ID")
    .requiredOption("--version <versionId>", "版本 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (requirementId: string, options: { version: string; json?: boolean }) => {
      try {
        const state = await engine.bindRequirementVersion(requirementId, options.version)
        if (options.json) {
          console.log(JSON.stringify(state, null, 2))
          return
        }
        console.log(`✅ 需求已绑定版本: ${state.teambitionVersion?.versionId}`)
        console.log(`   需求: ${state.requirementId}`)
      } catch (err) {
        console.error(`❌ 绑定版本失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  version
    .command("unbind")
    .description("解除需求的版本绑定")
    .argument("<requirementId>", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action((requirementId: string, options: { json?: boolean }) => {
      try {
        const state = engine.unbindRequirementVersion(requirementId)
        if (options.json) {
          console.log(JSON.stringify(state, null, 2))
          return
        }
        console.log(`✅ 已解除版本绑定: ${state.requirementId}`)
      } catch (err) {
        console.error(`❌ 解除版本绑定失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  version
    .command("note")
    .description("查看或更新版本说明")
    .argument("<projectId>", "项目 ID")
    .argument("<versionId>", "版本 ID")
    .option("--set <text>", "设置版本说明（空串可清空）")
    .option("--json", "以 JSON 格式输出")
    .action(async (projectId: string, versionId: string, options: { set?: string; json?: boolean }) => {
      try {
        if (options.set !== undefined) {
          const result = await engine.updateVersionNote(projectId, versionId, options.set)
          if (options.json) {
            console.log(JSON.stringify(result, null, 2))
            return
          }
          console.log("✅ 版本说明已更新")
          console.log(`   版本: ${result.versionId}`)
          console.log(`   说明: ${result.note === "" ? "（空）" : result.note}`)
          return
        }
        const project = engine.getProject(projectId)
        const cached = project.teambitionVersion?.versionsCache?.find((v) => v.versionId === versionId)
        const note = cached?.note
        if (options.json) {
          console.log(JSON.stringify({ projectId, versionId, note: note ?? null }, null, 2))
          return
        }
        console.log(note === undefined ? "📌 版本说明: （空）" : `📌 版本说明: ${note}`)
      } catch (err) {
        console.error(`❌ 版本说明失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  version
    .command("members")
    .description("列出挂到版本上的需求")
    .argument("<projectId>", "项目 ID")
    .option("--version <versionId>", "按版本过滤")
    .option("--json", "以 JSON 格式输出")
    .action((projectId: string, options: { version?: string; json?: boolean }) => {
      try {
        const members = engine.listVersionRequirements(projectId, options.version)
        if (options.json) {
          console.log(JSON.stringify(members, null, 2))
          return
        }
        if (members.length === 0) {
          console.log("暂无需求绑定版本。")
          return
        }
        console.log(`\n📋 挂版本需求（${members.length}）\n`)
        for (const m of members) {
          console.log(`   ${m.requirementName}   ${m.requirementId}   ${m.versionName ?? m.versionId}`)
        }
        console.log()
      } catch (err) {
        console.error(`❌ 列出版本需求失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  version
    .command("show-req")
    .description("查看需求的版本绑定")
    .argument("<requirementId>", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action((requirementId: string, options: { json?: boolean }) => {
      try {
        const binding = engine.getRequirementVersionBinding(requirementId)
        if (options.json) {
          console.log(JSON.stringify(binding ?? null, null, 2))
          return
        }
        if (!binding) {
          console.log("未绑定")
          return
        }
        console.log(`版本: ${binding.versionId}${binding.versionName ? `   ${binding.versionName}` : ""}`)
        if (binding.repoId) console.log(`   仓库: ${binding.repoId}`)
        if (binding.url) console.log(`   URL: ${binding.url}`)
      } catch (err) {
        console.error(`❌ 查看版本绑定失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })
}
