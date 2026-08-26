/**
 * `octopus brd` —— 项目级 BRD 配置、提示词预览、AI 生成与检查。
 *
 * 子命令:
 *   config <projectId> [--json]
 *   config set <projectId> [源/规范/产出选项...]
 *   prompts <projectId> [requirementId] [--mode] [--write] [--json]
 *   prompt-set <projectId> --id <id> --system-file <path> --user-file <path>
 *   generate [requirementId] [--project] [--dry-run] [--json]
 *   check [requirementId] [--project] [--dry-run] [--json]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import type { BrdPromptId, ProjectBrdDesignConfigPatch } from "@octopus/core/brd-design.js"
import { BRD_PROMPT_IDS } from "@octopus/core/brd-design.js"
import { resolveRequirementId } from "../resolve-requirement.js"

async function resolveProjectIdForRequirement(
  engine: WorkflowEngine,
  requirementId: string,
): Promise<string> {
  return (await engine.getState(requirementId)).projectId
}

function parsePromptId(value: string): BrdPromptId {
  if (!BRD_PROMPT_IDS.includes(value as BrdPromptId)) {
    throw new Error(`未知提示词 id: ${value}（可选: ${BRD_PROMPT_IDS.join(", ")}）`)
  }
  return value as BrdPromptId
}

export function buildBrdCommands(program: Command, engine: WorkflowEngine): void {
  const brd = program.command("brd").description("BRD 设计：项目配置、提示词、生成与检查")

  const configCmd = brd.command("config").description("查看或设置项目 BRD 配置")

  configCmd
    .argument("[projectId]", "项目 ID（查看时必填；set 子命令见下）")
    .option("--json", "以 JSON 格式输出")
    .action(async (projectId: string | undefined, options: { json?: boolean }) => {
      try {
        if (!projectId) {
          throw new Error("请提供 projectId，或使用 `octopus brd config set <projectId> ...`")
        }
        const config = await engine.getProjectBrdDesignConfig(projectId)
        if (options.json) {
          console.log(JSON.stringify(config, null, 2))
          return
        }
        console.log(`\n📋 BRD 设计配置（项目 ${projectId}）\n`)
        console.log("源:")
        const s = config.sources
        console.log(`   小程序代码: ${s.miniprogramCodePath ?? "（未配置）"}`)
        console.log(`   官网代码:   ${s.websiteCodePath ?? "（未配置）"}`)
        console.log(`   前端代码:   ${s.frontendCodePath ?? "（未配置）"}`)
        console.log(`   后端代码:   ${s.backendCodePath ?? "（未配置）"}`)
        console.log(`   小程序产物: ${s.miniprogramBuildArtifact ?? "（未配置）"}`)
        console.log(`   官网域名:   ${s.websiteUrl ?? "（未配置）"}`)
        console.log(`规范: ${config.brdSpecPath ?? "（内置默认）"}`)
        console.log(`产出: ${config.brdOutputPath ?? "（默认节点目录 brd.md）"}`)
        const promptIds = config.prompts ? Object.keys(config.prompts) : []
        console.log(
          `提示词覆盖: ${promptIds.length > 0 ? promptIds.join(", ") : "（无，使用内置默认）"}`,
        )
        console.log()
      } catch (err) {
        console.error(`❌ 读取 BRD 配置失败: ${(err as Error).message}`)
        process.exitCode = 1
      }
    })

  configCmd
    .command("set")
    .description("设置项目 BRD 源/规范/产出（空字符串清除）")
    .argument("<projectId>", "项目 ID")
    .option("--miniprogram <path>", "小程序代码路径")
    .option("--website-code <path>", "官网代码路径")
    .option("--frontend <path>", "前端代码路径")
    .option("--backend <path>", "后端代码路径")
    .option("--miniprogram-artifact <path>", "小程序编译产物路径")
    .option("--website-url <url>", "官网展示域名")
    .option("--spec <path>", "BRD 规范文件路径")
    .option("--output <path>", "BRD 产出路径")
    .option("--json", "以 JSON 格式输出")
    .action(
      async (
        projectId: string,
        options: {
          miniprogram?: string
          websiteCode?: string
          frontend?: string
          backend?: string
          miniprogramArtifact?: string
          websiteUrl?: string
          spec?: string
          output?: string
          json?: boolean
        },
      ) => {
        try {
          const sources: NonNullable<ProjectBrdDesignConfigPatch["sources"]> = {}
          const patch: ProjectBrdDesignConfigPatch = { sources }
          if (options.miniprogram !== undefined) sources.miniprogramCodePath = options.miniprogram
          if (options.websiteCode !== undefined) sources.websiteCodePath = options.websiteCode
          if (options.frontend !== undefined) sources.frontendCodePath = options.frontend
          if (options.backend !== undefined) sources.backendCodePath = options.backend
          if (options.miniprogramArtifact !== undefined) {
            sources.miniprogramBuildArtifact = options.miniprogramArtifact
          }
          if (options.websiteUrl !== undefined) sources.websiteUrl = options.websiteUrl
          if (options.spec !== undefined) patch.brdSpecPath = options.spec
          if (options.output !== undefined) patch.brdOutputPath = options.output

          const hasSourcePatch = Object.keys(patch.sources ?? {}).length > 0
          if (!hasSourcePatch && options.spec === undefined && options.output === undefined) {
            throw new Error("请至少提供一个配置选项")
          }
          if (!hasSourcePatch) delete patch.sources

          await engine.setProjectBrdDesignConfig(projectId, patch)
          const config = await engine.getProjectBrdDesignConfig(projectId)
          if (options.json) {
            console.log(JSON.stringify(config, null, 2))
            return
          }
          console.log(`✅ 已更新项目 BRD 配置: ${projectId}`)
        } catch (err) {
          console.error(`❌ 设置 BRD 配置失败: ${(err as Error).message}`)
          process.exitCode = 1
        }
      },
    )

  brd
    .command("prompts")
    .description("预览已渲染的 BRD 提示词（不调用 AI）")
    .argument("<projectId>", "项目 ID")
    .argument("[requirementId]", "需求 ID")
    .option("--mode <mode>", "generate | check | all", "all")
    .option("--include-summarize", "包含 summarize-sources")
    .option("--write", "写入节点目录 prompts/")
    .option("--json", "以 JSON 格式输出")
    .action(
      async (
        projectId: string,
        requirementId: string | undefined,
        options: { mode?: string; includeSummarize?: boolean; write?: boolean; json?: boolean },
      ) => {
        try {
          const rid = await resolveRequirementId(engine, requirementId)
          if (!rid) return
          const mode = (options.mode ?? "all") as "generate" | "check" | "all"
          if (!["generate", "check", "all"].includes(mode)) {
            throw new Error("--mode 必须是 generate、check 或 all")
          }
          const preview = await engine.previewBrdPrompts(projectId, rid, {
            mode,
            ...(options.includeSummarize === true ? { includeSummarize: true } : {}),
          })
          if (options.write) {
            const state = await engine.getState(rid)
            const dir = join(
              state.projectRoot ?? ".",
              "workflow/nodes/requirements-analysis-and-brd-design/prompts",
            )
            mkdirSync(dir, { recursive: true })
            for (const item of preview.prompts) {
              writeFileSync(join(dir, `${item.id}.system.md`), item.system, "utf8")
              writeFileSync(join(dir, `${item.id}.user.md`), item.prompt, "utf8")
            }
            console.log(`✅ 已写入提示词到 ${dir}`)
          }
          if (options.json) {
            console.log(JSON.stringify(preview, null, 2))
            return
          }
          for (const warning of preview.warnings) {
            console.log(`⚠️  ${warning}`)
          }
          console.log(`产出路径: ${preview.outputPath}\n`)
          for (const item of preview.prompts) {
            console.log(`── ${item.id} ──`)
            console.log(`[system]\n${item.system}\n`)
            console.log(`[user]\n${item.prompt}\n`)
          }
        } catch (err) {
          console.error(`❌ 预览提示词失败: ${(err as Error).message}`)
          process.exitCode = 1
        }
      },
    )

  brd
    .command("prompt-set")
    .description("用文件覆盖项目级提示词模板")
    .argument("<projectId>", "项目 ID")
    .requiredOption("--id <id>", `提示词 id（${BRD_PROMPT_IDS.join(" | ")}）`)
    .requiredOption("--system-file <path>", "system 模板文件")
    .requiredOption("--user-file <path>", "user 模板文件")
    .option("--json", "以 JSON 格式输出")
    .action(
      async (
        projectId: string,
        options: { id: string; systemFile: string; userFile: string; json?: boolean },
      ) => {
        try {
          const id = parsePromptId(options.id)
          const system = readFileSync(options.systemFile, "utf8")
          const user = readFileSync(options.userFile, "utf8")
          await engine.setProjectBrdDesignConfig(projectId, {
            prompts: { [id]: { system, user } },
          })
          const config = await engine.getProjectBrdDesignConfig(projectId)
          if (options.json) {
            console.log(JSON.stringify(config.prompts?.[id], null, 2))
            return
          }
          console.log(`✅ 已覆盖提示词 ${id}`)
        } catch (err) {
          console.error(`❌ 设置提示词失败: ${(err as Error).message}`)
          process.exitCode = 1
        }
      },
    )

  brd
    .command("generate")
    .description("AI 生成 BRD")
    .argument("[requirementId]", "需求 ID")
    .option("--project <projectId>", "项目 ID（默认从需求反查）")
    .option("--dry-run", "只渲染提示词，不调用 AI")
    .option("--json", "以 JSON 格式输出")
    .action(
      async (
        requirementId: string | undefined,
        options: { project?: string; dryRun?: boolean; json?: boolean },
      ) => {
        try {
          const rid = await resolveRequirementId(engine, requirementId)
          if (!rid) return
          const projectId = options.project ?? (await resolveProjectIdForRequirement(engine, rid))
          const result = await engine.generateBrd(
            projectId,
            rid,
            options.dryRun === true ? { dryRun: true } : undefined,
          )
          if (options.json) {
            console.log(JSON.stringify(result, null, 2))
            return
          }
          for (const warning of result.warnings) console.log(`⚠️  ${warning}`)
          if (result.dryRun) {
            console.log("🧪 dry-run：未调用 AI")
            for (const item of result.promptsUsed) {
              console.log(`── ${item.id} ──\n${item.prompt.slice(0, 500)}\n`)
            }
            return
          }
          console.log(`✅ BRD 已生成: ${result.outputPath}`)
        } catch (err) {
          console.error(`❌ 生成 BRD 失败: ${(err as Error).message}`)
          process.exitCode = 1
        }
      },
    )

  brd
    .command("check")
    .description("AI 检查 BRD 完善性")
    .argument("[requirementId]", "需求 ID")
    .option("--project <projectId>", "项目 ID（默认从需求反查）")
    .option("--dry-run", "只渲染提示词，不调用 AI")
    .option("--json", "以 JSON 格式输出")
    .action(
      async (
        requirementId: string | undefined,
        options: { project?: string; dryRun?: boolean; json?: boolean },
      ) => {
        try {
          const rid = await resolveRequirementId(engine, requirementId)
          if (!rid) return
          const projectId = options.project ?? (await resolveProjectIdForRequirement(engine, rid))
          const result = await engine.checkBrd(
            projectId,
            rid,
            options.dryRun === true ? { dryRun: true } : undefined,
          )
          if (options.json) {
            console.log(JSON.stringify(result, null, 2))
            return
          }
          for (const warning of result.warnings) console.log(`⚠️  ${warning}`)
          if (result.dryRun) {
            console.log("🧪 dry-run：未调用 AI")
            return
          }
          console.log(`✅ BRD 检查报告: ${result.reportPath}`)
        } catch (err) {
          console.error(`❌ 检查 BRD 失败: ${(err as Error).message}`)
          process.exitCode = 1
        }
      },
    )
}
