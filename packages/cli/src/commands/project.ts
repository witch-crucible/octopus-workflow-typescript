/**
 * `octopus project` —— 项目容器管理（Project ⊃ Requirement）。
 *
 * 子命令:
 *   create <name> [--desc] [--json]
 *   list [--json]
 *   update <projectId> [--name] [--desc]
 *   delete <projectId> --yes
 *   bind-tb <projectId> (--tb-project <id> | --prefix <PREFIX>)
 *   unbind-tb <projectId>
 *   bind-tb-repo <projectId> --repo <repoId> [--plugin] [--tb-project] [--name] [--json]
 *   unbind-tb-repo <projectId> [--json]
 *   tb-statuses <projectId> [--json]
 *   omniplan-export <projectId> [--file name] [--yes] [--json]
 *   omniplan-import <projectId> [--file pathOrName] [--json]
 *   omniplan-folder <projectId> [--set <folder>] [--file-name <name>] [--json]
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

export function buildProjectCommands(program: Command, engine: WorkflowEngine): void {
  const project = program.command("project").description("管理项目容器")

  project
    .command("create")
    .description("创建项目容器")
    .argument("<name>", "项目名称")
    .option("-d, --desc <desc>", "项目描述")
    .option("--json", "以 JSON 格式输出")
    .action((name: string, options: { desc?: string; json?: boolean }) => {
      try {
        const created = engine.createProject(name, options.desc)
        if (options.json) {
          console.log(JSON.stringify(created, null, 2))
          return
        }
        console.log(`✅ 项目已创建: ${created.name}`)
        console.log(`   项目 ID: ${created.projectId}`)
        if (created.description) console.log(`   描述: ${created.description}`)
      } catch (err) {
        console.error(`❌ 创建项目失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("list")
    .description("列出全部项目")
    .option("--json", "以 JSON 格式输出")
    .action((options: { json?: boolean }) => {
      try {
        const summaries = engine.listProjectSummaries()
        if (options.json) {
          console.log(JSON.stringify(summaries, null, 2))
          return
        }
        if (summaries.length === 0) {
          console.log("暂无项目。使用 `octopus project create <name>` 创建。")
          return
        }
        console.log(`\n📁 项目（${summaries.length}）\n`)
        for (const item of summaries) {
          console.log(`   ${item.name}`)
          console.log(`   ID: ${item.projectId}`)
          console.log(`   需求数: ${item.requirementCount}`)
          if (item.description) console.log(`   描述: ${item.description}`)
          if (item.teambitionProjectId) {
            console.log(`   Teambition: ${item.teambitionProjectId}`)
          }
          if (item.teambitionRepoId) {
            console.log(`   版本仓库: ${item.teambitionRepoId}`)
          }
          console.log(`   更新: ${item.updatedAt}`)
          console.log()
        }
      } catch (err) {
        console.error(`❌ 列出项目失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("update")
    .description("更新项目名称或描述")
    .argument("<projectId>", "项目 ID")
    .option("--name <name>", "新名称")
    .option("-d, --desc <desc>", "新描述")
    .option("--json", "以 JSON 格式输出")
    .action((
      projectId: string,
      options: { name?: string; desc?: string; json?: boolean },
    ) => {
      try {
        if (options.name === undefined && options.desc === undefined) {
          throw new Error("请至少提供 --name 或 --desc")
        }
        const patch: { name?: string; description?: string } = {}
        if (options.name !== undefined) patch.name = options.name
        if (options.desc !== undefined) patch.description = options.desc
        const updated = engine.updateProjectMeta(projectId, patch)
        if (options.json) {
          console.log(JSON.stringify(updated, null, 2))
          return
        }
        console.log(`✅ 项目已更新: ${updated.name}`)
        console.log(`   项目 ID: ${updated.projectId}`)
      } catch (err) {
        console.error(`❌ 更新项目失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("delete")
    .description("删除项目及其下需求状态（不删除源码目录）")
    .argument("<projectId>", "项目 ID")
    .option("--yes", "确认删除")
    .action((projectId: string, options: { yes?: boolean }) => {
      try {
        if (!options.yes) {
          throw new Error(
            "删除不可恢复，请加 --yes 确认。只会删除状态库记录，不会删除源码目录。",
          )
        }
        engine.deleteProject(projectId)
        console.log(`✅ 已删除项目: ${projectId}`)
      } catch (err) {
        console.error(`❌ 删除项目失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("bind-tb")
    .description("绑定 Teambition 项目")
    .argument("<projectId>", "项目 ID")
    .option("--tb-project <id>", "Teambition 项目 ID")
    .option("--prefix <PREFIX>", "Teambition 项目前缀")
    .option("--json", "以 JSON 格式输出")
    .action(async (
      projectId: string,
      options: { tbProject?: string; prefix?: string; json?: boolean },
    ) => {
      try {
        if (!options.tbProject && !options.prefix) {
          throw new Error("请提供 --tb-project <id> 或 --prefix <PREFIX>")
        }
        const updated = await engine.bindProjectTeambition(projectId, {
          ...(options.tbProject !== undefined ? { projectId: options.tbProject } : {}),
          ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
        })
        if (options.json) {
          console.log(JSON.stringify(updated, null, 2))
          return
        }
        console.log(`✅ 已绑定 Teambition 项目: ${updated.teambition?.projectId}`)
        if (updated.teambition?.name) console.log(`   名称: ${updated.teambition.name}`)
        if (updated.teambition?.uniqueIdPrefix) {
          console.log(`   前缀: ${updated.teambition.uniqueIdPrefix}`)
        }
      } catch (err) {
        console.error(`❌ 绑定 Teambition 失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("unbind-tb")
    .description("解除 Teambition 项目绑定")
    .argument("<projectId>", "项目 ID")
    .option("--json", "以 JSON 格式输出")
    .action((projectId: string, options: { json?: boolean }) => {
      try {
        const updated = engine.unbindProjectTeambition(projectId)
        if (options.json) {
          console.log(JSON.stringify(updated, null, 2))
          return
        }
        console.log(`✅ 已解除 Teambition 绑定: ${projectId}`)
      } catch (err) {
        console.error(`❌ 解除绑定失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("bind-tb-repo")
    .description("绑定 Teambition 版本仓库")
    .argument("<projectId>", "项目 ID")
    .requiredOption("--repo <repoId>", "版本仓库 ID")
    .option("--plugin <pluginId>", "Teambition 版本插件 ID")
    .option("--tb-project <tbProjectId>", "Teambition 项目 ID")
    .option("--name <name>", "版本仓库名称")
    .option("--json", "以 JSON 格式输出")
    .action(async (
      projectId: string,
      options: { repo: string; plugin?: string; tbProject?: string; name?: string; json?: boolean },
    ) => {
      try {
        const updated = await engine.bindProjectTeambitionRepo(projectId, {
          repoId: options.repo,
          ...(options.plugin !== undefined ? { pluginId: options.plugin } : {}),
          ...(options.tbProject !== undefined ? { tbProjectId: options.tbProject } : {}),
          ...(options.name !== undefined ? { name: options.name } : {}),
        })
        if (options.json) {
          console.log(JSON.stringify(updated, null, 2))
          return
        }
        console.log(`✅ 已绑定 Teambition 版本仓库: ${updated.teambitionVersion?.repoId}`)
        if (updated.teambitionVersion?.pluginId) {
          console.log(`   插件: ${updated.teambitionVersion.pluginId}`)
        }
        if (updated.teambitionVersion?.tbProjectId) {
          console.log(`   TB 项目: ${updated.teambitionVersion.tbProjectId}`)
        }
      } catch (err) {
        console.error(`❌ 绑定版本仓库失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("unbind-tb-repo")
    .description("解除 Teambition 版本仓库绑定")
    .argument("<projectId>", "项目 ID")
    .option("--json", "以 JSON 格式输出")
    .action((projectId: string, options: { json?: boolean }) => {
      try {
        const updated = engine.unbindProjectTeambitionRepo(projectId)
        if (options.json) {
          console.log(JSON.stringify(updated, null, 2))
          return
        }
        console.log(`✅ 已解除 Teambition 版本仓库绑定: ${projectId}`)
      } catch (err) {
        console.error(`❌ 解除版本仓库绑定失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("tb-statuses")
    .description("列出已绑定 Teambition 项目的卡片状态")
    .argument("<projectId>", "项目 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (projectId: string, options: { json?: boolean }) => {
      try {
        const statuses = await engine.listTeambitionCardStatuses(projectId)
        if (options.json) {
          console.log(JSON.stringify(statuses, null, 2))
          return
        }
        if (statuses.length === 0) {
          console.log("暂无卡片状态。")
          return
        }
        console.log(`\n📌 Teambition 卡片状态（${statuses.length}）\n`)
        for (const status of statuses) {
          console.log(`   ${status.name}  (${status.id})`)
        }
        console.log()
      } catch (err) {
        console.error(`❌ 获取卡片状态失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("overview")
    .description("查看项目只读概览")
    .argument("<projectId>", "项目 ID")
    .option("--json", "以 JSON 格式输出")
    .action((projectId: string, options: { json?: boolean }) => {
      try {
        const overview = engine.getProjectOverview(projectId)
        if (options.json) {
          console.log(JSON.stringify(overview, null, 2))
          return
        }
        console.log(`\n📊 项目概览：${overview.projectName}\n`)
        console.log(`   需求数: ${overview.requirementCount} · 未排期: ${overview.unscheduledCount} · 未绑 TB: ${overview.unboundTbCount} · 无负责人: ${overview.ownerlessCount}`)
        console.log(`   里程碑: 计划 ${overview.milestonePlanned} / 达成 ${overview.milestoneReached} / 逾期 ${overview.milestoneOverdue}`)
        console.log(`   海因里希: 重大 ${overview.heinrich.major} / 轻微 ${overview.heinrich.minor} / 未遂 ${overview.heinrich.trivial}`)
        console.log(`   节点: 可运行 ${overview.readyNodeCount} / 等待 ${overview.waitingNodeCount}`)
        console.log(`   阶段分布:`)
        for (const item of overview.byPhase) {
          console.log(`     ${item.phase}: ${item.count}`)
        }
      } catch (err) {
        console.error(`❌ 查看项目概览失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  // ── OmniPlan commands ──

  project
    .command("omniplan-export")
    .description("导出项目为 OmniPlan .oplx 文件")
    .argument("<projectId>", "项目 ID")
    .option("--file <name>", "文件名（不含 .oplx 后缀）")
    .option("--yes", "跳过覆盖确认")
    .option("--json", "以 JSON 格式输出")
    .action((projectId: string, options: { file?: string; yes?: boolean; json?: boolean }) => {
      try {
        const result = engine.exportProjectOmniPlan(projectId, {
          ...(options.file !== undefined ? { fileName: options.file } : {}),
        })
        if (options.json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }
        console.log(`✅ 已导出 OmniPlan 文件`)
        console.log(`   路径: ${result.path}`)
        console.log(`   需求数: ${result.taskCount}`)
        console.log(`   文件夹: ${result.folder}`)
      } catch (err) {
        console.error(`❌ 导出 OmniPlan 失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("omniplan-import")
    .description("从 OmniPlan .oplx 文件导入排期")
    .argument("<projectId>", "项目 ID")
    .option("--file <pathOrName>", "文件路径或名称")
    .option("--json", "以 JSON 格式输出")
    .action((projectId: string, options: { file?: string; json?: boolean }) => {
      try {
        const file = options.file
        const isAbsolute = file !== undefined && (file.startsWith("/") || file.startsWith("~"))
        const importOpts: { fileName?: string | undefined; path?: string | undefined } = isAbsolute
          ? { path: file }
          : { fileName: file }
        const result = engine.importProjectOmniPlan(projectId, importOpts)
        if (options.json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }
        console.log(`✅ 已导入 OmniPlan 文件`)
        console.log(`   路径: ${result.path}`)
        console.log(`   更新需求数: ${result.updatedRequirements}`)
        console.log(`   更新节点数: ${result.updatedNodes}`)
        if (result.unmatched.length > 0) {
          console.log(`   未匹配: ${result.unmatched.join(", ")}`)
        }
        if (result.skipped.length > 0) {
          console.log(`   跳过: ${result.skipped.join(", ")}`)
        }
      } catch (err) {
        console.error(`❌ 导入 OmniPlan 失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  project
    .command("omniplan-folder")
    .description("查看或设置项目的 OmniPlan 文件夹")
    .argument("<projectId>", "项目 ID")
    .option("--set <folder>", "设置 OmniPlan 文件夹名")
    .option("--file-name <name>", "设置目标文件名")
    .option("--json", "以 JSON 格式输出")
    .action((projectId: string, options: { set?: string; fileName?: string; json?: boolean }) => {
      try {
        if (options.set === undefined && options.fileName === undefined) {
          // Show current settings
          const project = engine.getProject(projectId)
          if (options.json) {
            console.log(JSON.stringify({
              projectId,
              omniplanFolder: project.metadata?.["omniplanFolder"],
              omniplanFileName: project.metadata?.["omniplanFileName"],
            }, null, 2))
            return
          }
          console.log(`📌 OmniPlan 设置`)
          console.log(`   文件夹: ${project.metadata?.["omniplanFolder"] ?? "（未设置）"}`)
          console.log(`   文件名: ${project.metadata?.["omniplanFileName"] ?? "（未设置）"}`)
          return
        }

        const patch: { omniplanFolder?: string; omniplanFileName?: string } = {}
        if (options.set !== undefined) patch.omniplanFolder = options.set
        if (options.fileName !== undefined) patch.omniplanFileName = options.fileName

        const updated = engine.setProjectOmniPlanMeta(projectId, patch)
        if (options.json) {
          console.log(JSON.stringify({
            projectId,
            omniplanFolder: updated.metadata?.["omniplanFolder"],
            omniplanFileName: updated.metadata?.["omniplanFileName"],
          }, null, 2))
          return
        }
        console.log(`✅ 已更新 OmniPlan 设置`)
        console.log(`   文件夹: ${updated.metadata?.["omniplanFolder"] ?? "（未设置）"}`)
        console.log(`   文件名: ${updated.metadata?.["omniplanFileName"] ?? "（未设置）"}`)
      } catch (err) {
        console.error(`❌ 设置 OmniPlan 失败: ${(err as Error).message}`)
        process.exit(1)
      }
    })
}
