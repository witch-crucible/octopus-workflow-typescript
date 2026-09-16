/**
 * BRD 快照账本 —— 按内容寻址存储历史版本，检测未记录的手工修改，
 * 并提供版本间行级 diff。仅节点内部使用，约定与 brd.md 同目录下的
 * `history/` 子目录绑定。
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const SHA_PREFIX_LENGTH = 12
const HISTORY_FILE_NAME = "brd-history.json"
const DIFF_LINE_PRODUCT_LIMIT = 4_000_000

export type BrdHistorySource = "generate" | "optimize" | "manual" | "baseline"

export interface BrdHistoryEntry {
  sha: string
  previousSha: string | null
  source: BrdHistorySource
  requirementId: string
  createdAt: string
  snapshotPath: string
}

interface BrdHistoryFile {
  version: 1
  entries: BrdHistoryEntry[]
}

function historyDir(absoluteBrdPath: string): string {
  return join(dirname(absoluteBrdPath), "history")
}

function historyFilePath(absoluteBrdPath: string): string {
  return join(historyDir(absoluteBrdPath), HISTORY_FILE_NAME)
}

function snapshotFilePath(absoluteBrdPath: string, sha: string): string {
  return join(historyDir(absoluteBrdPath), `brd-${sha.slice(0, SHA_PREFIX_LENGTH)}.md`)
}

/** 计算 BRD 文本内容的 sha256（十六进制） */
export function hashBrd(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

/** 读取快照账本；不存在时返回空账本 */
export function readBrdHistory(absoluteBrdPath: string): BrdHistoryFile {
  const filePath = historyFilePath(absoluteBrdPath)
  if (!existsSync(filePath)) return { version: 1, entries: [] }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as BrdHistoryFile
    if (!parsed || !Array.isArray(parsed.entries)) return { version: 1, entries: [] }
    return { version: 1, entries: parsed.entries }
  } catch {
    return { version: 1, entries: [] }
  }
}

function writeBrdHistory(absoluteBrdPath: string, history: BrdHistoryFile): void {
  mkdirSync(historyDir(absoluteBrdPath), { recursive: true })
  writeFileSync(historyFilePath(absoluteBrdPath), JSON.stringify(history, null, 2), "utf8")
}

function latestEntry(history: BrdHistoryFile): BrdHistoryEntry | undefined {
  return history.entries[history.entries.length - 1]
}

/**
 * 记录一次快照。内容与账本最新一条相同时不写入，返回 changed:false。
 * 调用方在写入 brd.md **之后** 调用，snapshotPath 存的是写入后的内容。
 */
export function recordBrdSnapshot(
  absoluteBrdPath: string,
  content: string,
  options: { source: BrdHistorySource; requirementId: string },
): { entry: BrdHistoryEntry; changed: boolean } {
  const history = readBrdHistory(absoluteBrdPath)
  const sha = hashBrd(content)
  const previous = latestEntry(history)
  if (previous && previous.sha === sha) {
    return { entry: previous, changed: false }
  }
  const entry: BrdHistoryEntry = {
    sha,
    previousSha: previous?.sha ?? null,
    source: options.source,
    requirementId: options.requirementId,
    createdAt: new Date().toISOString(),
    snapshotPath: snapshotFilePath(absoluteBrdPath, sha),
  }
  mkdirSync(historyDir(absoluteBrdPath), { recursive: true })
  writeFileSync(entry.snapshotPath, content, "utf8")
  history.entries.push(entry)
  writeBrdHistory(absoluteBrdPath, history)
  return { entry, changed: true }
}

/**
 * 检测当前 brd.md 内容是否与账本最新记录不一致（手工修改）。
 * 一致或文件不存在时返回 undefined；不一致时记一条快照并返回该条目
 * （账本为空时来源记为 baseline，否则记为 manual）。
 */
export function detectUnrecordedBrdChange(
  absoluteBrdPath: string,
  requirementId: string,
): { entry: BrdHistoryEntry; changed: boolean } | undefined {
  if (!existsSync(absoluteBrdPath)) return undefined
  const content = readFileSync(absoluteBrdPath, "utf8")
  const history = readBrdHistory(absoluteBrdPath)
  const previous = latestEntry(history)
  const sha = hashBrd(content)
  if (previous && previous.sha === sha) return undefined
  const source: BrdHistorySource = previous ? "manual" : "baseline"
  return recordBrdSnapshot(absoluteBrdPath, content, { source, requirementId })
}

function resolveShaPrefix(history: BrdHistoryFile, shaPrefix: string): BrdHistoryEntry {
  const matches = history.entries.filter((entry) => entry.sha.startsWith(shaPrefix))
  const [match, ...rest] = matches
  if (!match) throw new Error(`未找到匹配的 BRD 快照: ${shaPrefix}`)
  if (rest.length > 0) throw new Error(`BRD 快照 sha 前缀不唯一: ${shaPrefix}`)
  return match
}

function readSnapshotContent(entry: BrdHistoryEntry): string {
  if (!existsSync(entry.snapshotPath)) {
    throw new Error(`BRD 快照文件缺失: ${entry.snapshotPath}`)
  }
  return readFileSync(entry.snapshotPath, "utf8")
}

export interface BrdDiffLine {
  type: "context" | "add" | "remove"
  text: string
}

export interface BrdLineDiff {
  lines: BrdDiffLine[]
  added: number
  removed: number
  truncated: boolean
}

/** 基于 LCS 的 unified 行级 diff；超出规模上限时退化为仅统计。 */
export function buildLineDiff(a: string, b: string): BrdLineDiff {
  const linesA = a.split("\n")
  const linesB = b.split("\n")
  if (linesA.length * linesB.length > DIFF_LINE_PRODUCT_LIMIT) {
    const setA = new Set(linesA)
    const setB = new Set(linesB)
    const added = linesB.filter((line) => !setA.has(line)).length
    const removed = linesA.filter((line) => !setB.has(line)).length
    return { lines: [], added, removed, truncated: true }
  }

  const n = linesA.length
  const m = linesB.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  const lcsAt = (row: number, col: number): number => lcs[row]?.[col] ?? 0
  const lineAt = (source: string[], index: number): string => source[index] ?? ""
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i]
      if (!row) continue
      row[j] =
        linesA[i] === linesB[j] ? lcsAt(i + 1, j + 1) + 1 : Math.max(lcsAt(i + 1, j), lcsAt(i, j + 1))
    }
  }

  const lines: BrdDiffLine[] = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (linesA[i] === linesB[j]) {
      lines.push({ type: "context", text: lineAt(linesA, i) })
      i++
      j++
    } else if (lcsAt(i + 1, j) >= lcsAt(i, j + 1)) {
      lines.push({ type: "remove", text: lineAt(linesA, i) })
      removed++
      i++
    } else {
      lines.push({ type: "add", text: lineAt(linesB, j) })
      added++
      j++
    }
  }
  while (i < n) {
    lines.push({ type: "remove", text: lineAt(linesA, i) })
    removed++
    i++
  }
  while (j < m) {
    lines.push({ type: "add", text: lineAt(linesB, j) })
    added++
    j++
  }
  return { lines, added, removed, truncated: false }
}

const DIFF_TEXT_CHAR_LIMIT = 20_000

/** 将行级 diff 渲染为 unified 风格文本；超过字符上限时截断并附加提示。 */
export function formatLineDiff(diff: BrdLineDiff): string {
  if (diff.truncated) {
    return `（BRD 内容过大，跳过逐行 diff；变更统计：+${diff.added} / -${diff.removed} 行）`
  }
  if (diff.lines.every((line) => line.type === "context")) {
    return "（无实际内容变化）"
  }
  const rendered = diff.lines
    .map((line) => `${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "} ${line.text}`)
    .join("\n")
  if (rendered.length > DIFF_TEXT_CHAR_LIMIT) {
    return `${rendered.slice(0, DIFF_TEXT_CHAR_LIMIT)}\n…(diff 超过 ${DIFF_TEXT_CHAR_LIMIT} 字符，已截断；变更统计：+${diff.added} / -${diff.removed} 行)`
  }
  return rendered
}

export interface BrdVersionDiff {
  from: BrdHistoryEntry
  to: BrdHistoryEntry
  diff: BrdLineDiff
}

/**
 * 比较两个版本；缺省比较「上一条 → 最新一条」。
 * fromSha/toSha 支持 sha 前缀。
 */
export function diffBrdVersions(
  absoluteBrdPath: string,
  fromSha?: string,
  toSha?: string,
): BrdVersionDiff {
  const history = readBrdHistory(absoluteBrdPath)
  const latest = latestEntry(history)
  if (!latest) {
    throw new Error("BRD 尚无历史快照，无法比较")
  }
  const to = toSha ? resolveShaPrefix(history, toSha) : latest
  const from = fromSha
    ? resolveShaPrefix(history, fromSha)
    : (history.entries.find((entry) => entry.sha === to.previousSha) ?? undefined)
  if (!from) {
    throw new Error("未找到起始版本（该版本为首个快照，且未指定 --from）")
  }
  const diff = buildLineDiff(readSnapshotContent(from), readSnapshotContent(to))
  return { from, to, diff }
}
