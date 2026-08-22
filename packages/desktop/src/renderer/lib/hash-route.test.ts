import { describe, expect, it } from "vitest"
import {
  canonicalizeHash,
  projectHash,
  requirementHash,
  routeFromHash,
} from "./hash-route.js"

describe("routeFromHash", () => {
  it("parses hub and mine", () => {
    expect(routeFromHash("")).toEqual({ view: "hub" })
    expect(routeFromHash("#")).toEqual({ view: "hub" })
    expect(routeFromHash("#hub")).toEqual({ view: "hub" })
    expect(routeFromHash("hub/mine")).toEqual({ view: "mine" })
  })

  it("parses project tabs and canonicalizes list→table", () => {
    expect(routeFromHash("#project/p1")).toEqual({
      view: "project",
      projectId: "p1",
      projectTab: "board",
    })
    expect(routeFromHash("project/p1/table")).toEqual({
      view: "project",
      projectId: "p1",
      projectTab: "table",
    })
    expect(routeFromHash("project/p%2Fenc/list")).toEqual({
      view: "project",
      projectId: "p/enc",
      projectTab: "table",
    })
    expect(routeFromHash("project/abc/gantt")).toEqual({
      view: "project",
      projectId: "abc",
      projectTab: "gantt",
    })
  })

  it("parses workspace requirement routes", () => {
    expect(routeFromHash("#requirement/req%20a")).toEqual({
      view: "workspace",
      requirementId: "req a",
    })
  })

  it("falls back to hub for unknown hashes", () => {
    expect(routeFromHash("weird")).toEqual({ view: "hub" })
  })
})

describe("canonicalizeHash / hash builders", () => {
  it("rewrites list to table and leaves others alone", () => {
    expect(canonicalizeHash("#project/p1/list")).toBe("project/p1/table")
    expect(canonicalizeHash("project/p%2Fx/list")).toBe("project/p%2Fx/table")
    expect(canonicalizeHash("project/p1/table")).toBeNull()
    expect(canonicalizeHash("hub")).toBeNull()
  })

  it("builds project and requirement hashes", () => {
    expect(projectHash("a/b")).toBe("project/a%2Fb")
    expect(projectHash("a", "board")).toBe("project/a")
    expect(projectHash("a", "gantt")).toBe("project/a/gantt")
    expect(requirementHash("r 1")).toBe("requirement/r%201")
  })
})
