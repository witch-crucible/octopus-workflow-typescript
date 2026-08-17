import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { AIAssistantType } from "@octopus/core/agent.js"
import { aiAssistantModuleRegistry, executeAIAssistantModule } from "@octopus/agent-layer/modules/registry.js"
import { loadPlugins } from "./load.js"

const temporaryDirectories: string[] = []
const fixturePlugin = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/sample-plugin/index.js")

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("loadPlugins", () => {
  it("空引用返回空宿主", async () => {
    const host = await loadPlugins([], { projectRoot: process.cwd() })
    expect(host.plugins).toEqual([])
    expect(host.overlays).toEqual([])
    expect(host.integrations).toEqual({})
  })

  it("enabled: false 跳过插件", async () => {
    const host = await loadPlugins(
      [{ path: fixturePlugin, enabled: false }],
      { projectRoot: process.cwd() },
    )
    expect(host.plugins).toEqual([])
  })

  it("路径不存在时失败", async () => {
    await expect(loadPlugins(["./missing-plugin.js"], { projectRoot: process.cwd() }))
      .rejects.toThrow(/插件路径不存在/)
  })

  it("缺少导出时失败", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octopus-plugin-"))
    temporaryDirectories.push(directory)
    const path = join(directory, "empty.js")
    writeFileSync(path, "export const foo = 1\n")
    await expect(loadPlugins([path], { projectRoot: directory }))
      .rejects.toThrow(/缺少 default 或 octopusPlugin/)
  })

  it("加载 fixture：叠加节点、注册集成与自定义能力", async () => {
    const host = await loadPlugins([{ path: fixturePlugin }], { projectRoot: process.cwd() })
    expect(host.plugins).toEqual([{ id: "sample", version: "1.0.0" }])
    expect(host.overlays[0]?.add?.[0]?.key).toBe("sample-extra-check")
    expect(host.integrations["sample"]?.name).toBe("sample")
    expect(host.customHandlers.has("sample.ping")).toBe(true)
  })

  it("插件可注册新的 AI 模块，但不能覆盖内置模块", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octopus-plugin-"))
    temporaryDirectories.push(directory)
    const type = `PLUGIN_TEST_${Date.now()}`
    const path = join(directory, "ai.js")
    writeFileSync(path, `
      export const octopusPlugin = {
        id: "ai-sample",
        version: "0.0.1",
        activate(ctx) {
          ctx.registerAIModule({
            type: ${JSON.stringify(type)},
            name: "Plugin Test",
            execute: (input, client) => client.ask({ prompt: input, system: "plugin" }),
          })
        },
      }
    `)
    await loadPlugins([path], { projectRoot: directory })
    expect(aiAssistantModuleRegistry.has(type)).toBe(true)
    const response = await executeAIAssistantModule(type, "hello", {
      ask: async (request) => ({ result: request.system ?? "" }),
    })
    expect(response.result).toBe("plugin")

    const override = join(directory, "override.js")
    writeFileSync(override, `
      export const octopusPlugin = {
        id: "override",
        version: "0.0.1",
        activate(ctx) {
          ctx.registerAIModule({
            type: ${JSON.stringify(AIAssistantType.CODE_REVIEW)},
            name: "Nope",
            execute: (input, client) => client.ask({ prompt: input }),
          })
        },
      }
    `)
    await expect(loadPlugins([override], { projectRoot: directory }))
      .rejects.toThrow(/不能覆盖已注册 AI 模块/)
  })

  it("拒绝覆盖 ai / heinrich 能力", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octopus-plugin-"))
    temporaryDirectories.push(directory)
    const path = join(directory, "bad.js")
    writeFileSync(path, `
      export const octopusPlugin = {
        id: "bad",
        version: "0.0.1",
        activate(ctx) { ctx.registerCapability("ai", async () => ({ kind: "ai", ref: "", ok: true })) },
      }
    `)
    chmodSync(path, 0o644)
    await expect(loadPlugins([path], { projectRoot: directory })).rejects.toThrow(/禁止覆盖内置能力/)
  })
})
