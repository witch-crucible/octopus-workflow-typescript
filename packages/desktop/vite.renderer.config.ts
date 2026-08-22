import path from "node:path"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const packageRoot = dirname(fileURLToPath(import.meta.url))

// biome-ignore lint/style/noDefaultExport: Vite 通过默认导出加载配置。
export default defineConfig({
  root: resolve(packageRoot, "src/renderer"),
  base: "./",
  publicDir: resolve(packageRoot, "src/renderer/assets"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(packageRoot, "src/renderer"),
    },
  },
  build: {
    outDir: resolve(packageRoot, "dist/renderer"),
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: true,
  },
})
