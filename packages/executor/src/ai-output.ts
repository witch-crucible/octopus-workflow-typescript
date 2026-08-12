/**
 * AI 节点文件输出处理。
 *
 * 输出路径始终相对于节点工作目录；扩展模式会把现有文档加入输入，要求 AI
 * 返回合并后的完整文档，再以一次写入替换目标文件。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { NodeAction } from "@octopus/core/execution.js"

type AIAction = Extract<NodeAction, { type: "ai" }>

export interface PreparedAIOutput {
  readonly input: string
  readonly outputPath?: string
  readonly extended: boolean
}

/** 解析 AI 输出位置，并在扩展模式下注入已有文档。 */
export function prepareAIOutput(action: AIAction, nodePath: string, fallbackInput = ""): PreparedAIOutput {
  const input = action.input ?? fallbackInput
  if (!action.outputFile) return { input, extended: false }

  const nodeRoot = resolve(nodePath)
  const outputPath = resolve(nodeRoot, action.outputFile)
  const relativePath = relative(nodeRoot, outputPath)
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`AI 输出文件必须位于节点工作目录内: ${action.outputFile}`)
  }

  const shouldExtend = action.ifExists === "extend" && existsSync(outputPath)
  if (!shouldExtend) return { input, outputPath, extended: false }

  const existing = readFileSync(outputPath, "utf8")
  return {
    input: [
      input,
      "",
      `目标文档 ${action.outputFile} 已存在。请保留仍然有效的内容，扩展需要新增或更新的部分，并只返回合并后的完整文档。`,
      "",
      "现有文档：",
      existing,
    ].join("\n"),
    outputPath,
    extended: true,
  }
}

/** 将 AI 返回的完整文档写入目标文件。 */
export function writeAIOutput(outputPath: string, content: string): void {
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, content, "utf8")
}
