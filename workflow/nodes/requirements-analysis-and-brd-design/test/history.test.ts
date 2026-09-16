import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  buildLineDiff,
  detectUnrecordedBrdChange,
  diffBrdVersions,
  formatLineDiff,
  hashBrd,
  readBrdHistory,
  recordBrdSnapshot,
} from "../src/history.js"

let projectRoot: string
let brdPath: string

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "octopus-brd-history-"))
  brdPath = join(projectRoot, "docs/brd.md")
  mkdirSync(dirname(brdPath), { recursive: true })
})

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

describe("hashBrd", () => {
  it("对相同内容返回相同 sha", () => {
    expect(hashBrd("# BRD")).toBe(hashBrd("# BRD"))
    expect(hashBrd("# BRD")).not.toBe(hashBrd("# BRD 2"))
  })
})

describe("recordBrdSnapshot / readBrdHistory", () => {
  it("首次快照记录一条历史，previousSha 为 null", () => {
    const { entry, changed } = recordBrdSnapshot(brdPath, "# BRD v1", {
      source: "generate",
      requirementId: "req_1",
    })
    expect(changed).toBe(true)
    expect(entry.previousSha).toBeNull()
    expect(entry.sha).toBe(hashBrd("# BRD v1"))
    expect(readBrdHistory(brdPath).entries).toHaveLength(1)
  })

  it("相同内容重复快照时去重，不写入新条目", () => {
    recordBrdSnapshot(brdPath, "# BRD v1", { source: "generate", requirementId: "req_1" })
    const second = recordBrdSnapshot(brdPath, "# BRD v1", {
      source: "optimize",
      requirementId: "req_1",
    })
    expect(second.changed).toBe(false)
    expect(readBrdHistory(brdPath).entries).toHaveLength(1)
  })

  it("内容变化时串联 previousSha", () => {
    const first = recordBrdSnapshot(brdPath, "# BRD v1", {
      source: "generate",
      requirementId: "req_1",
    })
    const second = recordBrdSnapshot(brdPath, "# BRD v2", {
      source: "optimize",
      requirementId: "req_1",
    })
    expect(second.entry.previousSha).toBe(first.entry.sha)
    expect(readBrdHistory(brdPath).entries).toHaveLength(2)
  })
})

describe("detectUnrecordedBrdChange", () => {
  it("文件不存在时返回 undefined", () => {
    expect(detectUnrecordedBrdChange(brdPath, "req_1")).toBeUndefined()
  })

  it("账本为空时把当前文件记为 baseline", () => {
    writeFileSync(brdPath, "# 手写的 BRD", "utf8")
    const result = detectUnrecordedBrdChange(brdPath, "req_1")
    expect(result?.entry.source).toBe("baseline")
    expect(result?.changed).toBe(true)
  })

  it("检测到手工修改时记为 manual", () => {
    recordBrdSnapshot(brdPath, "# BRD v1", { source: "generate", requirementId: "req_1" })
    writeFileSync(brdPath, "# BRD v1（手工追加）", "utf8")
    const result = detectUnrecordedBrdChange(brdPath, "req_1")
    expect(result?.entry.source).toBe("manual")
    expect(readBrdHistory(brdPath).entries).toHaveLength(2)
  })

  it("内容与账本一致时不重复记录", () => {
    const { entry } = recordBrdSnapshot(brdPath, "# BRD v1", {
      source: "generate",
      requirementId: "req_1",
    })
    writeFileSync(brdPath, "# BRD v1", "utf8")
    expect(detectUnrecordedBrdChange(brdPath, "req_1")).toBeUndefined()
    expect(readBrdHistory(brdPath).entries).toEqual([entry])
  })
})

describe("buildLineDiff", () => {
  it("统计增删行数", () => {
    const diff = buildLineDiff("a\nb\nc", "a\nc\nd")
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.truncated).toBe(false)
  })

  it("内容相同时无增删", () => {
    const diff = buildLineDiff("a\nb", "a\nb")
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(0)
  })

  it("规模超限时退化为仅统计", () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line-${i}`).join("\n")
    const bigger = Array.from({ length: 3000 }, (_, i) => `line-${i}-x`).join("\n")
    const diff = buildLineDiff(big, bigger)
    expect(diff.truncated).toBe(true)
    expect(diff.lines).toEqual([])
    expect(diff.added).toBeGreaterThan(0)
  })
})

describe("diffBrdVersions", () => {
  it("默认比较上一条到最新一条", () => {
    recordBrdSnapshot(brdPath, "# v1\nline", { source: "generate", requirementId: "req_1" })
    recordBrdSnapshot(brdPath, "# v2\nline", { source: "optimize", requirementId: "req_1" })
    const result = diffBrdVersions(brdPath)
    expect(result.diff.added).toBe(1)
    expect(result.diff.removed).toBe(1)
  })

  it("支持 sha 前缀指定 from/to", () => {
    const first = recordBrdSnapshot(brdPath, "# v1", { source: "generate", requirementId: "req_1" })
    const second = recordBrdSnapshot(brdPath, "# v2", { source: "optimize", requirementId: "req_1" })
    const result = diffBrdVersions(brdPath, first.entry.sha.slice(0, 8), second.entry.sha.slice(0, 8))
    expect(result.from.sha).toBe(first.entry.sha)
    expect(result.to.sha).toBe(second.entry.sha)
  })

  it("账本为空时抛出可诊断错误", () => {
    expect(() => diffBrdVersions(brdPath)).toThrow(/尚无历史快照/)
  })

  it("只有一个版本且未指定 --from 时抛出可诊断错误", () => {
    recordBrdSnapshot(brdPath, "# v1", { source: "generate", requirementId: "req_1" })
    expect(() => diffBrdVersions(brdPath)).toThrow(/未找到起始版本/)
  })

  it("未知 sha 抛出可诊断错误", () => {
    recordBrdSnapshot(brdPath, "# v1", { source: "generate", requirementId: "req_1" })
    recordBrdSnapshot(brdPath, "# v2", { source: "optimize", requirementId: "req_1" })
    expect(() => diffBrdVersions(brdPath, "deadbeef")).toThrow(/未找到匹配的 BRD 快照/)
  })
})

describe("formatLineDiff", () => {
  it("无实际变化时给出占位文本", () => {
    expect(formatLineDiff(buildLineDiff("a", "a"))).toBe("（无实际内容变化）")
  })

  it("有变化时渲染 +/- 前缀行", () => {
    const text = formatLineDiff(buildLineDiff("a\nb", "a\nc"))
    expect(text).toContain("- b")
    expect(text).toContain("+ c")
  })

  it("超限退化时给出统计说明", () => {
    const text = formatLineDiff({ lines: [], added: 3, removed: 2, truncated: true })
    expect(text).toContain("+3")
    expect(text).toContain("-2")
  })
})
