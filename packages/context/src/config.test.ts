import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "./config.js"

const temporaryDirectories: string[] = []
const originalStoreDir = process.env["OCTOPUS_STORE_DIR"]

afterEach(() => {
  if (originalStoreDir === undefined) delete process.env["OCTOPUS_STORE_DIR"]
  else process.env["OCTOPUS_STORE_DIR"] = originalStoreDir
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("loadConfig", () => {
  it("显式状态目录应成为未覆盖时的实际存储目录", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)

    expect(loadConfig(storeDir).storeDir).toBe(storeDir)
  })

  it("显式状态目录应覆盖配置文件中的旧存储路径", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({ storeDir: ".octo-old" }))

    expect(loadConfig(storeDir).storeDir).toBe(storeDir)
  })

  it("环境变量应继续覆盖显式状态目录", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    const envStoreDir = mkdtempSync(join(tmpdir(), "octopus-config-env-"))
    temporaryDirectories.push(storeDir, envStoreDir)
    process.env["OCTOPUS_STORE_DIR"] = envStoreDir

    expect(loadConfig(storeDir).storeDir).toBe(envStoreDir)
  })

  it("显式状态目录只覆盖 storeDir，仍读取该目录中的其他配置", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({
      storeDir: ".octo-old",
      workflow: { strictPermissions: true },
      ai: { defaultModel: "sonnet" },
    }))

    expect(loadConfig(storeDir)).toMatchObject({
      storeDir,
      workflow: { strictPermissions: true },
      ai: { defaultModel: "sonnet" },
    })
  })
})
