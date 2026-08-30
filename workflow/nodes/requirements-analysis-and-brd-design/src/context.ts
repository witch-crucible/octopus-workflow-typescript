/**
 * requirements-analysis-and-brd-design 节点的上下文采集与提示词渲染。
 *
 * 仅有界读取本地源，不抓取远程页面。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path"
import {
  DEFAULT_BRD_SPEC,
  hasBrdSourcesConfigured,
  renderBrdPrompt,
  resolveBrdOutputPath,
  resolveBrdPrompts,
  type BrdPromptId,
  type BrdPromptVars,
  type ProjectBrdDesignConfig,
} from "@octopus/core/brd-design.js"

const PER_SOURCE_CHAR_LIMIT = 10_000
const GLOBAL_CHAR_LIMIT = 50_000
const HISTORICAL_BRD_CHAR_LIMIT = 60_000
const PER_HISTORICAL_BRD_CHAR_LIMIT = 12_000
const MAX_HISTORICAL_BRD_FILES = 20
const MAX_DEPTH = 2
const MAX_ENTRIES_PER_DIR = 40
const HIGH_SIGNAL_NAMES = new Set([
  "readme",
  "readme.md",
  "readme.markdown",
  "package.json",
  "app.json",
  "project.config.json",
  "sitemap.json",
  "routes.ts",
  "routes.js",
  "index.ts",
  "index.js",
  "index.tsx",
  "main.ts",
  "main.js",
  "app.ts",
  "app.js",
  "app.tsx",
])
const HISTORICAL_BRD_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".adoc"])

export interface BrdSourceSnippet {
  label: string
  path: string
  missing: boolean
  summary: string
}

export interface BrdGatheredContext {
  vars: BrdPromptVars
  sources: BrdSourceSnippet[]
  warnings: string[]
  outputPath: string
  absoluteOutputPath: string
  brdSpec: string
  existingBrd: string
  historicalBrds: string
}

export interface BrdRenderedPrompt {
  id: BrdPromptId
  system: string
  prompt: string
}

function resolvePath(projectRoot: string, pathValue: string): string {
  return isAbsolute(pathValue) ? pathValue : resolve(projectRoot, pathValue)
}

function listTopEntries(dir: string, depth: number): string[] {
  if (depth > MAX_DEPTH || !existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return [`(无法读取目录 ${dir})`]
  }
  const lines: string[] = []
  const sorted = entries.sort((a, b) => a.localeCompare(b)).slice(0, MAX_ENTRIES_PER_DIR)
  for (const name of sorted) {
    if (name === ".git" || name === "node_modules" || name === "dist" || name === ".octo") continue
    const full = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    lines.push(isDir ? `${name}/` : name)
    if (isDir && depth < MAX_DEPTH) {
      const nested = listTopEntries(full, depth + 1)
      for (const line of nested.slice(0, 12)) {
        lines.push(`  ${line}`)
      }
    }
  }
  if (entries.length > MAX_ENTRIES_PER_DIR) {
    lines.push(`…（另有 ${entries.length - MAX_ENTRIES_PER_DIR} 项未列出）`)
  }
  return lines
}

function readHighSignalFiles(root: string): string[] {
  const chunks: string[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(root)
  } catch {
    return chunks
  }
  for (const name of entries) {
    if (!HIGH_SIGNAL_NAMES.has(name.toLowerCase())) continue
    const full = join(root, name)
    try {
      if (!statSync(full).isFile()) continue
      const content = readFileSync(full, "utf8")
      const clipped = content.length > 4_000 ? `${content.slice(0, 4_000)}\n…(截断)` : content
      chunks.push(`### ${name}\n${clipped}`)
    } catch {
      // skip unreadable
    }
  }
  return chunks
}

function summarizeCodePath(label: string, projectRoot: string, pathValue: string): BrdSourceSnippet {
  const absolute = resolvePath(projectRoot, pathValue)
  if (!existsSync(absolute)) {
    return {
      label,
      path: pathValue,
      missing: true,
      summary: `路径不存在: ${pathValue}`,
    }
  }
  let summary: string
  try {
    const stat = statSync(absolute)
    if (stat.isFile()) {
      const content = readFileSync(absolute, "utf8")
      const clipped = content.length > PER_SOURCE_CHAR_LIMIT
        ? `${content.slice(0, PER_SOURCE_CHAR_LIMIT)}\n…(截断)`
        : content
      summary = `文件 ${basename(absolute)}\n${clipped}`
    } else {
      const tree = listTopEntries(absolute, 0).join("\n")
      const signals = readHighSignalFiles(absolute).join("\n\n")
      summary = [`目录树（有界）:\n${tree}`, signals ? `高信号文件:\n${signals}` : ""]
        .filter(Boolean)
        .join("\n\n")
      if (summary.length > PER_SOURCE_CHAR_LIMIT) {
        summary = `${summary.slice(0, PER_SOURCE_CHAR_LIMIT)}\n…(截断)`
      }
    }
  } catch (error) {
    summary = `读取失败: ${(error as Error).message}`
  }
  return { label, path: pathValue, missing: false, summary }
}

function summarizeArtifactPath(label: string, projectRoot: string, pathValue: string): BrdSourceSnippet {
  const absolute = resolvePath(projectRoot, pathValue)
  if (!existsSync(absolute)) {
    return {
      label,
      path: pathValue,
      missing: true,
      summary: `产物路径不存在: ${pathValue}`,
    }
  }
  try {
    const stat = statSync(absolute)
    if (stat.isDirectory()) {
      const names = readdirSync(absolute).slice(0, 30).join(", ")
      return {
        label,
        path: pathValue,
        missing: false,
        summary: `产物目录条目（不含二进制内容）: ${names || "(空)"}`,
      }
    }
    return {
      label,
      path: pathValue,
      missing: false,
      summary: `产物文件: ${basename(absolute)}（大小 ${stat.size} 字节，不读取二进制内容）`,
    }
  } catch (error) {
    return {
      label,
      path: pathValue,
      missing: false,
      summary: `产物读取失败: ${(error as Error).message}`,
    }
  }
}

function readTextFile(pathValue: string | undefined, projectRoot: string): string | undefined {
  if (!pathValue || pathValue.trim() === "") return undefined
  const absolute = resolvePath(projectRoot, pathValue)
  if (!existsSync(absolute)) return undefined
  try {
    return readFileSync(absolute, "utf8")
  } catch {
    return undefined
  }
}

function listHistoricalBrdFiles(pathValue: string, projectRoot: string): string[] {
  const absolute = resolvePath(projectRoot, pathValue)
  if (!existsSync(absolute)) return []
  try {
    if (statSync(absolute).isFile()) return [absolute]
  } catch {
    return []
  }

  const files: string[] = []
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH || files.length > MAX_HISTORICAL_BRD_FILES) return
    let entries: string[]
    try {
      entries = readdirSync(directory).sort((a, b) => a.localeCompare(b))
    } catch {
      return
    }
    for (const name of entries) {
      if (files.length > MAX_HISTORICAL_BRD_FILES) return
      if (name === ".git" || name === "node_modules" || name === "dist" || name === ".octo") continue
      const full = join(directory, name)
      try {
        if (statSync(full).isDirectory()) visit(full, depth + 1)
        else if (HISTORICAL_BRD_EXTENSIONS.has(extname(name).toLowerCase())) files.push(full)
      } catch {
        // skip unreadable
      }
    }
  }
  visit(absolute, 0)
  return files
}

function gatherHistoricalBrds(
  paths: readonly string[] | undefined,
  projectRoot: string,
  absoluteOutputPath: string,
  warnings: string[],
): string {
  if (!paths || paths.length === 0) return "（未配置历史 BRD）"

  const files: string[] = []
  for (const pathValue of paths) {
    const absolute = resolvePath(projectRoot, pathValue)
    if (!existsSync(absolute)) {
      warnings.push(`历史 BRD 路径不存在: ${pathValue}`)
      continue
    }
    try {
      if (statSync(absolute).isFile() && !HISTORICAL_BRD_EXTENSIONS.has(extname(absolute).toLowerCase())) {
        warnings.push(`历史 BRD 暂不支持该文件格式（仅支持 md/markdown/txt/adoc）: ${pathValue}`)
        continue
      }
    } catch {
      warnings.push(`历史 BRD 路径不可读: ${pathValue}`)
      continue
    }
    files.push(...listHistoricalBrdFiles(pathValue, projectRoot))
  }

  const uniqueFiles = [...new Set(files)]
    .filter((file) => resolve(file) !== resolve(absoluteOutputPath))
    .slice(0, MAX_HISTORICAL_BRD_FILES)
  if (files.length > MAX_HISTORICAL_BRD_FILES) {
    warnings.push(`历史 BRD 超过 ${MAX_HISTORICAL_BRD_FILES} 个文件，仅采集前 ${MAX_HISTORICAL_BRD_FILES} 个`)
  }
  if (uniqueFiles.length === 0) {
    warnings.push("未采集到可读的历史 BRD 文本")
    return "（未采集到可读的历史 BRD）"
  }

  const chunks: string[] = []
  let total = 0
  for (const file of uniqueFiles) {
    try {
      const content = readFileSync(file, "utf8")
      const clipped = content.length > PER_HISTORICAL_BRD_CHAR_LIMIT
        ? `${content.slice(0, PER_HISTORICAL_BRD_CHAR_LIMIT)}\n…(截断)`
        : content
      const projectRelative = relative(projectRoot, file)
      const label = projectRelative.startsWith("..") || isAbsolute(projectRelative)
        ? file
        : projectRelative
      const chunk = `## 历史 BRD: ${label}\n${clipped}`
      const remaining = HISTORICAL_BRD_CHAR_LIMIT - total
      if (remaining <= 0) break
      chunks.push(chunk.length > remaining ? `${chunk.slice(0, remaining)}\n…(全局截断)` : chunk)
      total += Math.min(chunk.length, remaining)
    } catch {
      warnings.push(`历史 BRD 文件不可读: ${file}`)
    }
  }
  if (total >= HISTORICAL_BRD_CHAR_LIMIT) warnings.push("历史 BRD 内容超过全局上限，已截断")
  return chunks.join("\n\n") || "（未采集到可读的历史 BRD）"
}

/** 采集项目 BRD 上下文 */
export function gatherBrdSourceContext(
  config: ProjectBrdDesignConfig,
  projectRoot: string,
  requirement: { name: string; description: string },
): BrdGatheredContext {
  const warnings: string[] = []
  const sources: BrdSourceSnippet[] = []
  const s = config.sources

  if (!hasBrdSourcesConfigured(config)) {
    warnings.push("未配置代码/展示源；将仅基于需求描述与规范生成或检查")
  }

  const codeEntries: Array<[string, string | undefined]> = [
    ["小程序代码", s.miniprogramCodePath],
    ["官网代码", s.websiteCodePath],
    ["前端代码", s.frontendCodePath],
    ["后端代码", s.backendCodePath],
  ]
  for (const [label, pathValue] of codeEntries) {
    if (!pathValue) continue
    const snippet = summarizeCodePath(label, projectRoot, pathValue)
    sources.push(snippet)
    if (snippet.missing) warnings.push(`${label}路径不存在: ${pathValue}`)
  }

  if (s.miniprogramBuildArtifact) {
    const snippet = summarizeArtifactPath("小程序编译产物", projectRoot, s.miniprogramBuildArtifact)
    sources.push(snippet)
    if (snippet.missing) warnings.push(`小程序产物路径不存在: ${s.miniprogramBuildArtifact}`)
  }

  if (s.websiteUrl) {
    sources.push({
      label: "官网展示域名",
      path: s.websiteUrl,
      missing: false,
      summary: `URL（未抓取页面内容）: ${s.websiteUrl}`,
    })
  }

  let sourcesSummary = sources
    .map((item) => `## ${item.label} (${item.path})\n${item.summary}`)
    .join("\n\n")
  if (sourcesSummary.length > GLOBAL_CHAR_LIMIT) {
    sourcesSummary = `${sourcesSummary.slice(0, GLOBAL_CHAR_LIMIT)}\n…(全局截断)`
    warnings.push("源摘要超过全局上限，已截断")
  }
  if (!sourcesSummary) sourcesSummary = "（无源摘要）"

  const brdSpecFromFile = readTextFile(config.brdSpecPath, projectRoot)
  if (config.brdSpecPath && !brdSpecFromFile) {
    warnings.push(`BRD 规范文件不可读，使用内置默认规范: ${config.brdSpecPath}`)
  }
  const brdSpec = brdSpecFromFile ?? DEFAULT_BRD_SPEC

  const outputPath = resolveBrdOutputPath(config)
  const absoluteOutputPath = resolvePath(projectRoot, outputPath)
  const existingBrd = readTextFile(outputPath, projectRoot) ?? ""
  const historicalBrds = gatherHistoricalBrds(
    s.historicalBrdPaths,
    projectRoot,
    absoluteOutputPath,
    warnings,
  )

  const vars: BrdPromptVars = {
    requirementName: requirement.name,
    requirementDescription: requirement.description || "（无描述）",
    brdSpec,
    sourcesSummary,
    existingBrd: existingBrd || "（尚无 BRD）",
    websiteUrl: s.websiteUrl ?? "（未配置）",
    miniprogramBuildArtifact: s.miniprogramBuildArtifact ?? "（未配置）",
    historicalBrds,
  }

  return {
    vars,
    sources,
    warnings,
    outputPath,
    absoluteOutputPath,
    brdSpec,
    existingBrd,
    historicalBrds,
  }
}

/** 渲染提示词列表（不调用 AI） */
export function renderBrdPromptsForContext(
  config: ProjectBrdDesignConfig,
  context: BrdGatheredContext,
  mode: "generate" | "check" | "all" = "all",
  options?: { includeSummarize?: boolean },
): BrdRenderedPrompt[] {
  const prompts = resolveBrdPrompts(config)
  const ids: BrdPromptId[] = []
  if (options?.includeSummarize) ids.push("summarize-sources")
  if (mode === "generate" || mode === "all") ids.push("generate")
  if (mode === "check" || mode === "all") ids.push("check")
  return ids.map((id) => {
    const rendered = renderBrdPrompt(prompts[id], context.vars)
    return { id, ...rendered }
  })
}

/** 将渲染结果编码为 AI 模块 envelope */
export function encodeBrdPromptEnvelope(system: string, prompt: string): string {
  return JSON.stringify({ system, prompt })
}

/** 检查报告默认路径（与 BRD 同目录） */
export function resolveBrdCheckReportPath(absoluteBrdPath: string): string {
  const dir = absoluteBrdPath.includes("/") || absoluteBrdPath.includes("\\")
    ? absoluteBrdPath.replace(/[/\\][^/\\]+$/, "")
    : "."
  return join(dir, "brd-check-report.md")
}

/** 相对项目根的展示路径 */
export function toProjectRelative(projectRoot: string, absolutePath: string): string {
  const rel = relative(projectRoot, absolutePath)
  return rel.startsWith("..") ? absolutePath : rel
}
