import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigError } from "@octopus/core/errors.js"
import { DEFAULT_CONFIG, getIdentity, loadConfig, saveIdentity } from "./config.js"

const temporaryDirectories: string[] = []
const originalStoreDir = process.env["OCTOPUS_STORE_DIR"]
const originalMe = process.env["OCTOPUS_ME"]
const originalHermesPath = process.env["OCTOPUS_AI_HERMES_PATH"]
const originalTbEnv: Record<string, string | undefined> = {
  OCTOPUS_TB_APP_ID: process.env["OCTOPUS_TB_APP_ID"],
  OCTOPUS_TB_APP_SECRET: process.env["OCTOPUS_TB_APP_SECRET"],
  OCTOPUS_TB_ORG_ID: process.env["OCTOPUS_TB_ORG_ID"],
  OCTOPUS_TB_OPERATOR_ID: process.env["OCTOPUS_TB_OPERATOR_ID"],
  OCTOPUS_TB_GATEWAY: process.env["OCTOPUS_TB_GATEWAY"],
  OCTOPUS_TB_REF_STRATEGY: process.env["OCTOPUS_TB_REF_STRATEGY"],
  OCTOPUS_TB_VERSION_BASE: process.env["OCTOPUS_TB_VERSION_BASE"],
  OCTOPUS_TB_SESSION_COOKIE: process.env["OCTOPUS_TB_SESSION_COOKIE"],
  OCTOPUS_TB_USER_TOKEN: process.env["OCTOPUS_TB_USER_TOKEN"],
  OCTOPUS_TB_VERSION_AUTH: process.env["OCTOPUS_TB_VERSION_AUTH"],
}

afterEach(() => {
  if (originalStoreDir === undefined) delete process.env["OCTOPUS_STORE_DIR"]
  else process.env["OCTOPUS_STORE_DIR"] = originalStoreDir
  if (originalMe === undefined) delete process.env["OCTOPUS_ME"]
  else process.env["OCTOPUS_ME"] = originalMe
  if (originalHermesPath === undefined) delete process.env["OCTOPUS_AI_HERMES_PATH"]
  else process.env["OCTOPUS_AI_HERMES_PATH"] = originalHermesPath
  for (const [key, value] of Object.entries(originalTbEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
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

  it("配置 JSON 损坏时应抛出 ConfigError 且消息含配置文件路径", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), "{ not valid json")

    expect(() => loadConfig(storeDir)).toThrow(ConfigError)
    expect(() => loadConfig(storeDir)).toThrow(/config\.json/)
  })

  it("配置 JSON 顶层不是对象时应抛出 ConfigError", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify([1, 2, 3]))

    expect(() => loadConfig(storeDir)).toThrow(ConfigError)
  })

  it("配置文件不存在时应回退默认值", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)

    expect(loadConfig(storeDir)).toEqual({ ...DEFAULT_CONFIG, storeDir })
  })

  it("合法配置 JSON 应正常合并到默认值", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({
      ai: { defaultModel: "sonnet", retries: 3 },
      workflow: { strictPermissions: true },
    }))

    expect(loadConfig(storeDir)).toMatchObject({
      ai: { defaultModel: "sonnet", retries: 3, defaultTimeout: 120_000 },
      workflow: { strictPermissions: true, aiGatingEnabled: false, heinrichThreshold: 3 },
    })
  })

  it("Hermes CLI 路径可由配置或环境变量覆盖", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-hermes-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({ ai: { hermesPath: "/file/hermes" } }))
    expect(loadConfig(storeDir).ai.hermesPath).toBe("/file/hermes")
    process.env["OCTOPUS_AI_HERMES_PATH"] = "/env/hermes"
    expect(loadConfig(storeDir).ai.hermesPath).toBe("/env/hermes")
  })

  it("未知额外字段不应导致校验失败", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({
      storeDir: ".octo-custom",
      futureField: "ignored",
      ai: { defaultModel: "sonnet", futureAiField: 42 },
      workflow: { strictPermissions: true, futureWorkflowField: "x" },
    }))

    expect(loadConfig(storeDir)).toMatchObject({
      storeDir,
      ai: { defaultModel: "sonnet" },
      workflow: { strictPermissions: true },
    })
  })

  it("类型错误的字段应抛出 ConfigError 且带路径与问题摘要", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({
      ai: { defaultModel: 123 },
    }))

    expect(() => loadConfig(storeDir)).toThrow(ConfigError)
    expect(() => loadConfig(storeDir)).toThrow(/ai\.defaultModel/)
  })

  it("plugins 数组元素类型错误应抛出 ConfigError", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({
      plugins: [{ notAValidPluginRef: true }],
    }))

    expect(() => loadConfig(storeDir)).toThrow(ConfigError)
  })

  it("omniplan.rootDir 从配置文件加载", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    delete process.env["OCTOPUS_OMNIPLAN_ROOT"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({
      omniplan: { rootDir: "/custom/omniplan" },
    }))

    expect(loadConfig(storeDir).omniplan).toEqual({ rootDir: "/custom/omniplan" })
  })

  it("环境变量 OCTOPUS_OMNIPLAN_ROOT 覆盖配置文件", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    process.env["OCTOPUS_OMNIPLAN_ROOT"] = "/env/omniplan"
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({
      omniplan: { rootDir: "/file/omniplan" },
    }))

    expect(loadConfig(storeDir).omniplan).toEqual({ rootDir: "/env/omniplan" })
  })

  it("无配置无环境变量时使用默认 omniplan.rootDir", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    delete process.env["OCTOPUS_OMNIPLAN_ROOT"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)

    expect(loadConfig(storeDir).omniplan).toEqual({ rootDir: "/Users/ben/Documents/OmniPlan" })
  })
})

describe("teambition 配置", () => {
  it("文件 teambition.versionManageBase 能读出", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    delete process.env["OCTOPUS_TB_VERSION_BASE"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({
      teambition: { versionManageBase: "https://vm.example.test" },
    }))

    expect(loadConfig(storeDir).teambition?.versionManageBase).toBe("https://vm.example.test")
  })

  it("文件 app 三件套 + 环境仅 session cookie：三件套仍为文件值且 sessionCookie 有值", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    delete process.env["OCTOPUS_TB_APP_ID"]
    delete process.env["OCTOPUS_TB_APP_SECRET"]
    delete process.env["OCTOPUS_TB_ORG_ID"]
    delete process.env["OCTOPUS_TB_VERSION_BASE"]
    delete process.env["OCTOPUS_TB_USER_TOKEN"]
    delete process.env["OCTOPUS_TB_VERSION_AUTH"]
    process.env["OCTOPUS_TB_SESSION_COOKIE"] = "session=abc"
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({
      teambition: { appId: "file-app", appSecret: "file-secret", orgId: "file-org" },
    }))

    const config = loadConfig(storeDir)
    expect(config.teambition?.appId).toBe("file-app")
    expect(config.teambition?.appSecret).toBe("file-secret")
    expect(config.teambition?.orgId).toBe("file-org")
    expect(config.teambition?.sessionCookie).toBe("session=abc")
  })

  it("环境仅 session cookie、文件无 teambition：appId 为 undefined（不是空串）", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    delete process.env["OCTOPUS_TB_APP_ID"]
    delete process.env["OCTOPUS_TB_APP_SECRET"]
    delete process.env["OCTOPUS_TB_ORG_ID"]
    delete process.env["OCTOPUS_TB_VERSION_BASE"]
    delete process.env["OCTOPUS_TB_USER_TOKEN"]
    delete process.env["OCTOPUS_TB_VERSION_AUTH"]
    process.env["OCTOPUS_TB_SESSION_COOKIE"] = "session=abc"
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)

    const config = loadConfig(storeDir)
    expect(config.teambition?.appId).toBeUndefined()
    expect(config.teambition?.sessionCookie).toBe("session=abc")
  })

  it("环境 OCTOPUS_TB_VERSION_AUTH=nope 被忽略且不抛", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    delete process.env["OCTOPUS_TB_SESSION_COOKIE"]
    process.env["OCTOPUS_TB_VERSION_AUTH"] = "nope"
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)

    expect(() => loadConfig(storeDir)).not.toThrow()
    expect(loadConfig(storeDir).teambition?.versionAuth).toBeUndefined()
  })

  it("文件 versionAuth 非法值抛 ConfigError 且带路径", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({
      teambition: { versionAuth: "nope" },
    }))

    expect(() => loadConfig(storeDir)).toThrow(ConfigError)
    expect(() => loadConfig(storeDir)).toThrow(/teambition\.versionAuth/)
  })

  it("任务三件套与版本字段合并后任务字段不丢", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    delete process.env["OCTOPUS_TB_APP_ID"]
    delete process.env["OCTOPUS_TB_APP_SECRET"]
    delete process.env["OCTOPUS_TB_ORG_ID"]
    delete process.env["OCTOPUS_TB_SESSION_COOKIE"]
    delete process.env["OCTOPUS_TB_USER_TOKEN"]
    process.env["OCTOPUS_TB_VERSION_BASE"] = "https://vm.example.test"
    process.env["OCTOPUS_TB_VERSION_AUTH"] = "auto"
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({
      teambition: {
        appId: "file-app",
        appSecret: "file-secret",
        orgId: "file-org",
        gatewayBase: "https://open.example.test/api",
      },
    }))

    const config = loadConfig(storeDir)
    expect(config.teambition?.appId).toBe("file-app")
    expect(config.teambition?.appSecret).toBe("file-secret")
    expect(config.teambition?.orgId).toBe("file-org")
    expect(config.teambition?.gatewayBase).toBe("https://open.example.test/api")
    expect(config.teambition?.versionManageBase).toBe("https://vm.example.test")
    expect(config.teambition?.versionAuth).toBe("auto")
  })
})

describe("identity 配置", () => {
  it("getIdentity 未设置时返回 undefined", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    delete process.env["OCTOPUS_ME"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)

    expect(getIdentity(storeDir)).toBeUndefined()
  })

  it("配置文件写入 identity 后 getIdentity 返回 name", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    delete process.env["OCTOPUS_ME"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({ identity: { name: "张三" } }))

    expect(getIdentity(storeDir)).toBe("张三")
  })

  it("环境变量 OCTOPUS_ME 覆盖配置文件", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    process.env["OCTOPUS_ME"] = "envUser"
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({ identity: { name: "fileUser" } }))

    expect(getIdentity(storeDir)).toBe("envUser")
  })

  it("saveIdentity 只补丁 identity、保留其它键", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    delete process.env["OCTOPUS_ME"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({
      ai: { defaultModel: "sonnet" },
      workflow: { strictPermissions: true },
    }))

    saveIdentity(storeDir, "李四")

    const parsed = JSON.parse(readFileSync(join(storeDir, "config.json"), "utf-8"))
    expect(parsed.ai).toEqual({ defaultModel: "sonnet" })
    expect(parsed.workflow).toEqual({ strictPermissions: true })
    expect(parsed.identity).toEqual({ name: "李四" })
  })

  it("saveIdentity(null) 删除 identity 键而 ai/workflow 仍在", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    delete process.env["OCTOPUS_ME"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({
      ai: { defaultModel: "sonnet" },
      workflow: { strictPermissions: true },
      identity: { name: "李四" },
    }))

    saveIdentity(storeDir, null)

    const parsed = JSON.parse(readFileSync(join(storeDir, "config.json"), "utf-8"))
    expect(parsed.ai).toEqual({ defaultModel: "sonnet" })
    expect(parsed.workflow).toEqual({ strictPermissions: true })
    expect(parsed.identity).toBeUndefined()
  })

  it("saveIdentity 空字符串视为删除", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    delete process.env["OCTOPUS_ME"]
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({ identity: { name: "李四" } }))

    saveIdentity(storeDir, "")

    const parsed = JSON.parse(readFileSync(join(storeDir, "config.json"), "utf-8"))
    expect(parsed.identity).toBeUndefined()
  })

  it("环境变量 OCTOPUS_ME 为空字符串或未设置时不产生 identity", () => {
    delete process.env["OCTOPUS_STORE_DIR"]
    process.env["OCTOPUS_ME"] = ""
    const storeDir = mkdtempSync(join(tmpdir(), "octopus-config-"))
    temporaryDirectories.push(storeDir)

    expect(getIdentity(storeDir)).toBeUndefined()
  })
})
