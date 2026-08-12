import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it, expect } from "vitest"
import { createAIClient, AIClient, getAIAssistantModule } from "./index.js"
import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIRequest, AIResponse } from "@octopus/core/agent.js"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** 记录 ask 请求的假客户端（替换 ask，不调用 Claude CLI） */
function fakeClient(): { client: AIClient; requests: AIRequest[] } {
  const requests: AIRequest[] = []
  const client = createAIClient()
  client.ask = async (request: AIRequest): Promise<AIResponse> => {
    requests.push(request)
    return { result: "ok" }
  }
  return { client, requests }
}

/** 直接执行模块得到的请求 —— 作为便捷方法委托结果的参照 */
async function moduleRequest(type: AIAssistantType, input: string): Promise<AIRequest> {
  let captured: AIRequest | undefined
  const probe = {
    ask: async (request: AIRequest): Promise<AIResponse> => {
      captured = request
      return { result: "" }
    },
  }
  await getAIAssistantModule(type).execute(input, probe)
  if (!captured) throw new Error("模块未调用客户端")
  return captured
}

describe("createAIClient", () => {
  it("创建默认 AIClient 实例", () => {
    const client = createAIClient()
    expect(client).toBeInstanceOf(AIClient)
  })

  it("支持自定义配置", () => {
    const client = createAIClient({ defaultModel: "sonnet", defaultTimeout: 300_000 })
    expect(client).toBeInstanceOf(AIClient)
  })

  it("通过 stdin 传输大型 prompt，不把文件内容放入 argv，并保留 timeout=0 的无超时语义", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octopus-agent-layer-"))
    temporaryDirectories.push(directory)
    const fakeClaudePath = join(directory, "fake-claude.mjs")
    writeFileSync(
      fakeClaudePath,
      [
        "#!/usr/bin/env node",
        'let input = ""',
        'process.stdin.setEncoding("utf8")',
        'process.stdin.on("data", (chunk) => { input += chunk })',
        'process.stdin.on("end", () => {',
        '  process.stdout.write(JSON.stringify({ result: String(input.length) + ":" + process.argv.includes(input) }))',
        "})",
      ].join("\n"),
    )
    chmodSync(fakeClaudePath, 0o755)

    const prompt = "大".repeat(1024 * 1024)
    const client = createAIClient({ claudePath: fakeClaudePath, retries: 0, defaultTimeout: 0 })

    await expect(client.ask({ prompt })).resolves.toMatchObject({
      result: `${prompt.length}:false`,
    })
  })

  it("超时时等待子进程关闭后才返回错误", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octopus-agent-layer-timeout-"))
    temporaryDirectories.push(directory)
    const fakeClaudePath = join(directory, "fake-claude-timeout.mjs")
    writeFileSync(
      fakeClaudePath,
      [
        "#!/usr/bin/env node",
        'process.on("SIGTERM", () => {})',
        "process.stdin.resume()",
        "setInterval(() => {}, 1000)",
      ].join("\n"),
    )
    chmodSync(fakeClaudePath, 0o755)
    const client = createAIClient({ claudePath: fakeClaudePath, retries: 0, defaultTimeout: 50 })

    await expect(client.ask({ prompt: "会超时" })).rejects.toThrow("claude 调用超时（50ms）")
  })
})

describe("AIClient.createCallRecord", () => {
  it("创建成功调用记录", () => {
    const client = createAIClient()
    const request = { prompt: "test" }
    const response = { result: "ok" }
    const record = client.createCallRecord(request, response)
    expect(record.success).toBe(true)
    expect(record.request).toBe(request)
    expect(record.response).toBe(response)
    expect(record.error).toBeUndefined()
    expect(record.id).toMatch(/^ai_/)
  })

  it("创建失败调用记录", () => {
    const client = createAIClient()
    const request = { prompt: "test" }
    const record = client.createCallRecord(request, undefined, "error msg")
    expect(record.success).toBe(false)
    expect(record.error).toBe("error msg")
    expect(record.response).toBeUndefined()
  })

  it("每次调用生成唯一 ID", () => {
    const client = createAIClient()
    const request = { prompt: "test" }
    const r1 = client.createCallRecord(request, { result: "a" })
    const r2 = client.createCallRecord(request, { result: "b" })
    expect(r1.id).not.toBe(r2.id)
  })
})

describe("AIClient.callAssistant 兼容层", () => {
  it.each(Object.values(AIAssistantType))("callAssistant(%s) 走专用模块，不再走通用提示词", async (type) => {
    const { client, requests } = fakeClient()
    await client.callAssistant(type, "输入原文")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual(await moduleRequest(type, "输入原文"))
  })

  it("未注册类型产生明确错误", async () => {
    const { client } = fakeClient()
    await expect(client.callAssistant("UNKNOWN_TYPE" as AIAssistantType, "x")).rejects.toThrow(/AI 模块未注册/)
  })
})

describe("专业助手便捷方法委托", () => {
  it("analyzeRequirements 委托到需求分析模块", async () => {
    const { client, requests } = fakeClient()
    await client.analyzeRequirements("PRD 内容")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual(await moduleRequest(AIAssistantType.REQUIREMENTS_ANALYSIS, "PRD 内容"))
  })

  it("estimateEffort 委托到估时提取模块", async () => {
    const { client, requests } = fakeClient()
    await client.estimateEffort("功能点列表")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual(await moduleRequest(AIAssistantType.EFFORT_ESTIMATION, "功能点列表"))
  })

  it("reviewCode 委托到 Code Review 模块", async () => {
    const { client, requests } = fakeClient()
    await client.reviewCode("diff 内容")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual(await moduleRequest(AIAssistantType.CODE_REVIEW, "diff 内容"))
  })

  it("checkSQL 委托到 SQL 风险检测模块", async () => {
    const { client, requests } = fakeClient()
    await client.checkSQL("SELECT * FROM t")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual(await moduleRequest(AIAssistantType.SQL_RISK_CHECK, "SELECT * FROM t"))
  })

  it("summarizeMeeting 委托到会议纪要模块", async () => {
    const { client, requests } = fakeClient()
    await client.summarizeMeeting("录音文字")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual(await moduleRequest(AIAssistantType.MEETING_MINUTES, "录音文字"))
  })

  it("reviewTechDesign 委托到技术方案审核模块", async () => {
    const { client, requests } = fakeClient()
    await client.reviewTechDesign("设计方案")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual(await moduleRequest(AIAssistantType.TECH_DESIGN_REVIEW, "设计方案"))
  })

  it("assessReleaseRisk 委托到发布风险评估模块", async () => {
    const { client, requests } = fakeClient()
    await client.assessReleaseRisk("变更范围")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual(await moduleRequest(AIAssistantType.RELEASE_RISK_ASSESSMENT, "变更范围"))
  })

  it("quantifyTechDebt 委托到技术债务量化模块", async () => {
    const { client, requests } = fakeClient()
    await client.quantifyTechDebt("代码指标")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual(await moduleRequest(AIAssistantType.TECH_DEBT_QUANTIFICATION, "代码指标"))
  })

  it("recommendChecklistItems 委托到 Checklist 推荐模块", async () => {
    const { client, requests } = fakeClient()
    await client.recommendChecklistItems("变更范围")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual(await moduleRequest(AIAssistantType.CHECKLIST_RECOMMENDATION, "变更范围"))
  })
})
