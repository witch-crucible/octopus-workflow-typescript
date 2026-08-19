/**
 * `octopus mine` —— 我的工作：按本机身份列出我负责的需求与指派给我的节点。
 *   mine [--me <name>] [--project <id>] [--json]
 */
import type { Command } from "commander"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { getIdentity } from "@octopus/context/config.js"

export function buildMineCommands(program: Command, engine: WorkflowEngine, storeDir: string): void {
  const mine = program.command("mine").description("列出我的工作（我负责的需求 + 指派给我的节点）")
  mine
    .option("--me <name>", "本机身份姓名（缺省用 OCTOPUS_ME / config）")
    .option("--project <projectId>", "只查指定项目")
    .option("--json", "以 JSON 格式输出")
    .action((options: { me?: string; project?: string; json?: boolean }) => {
      try {
        const identity = options.me ?? getIdentity(storeDir) ?? ""
        if (identity.trim() === "") {
          console.log("尚未设置身份。使用 `octopus mine --me <name>`，或设置 OCTOPUS_ME，或在 config.json 的 identity.name 填写。")
          return
        }
        const list = engine.listMyWork(identity, options.project)
        if (options.json) {
          console.log(JSON.stringify(list, null, 2))
          return
        }
        console.log(`\n🧑 我的工作（${identity}）\n`)
        console.log(`指派给我的节点（${list.nodes.length}）`)
        for (const item of list.nodes) {
          const flag = item.overdue ? "  ⚠逾期" : ""
          console.log(`   ${item.requirementName} / ${item.nodeName}  [${item.status ?? ""}]${flag}`)
        }
        console.log(`\n我负责的需求（${list.requirements.length}）`)
        for (const item of list.requirements) {
          const flag = item.overdue ? "  ⚠逾期" : ""
          console.log(`   ${item.requirementName}  (${item.phase})${flag}`)
        }
        if (list.nodes.length === 0 && list.requirements.length === 0) {
          console.log(`没有指派给「${identity}」的节点或需求。`)
        }
      } catch (err) {
        console.error(`❌ 我的工作查询失败: ${(err as Error).message}`)
        process.exitCode = 1
      }
    })
}
