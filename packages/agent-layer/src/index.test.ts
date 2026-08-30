import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it, expect } from "vitest"
import { createAIClient, AIClient, getAIAssistantModule } from "./index.js"
import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIRequest, AIResponse } from "@octopus/core/agent.js"

const temporaryDirectories: string[] = []

afterEach(() => {
  delete process.env["REVIEW_RECORD_DIRECTORY"]
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

function writeReviewTool(directory: string, agent: string, options: { fail?: boolean; delayMs?: number } = {}): string {
  const executable = join(directory, `${agent}.mjs`)
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'import { readFileSync, writeFileSync } from "node:fs"',
      `const agent = ${JSON.stringify(agent)}`,
      `const delayMs = ${options.delayMs ?? 0}`,
      `const fail = ${options.fail ?? false}`,
      'writeFileSync(1, `${agent} review`)',
      'const input = readFileSync(0, "utf8")',
      'writeFileSync(`${process.env.REVIEW_RECORD_DIRECTORY}/${agent}.json`, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input }))',
      'setTimeout(() => {',
      '  if (fail) { writeFileSync(2, `${agent} failed`); process.exitCode = 1; return }',
      '  process.stdout.end()',
      '}, delayMs)',
    ].join("\n"),
  )
  chmodSync(executable, 0o755)
  return executable
}

function writeReviewToolWithLingeringChild(directory: string): string {
  const executable = join(directory, "lingering-ocr.mjs")
  writeFileSync(executable, [
    "#!/usr/bin/env node",
    'import { spawn } from "node:child_process"',
    'import { readFileSync } from "node:fs"',
    'readFileSync(0, "utf8")',
    'spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { stdio: ["ignore", 1, 2] })',
  ].join("\n"))
  chmodSync(executable, 0o755)
  return executable
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
        'import { readFileSync, writeFileSync } from "node:fs"',
        'const input = readFileSync(0, "utf8")',
        'writeFileSync(1, JSON.stringify({ result: String(input.length) + ":" + process.argv.includes(input) }))',
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

describe("AIClient.crossReviewCode", () => {
  it("并行执行 OCR、Command Code 和 Codex，并传递各自约定的命令参数", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octopus-cross-review-"))
    temporaryDirectories.push(directory)
    process.env["REVIEW_RECORD_DIRECTORY"] = directory
    const client = createAIClient({
      ocrPath: writeReviewTool(directory, "ocr", { delayMs: 100 }),
      commandCodePath: writeReviewTool(directory, "commandcode", { delayMs: 100 }),
      codexPath: writeReviewTool(directory, "codex", { delayMs: 100 }),
      retries: 0,
    })

    const startedAt = Date.now()
    const response = await client.crossReviewCode("审查这个变更", directory, ["ocr", "commandcode", "codex"])
    const elapsedMs = Date.now() - startedAt

    expect(elapsedMs).toBeLessThan(280)
    expect(response.successCount).toBe(3)
    expect(response.reviews).toEqual([
      expect.objectContaining({ agent: "ocr", ok: true, output: "ocr review" }),
      expect.objectContaining({ agent: "commandcode", ok: true, output: "commandcode review" }),
      expect.objectContaining({ agent: "codex", ok: true, output: "codex review" }),
    ])
    expect(response.result).toBe(
      "# Cross Code Review\n\n## ocr\n\nocr review\n\n## commandcode\n\ncommandcode review\n\n## codex\n\ncodex review",
    )

    const ocr = JSON.parse(readFileSync(join(directory, "ocr.json"), "utf8"))
    const commandcode = JSON.parse(readFileSync(join(directory, "commandcode.json"), "utf8"))
    const codex = JSON.parse(readFileSync(join(directory, "codex.json"), "utf8"))
    expect(ocr).toEqual({
      args: ["review", "--repo", directory, "--audience", "agent", "--format", "text", "--background", "审查这个变更"],
      cwd: process.cwd(),
      input: "",
    })
    expect(commandcode).toEqual({
      args: ["--no-session", "--skip-onboarding", "--permission-mode", "plan", "--print", "审查这个变更"],
      cwd: directory,
      input: "",
    })
    expect(codex).toEqual({
      args: ["review", "--uncommitted", "-"],
      cwd: directory,
      input: "审查这个变更",
    })
  })

  it("单个审查工具失败时保留错误结果，其他工具仍可成功", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octopus-cross-review-failure-"))
    temporaryDirectories.push(directory)
    process.env["REVIEW_RECORD_DIRECTORY"] = directory
    const client = createAIClient({
      ocrPath: writeReviewTool(directory, "ocr"),
      commandCodePath: writeReviewTool(directory, "commandcode", { fail: true }),
      codexPath: writeReviewTool(directory, "codex"),
      retries: 0,
    })

    await expect(client.crossReviewCode("审查输入", directory, ["ocr", "commandcode", "codex"])).resolves.toMatchObject({
      successCount: 2,
      reviews: [
        { agent: "ocr", ok: true, output: "ocr review" },
        { agent: "commandcode", ok: false, output: "commandcode review", error: expect.stringContaining("commandcode 退出失败") },
        { agent: "codex", ok: true, output: "codex review" },
      ],
      result: expect.stringContaining("## commandcode\n\nError: commandcode 退出失败"),
    })
  })

  it("超时时终止继承输出管道的子进程树并及时返回", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octopus-cross-review-timeout-"))
    temporaryDirectories.push(directory)
    const client = createAIClient({
      ocrPath: writeReviewToolWithLingeringChild(directory),
      retries: 0,
      defaultTimeout: 50,
    })

    const startedAt = Date.now()
    const response = await client.crossReviewCode("审查输入", directory, ["ocr"])

    expect(Date.now() - startedAt).toBeLessThan(300)
    expect(response.reviews[0]).toMatchObject({
      agent: "ocr",
      ok: false,
      error: expect.stringContaining("调用超时（50ms）"),
    })
  })

  it("AbortSignal 会终止全部 reviewer 并及时返回取消结果", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octopus-cross-review-abort-"))
    temporaryDirectories.push(directory)
    process.env["REVIEW_RECORD_DIRECTORY"] = directory
    const client = createAIClient({
      ocrPath: writeReviewTool(directory, "ocr", { delayMs: 500 }),
      commandCodePath: writeReviewTool(directory, "commandcode", { delayMs: 500 }),
      codexPath: writeReviewTool(directory, "codex", { delayMs: 500 }),
      retries: 2,
      retryDelay: 500,
    })
    const controller = new AbortController()

    const startedAt = Date.now()
    const pending = client.crossReviewCode("审查输入", directory, ["ocr", "commandcode", "codex"], {
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 25)
    const response = await pending

    expect(Date.now() - startedAt).toBeLessThan(300)
    expect(response.successCount).toBe(0)
    expect(response.reviews.every((review) => review.error?.includes("调用已取消"))).toBe(true)
  })

  it("把生成报告路径传给 OCR exclude，并提示 Command Code/Codex 忽略", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octopus-cross-review-exclude-"))
    temporaryDirectories.push(directory)
    process.env["REVIEW_RECORD_DIRECTORY"] = directory
    const client = createAIClient({
      ocrPath: writeReviewTool(directory, "ocr"),
      commandCodePath: writeReviewTool(directory, "commandcode"),
      codexPath: writeReviewTool(directory, "codex"),
      retries: 0,
    })

    await client.crossReviewCode("审查输入", directory, ["ocr", "commandcode", "codex"], {
      excludedPaths: ["workflow/nodes/ai-code-review/cross-review.md", "workflow/nodes/ai-code-review/reviews/**"],
    })

    const ocr = JSON.parse(readFileSync(join(directory, "ocr.json"), "utf8")) as { args: string[] }
    const commandcode = JSON.parse(readFileSync(join(directory, "commandcode.json"), "utf8")) as { args: string[] }
    const codex = JSON.parse(readFileSync(join(directory, "codex.json"), "utf8")) as { input: string }
    expect(ocr.args).toContain("--exclude")
    expect(ocr.args).toContain("workflow/nodes/ai-code-review/cross-review.md,workflow/nodes/ai-code-review/reviews/**")
    expect(commandcode.args.at(-1)).toContain("workflow/nodes/ai-code-review/reviews/**")
    expect(codex.input).toContain("workflow/nodes/ai-code-review/reviews/**")
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
