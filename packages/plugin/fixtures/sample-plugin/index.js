/** 测试用示例插件。只通过 ctx 注册，不依赖宿主内部实现。 */
export const octopusPlugin = {
  id: "sample",
  version: "1.0.0",
  activate(ctx) {
    ctx.contributeOverlay({
      add: [{
        key: "sample-extra-check",
        phase: "Testing",
        name: "Sample Extra Check",
        description: "Plugin-provided extra check",
        responsibleRoles: ["QA"],
        dependsOn: ["smoke-demo-validation"],
        actions: [{ type: "custom", name: "sample.ping", input: { ok: true } }],
      }],
    })
    ctx.registerIntegration({
      name: "sample",
      healthCheck: async () => ({ success: true, message: "sample ok" }),
      ping: async () => ({ success: true, message: "pong" }),
    })
    ctx.registerCapability("sample.ping", async (ref) => {
      if (ref.kind !== "custom") return { kind: ref.kind, ref: "", ok: false }
      return { kind: "custom", ref: ref.name, ok: true, summary: "sample ping" }
    })
  },
}
