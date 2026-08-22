import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOctopusWebServer } from "../packages/desktop/dist/web.js"

const log = (message) => {
  process.stdout.write(`${message}\n`)
}

const storeDir = mkdtempSync(join(tmpdir(), "octo-hub-verify-"))
log("start")
const server = await createOctopusWebServer({
  port: 0,
  storeDir,
  rendererDir: join(process.cwd(), "packages/desktop/dist/renderer"),
})
log("created")
const url = await server.listen()
log(`listening ${url}`)

async function invoke(method, ...args) {
  const response = await fetch(`${url}/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args }),
  })
  return { status: response.status, body: await response.json() }
}

try {
  const page = await fetch(url)
  const html = await page.text()
  log(
    `page ${page.status} title=${html.includes("Octopus Workflow")} root=${html.includes("id=\"root\"")} react=${html.includes("assets/")}`,
  )

  const first = await invoke("init", "中心验证甲", "描述甲")
  const second = await invoke("init", "中心验证乙", "描述乙")
  log(`init1 ${first.status} ${first.body.result?.projectId ?? first.body.error}`)
  log(`init2 ${second.status} ${second.body.result?.projectId ?? second.body.error}`)

  const renamed = await invoke("updateProject", first.body.result.projectId, { name: "中心验证甲-改名" })
  log(`rename ${renamed.status} ${renamed.body.result?.projectName ?? renamed.body.error}`)

  const summaries = await invoke("listProjectSummaries")
  log(`summaries ${summaries.status} count=${summaries.body.result?.length}`)

  const deleted = await invoke("deleteProject", second.body.result.projectId)
  const after = await invoke("listProjects")
  log(`delete ${deleted.status} remaining=${JSON.stringify(after.body.result)}`)
  log("ok")
} finally {
  await server.close()
  rmSync(storeDir, { recursive: true, force: true })
}
