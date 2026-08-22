import { copyFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
mkdirSync(join(packageRoot, "dist"), { recursive: true })
copyFileSync(join(packageRoot, "src", "preload.cjs"), join(packageRoot, "dist", "preload.cjs"))
