/**
 * 解析需求 ID：显式传入优先；省略时仅在状态库恰好有一个需求时自动选用。
 */

import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

export async function resolveRequirementId(
  engine: WorkflowEngine,
  requirementId?: string,
): Promise<string | null> {
  if (requirementId) return requirementId
  const requirements = await engine.listRequirements()
  if (requirements.length === 0) {
    console.error(
      "⚠️  没有找到需求。使用 `octopus requirement init <name> --project <projectId>` 创建。",
    )
    process.exit(1)
    return null
  }
  if (requirements.length > 1) {
    console.error("⚠️  存在多个需求，请指定需求 ID。")
    process.exit(1)
    return null
  }
  return requirements[0] ?? null
}
