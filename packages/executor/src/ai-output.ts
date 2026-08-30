/**
 * AI 节点文件输出处理。
 *
 * 输出路径始终相对于节点工作目录；扩展模式会把现有文档加入输入，要求 AI
 * 返回合并后的完整文档，再以一次写入替换目标文件。
 */

import { randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import type { NodeAction } from "@octopus/core/execution.js"
import type { CrossCodeReviewResponse } from "@octopus/agent-layer/index.js"

type AIAction = Extract<NodeAction, { type: "ai" }>

export interface PreparedAIOutput {
  readonly input: string
  readonly outputPath?: string
  readonly extended: boolean
}

/** 将相对路径解析到节点工作目录内，拒绝目录逃逸。 */
export function resolveAIOutputPath(nodePath: string, targetPath: string): string {
  const nodeRoot = resolve(nodePath)
  const outputPath = resolve(nodeRoot, targetPath)
  const relativePath = relative(nodeRoot, outputPath)
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`AI 输出文件必须位于节点工作目录内: ${targetPath}`)
  }
  if (existsSync(nodeRoot)) {
    const realNodeRoot = realpathSync(nodeRoot)
    let existingPath = existsSync(outputPath) ? outputPath : dirname(outputPath)
    while (!existsSync(existingPath) && existingPath !== nodeRoot) {
      const parent = dirname(existingPath)
      if (parent === existingPath) break
      existingPath = parent
    }
    if (existsSync(existingPath)) {
      const realExistingPath = realpathSync(existingPath)
      const realRelativePath = relative(realNodeRoot, realExistingPath)
      if (realRelativePath.startsWith("..") || isAbsolute(realRelativePath)) {
        throw new Error(`AI 输出文件必须位于节点工作目录内: ${targetPath}`)
      }
    }
  }
  return outputPath
}

/** 解析 AI 输出位置，并在扩展模式下注入已有文档。 */
export function prepareAIOutput(action: AIAction, nodePath: string, fallbackInput = ""): PreparedAIOutput {
  const input = action.input ?? fallbackInput
  if (!action.outputFile) return { input, extended: false }

  const outputPath = resolveAIOutputPath(nodePath, action.outputFile)

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
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, content, "utf8")
    renameSync(temporaryPath, outputPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

export interface CrossReviewReportOptions {
  readonly outputFile?: string
  readonly reviewOutputDir?: string
  /** 隔离不同 requirement 的报告；会被规范化为单一路径段。 */
  readonly scope?: string
}

export interface WrittenCrossReviewReports {
  readonly reviewOutputDir: string
  readonly aggregateOutputFile?: string
}

/** 原子写入各 reviewer 原始结果、隔离后的汇总，以及可选的 latest 汇总。 */
export function writeCrossReviewReports(
  nodePath: string,
  response: CrossCodeReviewResponse,
  options: CrossReviewReportOptions = {},
): WrittenCrossReviewReports {
  const baseOutputDir = options.reviewOutputDir ?? "reviews"
  const normalizedScope = options.scope?.replace(/[^a-zA-Z0-9._-]/g, "_")
  const reviewOutputDir = normalizedScope ? `${baseOutputDir}/${normalizedScope}` : baseOutputDir

  for (const review of response.reviews) {
    const outputPath = resolveAIOutputPath(nodePath, `${reviewOutputDir}/${review.agent}.md`)
    const partial = review.output.trim() === "" ? "" : `\n\n## Partial output\n\n${review.output}`
    const content = review.ok
      ? review.output
      : `# ${review.agent} review failed\n\n${review.error ?? "未知错误"}${partial}`
    writeAIOutput(outputPath, content)
  }

  const aggregateName = basename(options.outputFile ?? "cross-review.md")
  const scopedAggregatePath = resolveAIOutputPath(nodePath, `${reviewOutputDir}/${aggregateName}`)
  writeAIOutput(scopedAggregatePath, response.result)
  if (options.outputFile) {
    writeAIOutput(resolveAIOutputPath(nodePath, options.outputFile), response.result)
  }

  return {
    reviewOutputDir,
    ...(options.outputFile !== undefined ? { aggregateOutputFile: options.outputFile } : {}),
  }
}
