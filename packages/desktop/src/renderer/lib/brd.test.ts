import { describe, expect, it } from "vitest"
import { collectBrdPromptPatch } from "./brd.js"

describe("collectBrdPromptPatch", () => {
  it("collects multi-type drafts and clears selected ids", () => {
    const result = collectBrdPromptPatch(
      {
        generate: { system: "sys-g", user: "user-g" },
        check: { system: "sys-c", user: "user-c" },
        "summarize-sources": { system: "sys-s", user: "user-s" },
      },
      ["check"],
    )
    expect(result.invalid).toBeUndefined()
    expect(result.prompts).toEqual({
      generate: { system: "sys-g", user: "user-g" },
      check: null,
      "summarize-sources": { system: "sys-s", user: "user-s" },
    })
  })

  it("returns invalid when only one side is filled", () => {
    const result = collectBrdPromptPatch(
      {
        generate: { system: "only-system", user: "  " },
      },
      [],
    )
    expect(result.invalid).toEqual({ id: "generate", hasSystem: true, hasUser: false })
    expect(result.prompts).toEqual({})
  })

  it("skips missing drafts without clearing", () => {
    const result = collectBrdPromptPatch(
      {
        generate: { system: "a", user: "b" },
      },
      [],
    )
    expect(result).toEqual({
      prompts: {
        generate: { system: "a", user: "b" },
      },
    })
  })
})
