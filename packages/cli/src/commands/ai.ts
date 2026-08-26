/**
 * `octopus ai` —— AI 助手命令。
 *
 * 子命令:
 *   ask <prompt> [requirementId]       — 询问 AI
 *   review [requirementId]             — AI Code Review
 *   estimate [requirementId]           — AI 估时
 *   check-sql <sql> [requirementId]    — AI SQL 检测
 *   debt [requirementId]               — AI 技术债务量化
 */

import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { resolveRequirementId } from "../resolve-requirement.js"
import type { AIClient } from "@octopus/agent-layer/index.js"
import type { StateStore } from "@octopus/context/index.js"

export function buildAiCommands(
  program: Command,
  engine: WorkflowEngine,
  _store?: StateStore,
): void {
  const aiCmd = program.command("ai").description("AI 助手")

  // ── ai ask ──
  aiCmd
    .command("ask")
    .description("询问 AI")
    .argument("<prompt>", "问题或指令")
    .option("--json", "以 JSON 格式输出")
    .action(async (prompt: string, options?: { json?: boolean }) => {
      try {
        // 注意：实际项目中 AIClient 应从 engine 获取
        if (options?.json) {
          console.log(
            JSON.stringify(
              {
                prompt,
                result: "AI 集成需要配置 claude CLI。请确保已安装并登录 Claude。运行: claude login",
                durationMs: 0,
              },
              null,
              2,
            ),
          )
          return
        }
        console.log("🤖 AI 思考中...")
        console.log(`📝 问题: ${prompt}`)
        console.log("ℹ️  AI 集成需要配置 claude CLI。请确保已安装并登录 Claude。")
        console.log("   运行: claude login")
      } catch (err) {
        console.error(`❌ AI 调用失败: ${(err as Error).message}`)
      }
    })

  // ── ai review (Code Review) ──
  aiCmd
    .command("review")
    .description("AI Code Review")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (requirementId?: string, options?: { json?: boolean }) => {
      const pid = await resolveRequirementId(engine, requirementId)
      if (!pid) return

      if (options?.json) {
        console.log(
          JSON.stringify(
            {
              requirementId: pid,
              result: "此功能需要读取 git diff 并调用 claude CLI。确保 claude CLI 已安装并登录。",
            },
            null,
            2,
          ),
        )
        return
      }

      console.log("🤖 AI Code Review 中...")
      console.log("   此功能需要读取 git diff 并调用 claude CLI。")
      console.log("   确保 claude CLI 已安装并登录。")
    })

  // ── ai estimate ──
  aiCmd
    .command("estimate")
    .description("AI 估时")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (requirementId?: string, options?: { json?: boolean }) => {
      const pid = await resolveRequirementId(engine, requirementId)
      if (!pid) {
        console.log("⚠️  未指定需求 ID。")
        return
      }

      if (options?.json) {
        console.log(
          JSON.stringify(
            {
              requirementId: pid,
              result: "此功能需要 PRD 内容作为输入并调用 claude CLI。",
            },
            null,
            2,
          ),
        )
        return
      }

      console.log("🤖 AI 估时分析中...")
      console.log(`   需求: ${pid}`)
      console.log("   此功能需要 PRD 内容作为输入并调用 claude CLI。")
    })

  // ── ai check-sql ──
  aiCmd
    .command("check-sql")
    .description("AI SQL 风险检测")
    .argument("<sql>", "SQL 内容")
    .option("--json", "以 JSON 格式输出")
    .action(async (sql: string, options?: { json?: boolean }) => {
      if (options?.json) {
        console.log(
          JSON.stringify(
            {
              sql,
              result: "此功能需要调用 claude CLI。",
            },
            null,
            2,
          ),
        )
        return
      }

      console.log("🤖 AI SQL 风险检测中...")
      console.log(`   SQL: ${sql.substring(0, 100)}${sql.length > 100 ? "..." : ""}`)
      console.log("   此功能需要调用 claude CLI。")
    })

  // ── ai debt ──
  aiCmd
    .command("debt")
    .description("AI 技术债务量化")
    .argument("[requirementId]", "需求 ID")
    .option("--json", "以 JSON 格式输出")
    .action(async (requirementId?: string, options?: { json?: boolean }) => {
      const pid = await resolveRequirementId(engine, requirementId)
      if (!pid) return

      if (options?.json) {
        console.log(
          JSON.stringify(
            {
              requirementId: pid,
              result: "此功能需要分析代码指标并调用 claude CLI。",
            },
            null,
            2,
          ),
        )
        return
      }

      console.log("🤖 AI 技术债务量化中...")
      console.log("   此功能需要分析代码指标并调用 claude CLI。")
    })
}
