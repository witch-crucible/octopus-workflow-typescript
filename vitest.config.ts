import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    // 工作区包的 exports 指向 dist；测试必须直接加载源码，避免验证到陈旧构建产物。
    alias: [{
      find: /^@octopus\/([^/]+)\/(.+)\.js$/,
      replacement: resolve(fileURLToPath(new URL(".", import.meta.url)), "packages/$1/src/$2.ts"),
    }],
  },
  test: {
    globals: true,
    include: ["packages/*/src/**/*.test.ts", "workflow/nodes/*/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "workflow/nodes/*/src/**/*.ts"],
      exclude: [
        "packages/*/src/**/*.test.ts",
        "packages/*/src/**/index.ts",
      ],
    },
  },
})
