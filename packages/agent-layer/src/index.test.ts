import { describe, it, expect } from "vitest"
import { createAIClient, AIClient } from "./index.js"

describe("createAIClient", () => {
  it("创建默认 AIClient 实例", () => {
    const client = createAIClient()
    expect(client).toBeInstanceOf(AIClient)
  })

  it("支持自定义配置", () => {
    const client = createAIClient({ defaultModel: "sonnet", defaultTimeout: 300_000 })
    expect(client).toBeInstanceOf(AIClient)
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
