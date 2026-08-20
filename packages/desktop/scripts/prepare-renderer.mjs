import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const sourceDir = join(packageRoot, "src", "renderer")
const outputDir = join(packageRoot, "dist", "renderer")

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })
cpSync(sourceDir, outputDir, {
  recursive: true,
  filter: (source) => !source.endsWith("element-plus-entry.js"),
})
copyFileSync(join(packageRoot, "src", "preload.cjs"), join(packageRoot, "dist", "preload.cjs"))
