import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  escapeXml,
  parseOmniPlanActual,
  buildOmniPlanActual,
  buildTocXml,
  packOplx,
  unpackOplx,
  dateToOmniPlanIso,
  omniPlanIsoToDate,
  slugifyProjectName,
  validateOmniPlanName,
  stableTaskId,
  resolveOmniPlanFolder,
  resolveOmniPlanFileName,
} from "./omniplan.js"

const fixturesDir = join(import.meta.dirname ?? ".", "..", "fixtures", "omniplan")

describe("escapeXml", () => {
  it("应转义 XML 特殊字符", () => {
    expect(escapeXml("&")).toBe("&amp;")
    expect(escapeXml("<")).toBe("&lt;")
    expect(escapeXml(">")).toBe("&gt;")
    expect(escapeXml('"')).toBe("&quot;")
    expect(escapeXml("'")).toBe("&apos;")
    expect(escapeXml("foo & bar < baz")).toBe("foo &amp; bar &lt; baz")
  })

  it("正常字符串不变", () => {
    expect(escapeXml("hello")).toBe("hello")
    expect(escapeXml("测试项目")).toBe("测试项目")
  })
})

describe("日期转换", () => {
  it("dateToOmniPlanIso 应转换为 T02:00:00.000Z", () => {
    expect(dateToOmniPlanIso("2024-05-29")).toBe("2024-05-29T02:00:00.000Z")
  })

  it("omniPlanIsoToDate 应提取 YYYY-MM-DD", () => {
    expect(omniPlanIsoToDate("2024-05-29T02:00:00.000Z")).toBe("2024-05-29")
    expect(omniPlanIsoToDate("2024-06-03T02:00:00.000Z")).toBe("2024-06-03")
  })

  it("日期往返应一致", () => {
    const original = "2024-05-29"
    const iso = dateToOmniPlanIso(original)
    const roundTrip = omniPlanIsoToDate(iso)
    expect(roundTrip).toBe(original)
  })
})

describe("slugifyProjectName", () => {
  it("应生成小写连字符分隔的 slug", () => {
    expect(slugifyProjectName("LC PRC")).toBe("lc-prc")
    expect(slugifyProjectName("My Project Name")).toBe("my-project-name")
  })

  it("应移除音调符号", () => {
    expect(slugifyProjectName("Café")).toBe("cafe")
    expect(slugifyProjectName("über")).toBe("uber"
    )
  })

  it("纯中文应返回空字符串", () => {
    expect(slugifyProjectName("商城改版")).toBe("")
  })

  it("混合中英文应只保留英文数字", () => {
    expect(slugifyProjectName("项目Alpha")).toBe("alpha")
  })
})

describe("validateOmniPlanName", () => {
  it("合法名称应通过", () => {
    expect(() => validateOmniPlanName("cdc-dior", "folder")).not.toThrow()
    expect(() => validateOmniPlanName("PRC.oplx", "file")).not.toThrow()
    expect(() => validateOmniPlanName("my_file.v2", "file")).not.toThrow()
  })

  it("非法名称应抛错", () => {
    expect(() => validateOmniPlanName("../etc/passwd", "folder")).toThrow("无效")
    expect(() => validateOmniPlanName("foo/bar", "folder")).toThrow("无效")
    expect(() => validateOmniPlanName("foo bar", "folder")).toThrow("无效")
  })
})

describe("stableTaskId", () => {
  it("相同输入应产生相同 ID", () => {
    const id1 = stableTaskId("requirement:req_1")
    const id2 = stableTaskId("requirement:req_1")
    expect(id1).toBe(id2)
  })

  it("不同输入应产生不同 ID", () => {
    const id1 = stableTaskId("requirement:req_1")
    const id2 = stableTaskId("requirement:req_2")
    expect(id1).not.toBe(id2)
  })

  it("ID 格式应以 t 开头", () => {
    expect(stableTaskId("test")).toMatch(/^t/)
  })
})

describe("parseOmniPlanActual", () => {
  it("应解析 MiniTemplate 夹具", () => {
    const xml = readFileSync(join(fixturesDir, "mini-actual.xml"), "utf-8")
    const doc = parseOmniPlanActual(xml)

    expect(doc.scenarioId).toBe("pP142EqPm9V")
    expect(doc.startDate).toBe("2024-05-29T02:00:00.000Z")
    expect(doc.granularity).toBe("days")

    // Should find 6 tasks: t-1 (root), t197 (project), t198, t220, t221
    expect(doc.tasks.length).toBeGreaterThanOrEqual(5)

    const t198 = doc.tasks.find((t) => t.id === "t198")
    expect(t198).toBeDefined()
    expect(t198!.title).toBe("Requirements realization")
    expect(t198!.effort).toBe(57600)
    expect(t198!.lockedStartDate).toBe("2024-05-29T02:00:00.000Z")

    const t220 = doc.tasks.find((t) => t.id === "t220")
    expect(t220).toBeDefined()
    expect(t220!.title).toBe("Test")
    expect(t220!.prerequisiteIds).toEqual(["t198"])

    const t221 = doc.tasks.find((t) => t.id === "t221")
    expect(t221).toBeDefined()
    expect(t221!.title).toBe("Publish")
    expect(t221!.prerequisiteIds).toEqual(["t220"])
  })
})

describe("unpackOplx / packOplx", () => {
  it("应能解开并重新打包 MiniTemplate", () => {
    const xml = readFileSync(join(fixturesDir, "mini-actual.xml"), "utf-8")
    const tocXml = buildTocXml("pP142EqPm9V")
    const packed = packOplx(xml, tocXml)

    expect(packed).toBeInstanceOf(Buffer)
    expect(packed.length).toBeGreaterThan(100)

    const unpacked = unpackOplx(packed)
    expect(unpacked.actualXml).toBe(xml)
    expect(unpacked.tocXml).toContain("pP142EqPm9V")
  })

  it("应保留额外文件", () => {
    const xml = readFileSync(join(fixturesDir, "mini-actual.xml"), "utf-8")
    const tocXml = buildTocXml("test-id")
    const extra = new Map([["Preview.png", Buffer.from("fake-png")]])
    const packed = packOplx(xml, tocXml, extra)

    const unpacked = unpackOplx(packed)
    expect(unpacked.entries.get("Preview.png")?.toString()).toBe("fake-png")
  })
})

describe("buildOmniPlanActual", () => {
  it("应生成包含所有需求和节点的 XML", () => {
    const xml = buildOmniPlanActual({
      projectName: "Test Project",
      scenarioId: "op-test123",
      startDate: "2024-01-01",
      requirements: [
        {
          id: "req_1",
          name: "Requirement 1",
          plannedStart: "2024-01-15",
          plannedEnd: "2024-01-20",
          nodes: [
            {
              id: "node_a",
              name: "Node A",
              nodeId: "node_a",
              requirementId: "req_1",
              plannedStart: "2024-01-15",
              plannedEnd: "2024-01-17",
            },
            {
              id: "node_b",
              name: "Node B",
              nodeId: "node_b",
              requirementId: "req_1",
              plannedStart: "2024-01-18",
              plannedEnd: "2024-01-20",
              dependsOn: ["node_a"],
            },
          ],
        },
      ],
      idMap: {},
    })

    expect(xml).toContain('id="op-test123"')
    expect(xml).toContain("2024-01-01T02:00:00.000Z")
    expect(xml).toContain("Requirement 1")
    expect(xml).toContain("Node A")
    expect(xml).toContain("Node B")
    expect(xml).toContain("octopus:requirement:req_1")
    expect(xml).toContain("octopus:node:req_1:node_a")
    expect(xml).toContain("prerequisite-task")
  })

  it("未排期节点应有默认 effort", () => {
    const xml = buildOmniPlanActual({
      projectName: "Test",
      scenarioId: "op-test",
      requirements: [
        {
          id: "req_1",
          name: "Req",
          nodes: [
            {
              id: "n1",
              name: "Node 1",
              nodeId: "n1",
              requirementId: "req_1",
            },
          ],
        },
      ],
      idMap: {},
    })

    expect(xml).toContain("<effort>28800</effort>")
    expect(xml).not.toContain("<locked-start-date>")
  })

  it("生成的 XML 应回解析成功且不含 </reccalculate>", () => {
    const xml = buildOmniPlanActual({
      projectName: "RoundTrip",
      scenarioId: "op-rt",
      requirements: [
        {
          id: "r1",
          name: "Req",
          nodes: [
            { id: "n1", name: "N1", nodeId: "n1", requirementId: "r1" },
            { id: "n2", name: "N2", nodeId: "n2", requirementId: "r1", dependsOn: ["n1"] },
          ],
        },
      ],
      idMap: {},
    })

    expect(xml).not.toContain("</reccalculate>")
    expect(xml).toContain("<recalculate>duration</recalculate>")

    const doc = parseOmniPlanActual(xml)
    expect(doc.scenarioId).toBe("op-rt")
    expect(doc.tasks.length).toBeGreaterThanOrEqual(4)
  })

  it("应导出里程碑叶子含 note/type/effort=0/locked-start-date", () => {
    const xml = buildOmniPlanActual({
      projectName: "Ms Project",
      scenarioId: "op-ms",
      requirements: [
        {
          id: "req_1",
          name: "Requirement 1",
          nodes: [
            { id: "n1", name: "Node 1", nodeId: "n1", requirementId: "req_1" },
          ],
          milestones: [
            { id: "ms_a", name: "评审", date: "2024-03-15" },
          ],
        },
      ],
      idMap: {},
    })

    expect(xml).toContain("octopus:milestone:req_1:ms_a")
    expect(xml).toContain("<type>milestone</type>")
    expect(xml).toContain("<effort>0</effort>")
    expect(xml).toContain("2024-03-15T02:00:00.000Z")
    expect(xml).toContain("<title>评审</title>")

    const doc = parseOmniPlanActual(xml)
    const msTask = doc.tasks.find((t) => t.note === "octopus:milestone:req_1:ms_a")
    expect(msTask).toBeDefined()
    expect(msTask!.type).toBe("milestone")
    expect(msTask!.effort).toBe(0)
    expect(msTask!.lockedStartDate).toBe("2024-03-15T02:00:00.000Z")
  })
})

describe("buildTocXml", () => {
  it("应包含 editing-scenario", () => {
    const toc = buildTocXml("my-scenario-id")
    expect(toc).toContain("<editing-scenario>my-scenario-id</editing-scenario>")
    expect(toc).toContain('id="my-scenario-id"')
  })
})

describe("resolveOmniPlanFolder", () => {
  it("已有 metadata 应直接使用", () => {
    const result = resolveOmniPlanFolder("Some Project", "proj_1", { omniplanFolder: "cdc-dior" })
    expect(result).toBe("cdc-dior")
  })

  it("应生成 slug", () => {
    const result = resolveOmniPlanFolder("LC PRC", "proj_1")
    expect(result).toBe("lc-prc")
  })

  it("纯中文应使用 project-{id}", () => {
    const result = resolveOmniPlanFolder("商城改版", "proj_a1b2c3d4")
    expect(result).toBe("project-a1b2c3d4")
  })
})

describe("resolveOmniPlanFileName", () => {
  it("应优先使用 options.fileName", () => {
    const result = resolveOmniPlanFileName("Project", undefined, "custom")
    expect(result).toBe("custom.oplx")
  })

  it("应使用 metadata.omniplanFileName", () => {
    const result = resolveOmniPlanFileName("Project", { omniplanFileName: "PRC.oplx" })
    expect(result).toBe("PRC.oplx")
  })

  it("应从项目名生成", () => {
    const result = resolveOmniPlanFileName("My Project")
    expect(result).toBe("My-Project.oplx")
  })

  it("多文件未指定应抛错", () => {
    expect(() => resolveOmniPlanFileName("Project", undefined, undefined, ["a.oplx", "b.oplx"]))
      .toThrow("多个 .oplx 文件")
  })

  it("单文件应覆盖", () => {
    const result = resolveOmniPlanFileName("Project", undefined, undefined, ["PRC.oplx"])
    expect(result).toBe("PRC.oplx")
  })
})
