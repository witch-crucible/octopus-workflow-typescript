import { afterEach, describe, expect, it, vi } from "vitest"
import { createTestPersistenceStore } from "@octopus/context/testing.js"
import { WorkflowEngine } from "./index.js"

const engines: WorkflowEngine[] = []

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
})

describe("集成健康持久化", () => {
  it("成功与异常均写入健康表且响应不变", async () => {
    const { store } = await createTestPersistenceStore()
    const engine = new WorkflowEngine({
      store,
      integrations: {
        healthy: { healthCheck: vi.fn(async () => ({ success: true, message: "ok" })) } as never,
        broken: {
          healthCheck: vi.fn(async () => {
            throw new Error("offline")
          }),
        } as never,
      },
    })
    await engine.initialize()
    engines.push(engine)
    const results = await engine.checkIntegrationHealth()
    expect(results).toHaveLength(2)
    expect(results.find((item) => item.service === "broken")).toMatchObject({
      healthy: false,
      message: "offline",
    })
    expect(await engine.getIntegrationHealth()).toHaveLength(2)
  })
})
