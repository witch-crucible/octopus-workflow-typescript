import { describe, it, expect } from "vitest"
import { Role, ROLE_LABELS, ROLE_COLORS, ALL_ROLES, isValidRole } from "./role.js"

describe("Role", () => {
  it("const 对象包含8种角色", () => {
    expect(Object.values(Role)).toHaveLength(8)
    expect(Role.PM).toBe("PM")
    expect(Role.BA).toBe("BA")
    expect(Role.SA).toBe("SA")
    expect(Role.AI).toBe("AI")
    expect(Role.DEV).toBe("DEV")
    expect(Role.QA).toBe("QA")
    expect(Role.OP).toBe("OP")
    expect(Role.HEI).toBe("HEI")
  })
})

describe("ROLE_LABELS", () => {
  it("所有角色都有中文标签", () => {
    for (const role of Object.values(Role)) {
      expect(ROLE_LABELS[role]).toBeTypeOf("string")
    }
  })
  it("标签内容正确", () => {
    expect(ROLE_LABELS[Role.PM]).toBe("产品经理")
    expect(ROLE_LABELS[Role.AI]).toBe("AI 助手")
    expect(ROLE_LABELS[Role.DEV]).toBe("开发")
    expect(ROLE_LABELS[Role.HEI]).toBe("海因里希审计")
  })
})

describe("ROLE_COLORS", () => {
  it("所有角色都有颜色值", () => {
    for (const role of Object.values(Role)) {
      expect(ROLE_COLORS[role]).toBeTypeOf("string")
    }
  })
})

describe("ALL_ROLES", () => {
  it("包含所有角色", () => {
    expect(ALL_ROLES).toEqual(Object.values(Role))
  })
})

describe("isValidRole", () => {
  it("返回 true 对于有效角色", () => {
    expect(isValidRole("PM")).toBe(true)
    expect(isValidRole("DEV")).toBe(true)
    expect(isValidRole("AI")).toBe(true)
    expect(isValidRole("HEI")).toBe(true)
  })
  it("返回 false 对于无效角色", () => {
    expect(isValidRole("UNKNOWN")).toBe(false)
    expect(isValidRole("")).toBe(false)
  })
})
