import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

const packageRoot = dirname(fileURLToPath(import.meta.url))

// biome-ignore lint/style/noDefaultExport: Vite 通过默认导出加载配置。
export default defineConfig({
  build: {
    cssCodeSplit: false,
    emptyOutDir: false,
    lib: {
      entry: resolve(packageRoot, "src/renderer/element-plus-entry.js"),
      name: "OctopusElementPlusBundle",
      formats: ["iife"],
      fileName: () => "element-plus.js",
    },
    outDir: resolve(packageRoot, "dist/renderer"),
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.names.some((name) => name.endsWith(".css"))
            ? "element-plus.css"
            : "assets/[name]-[hash][extname]",
      },
      onwarn: (warning, warn) => {
        // @vueuse/core 的发布产物包含 Rolldown 无法识别位置的 PURE 注释，不影响构建结果。
        if (
          warning.code === "INVALID_ANNOTATION" &&
          typeof warning.id === "string" &&
          warning.id.includes("@vueuse/core")
        ) {
          return
        }
        warn(warning)
      },
    },
  },
})
