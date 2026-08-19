#!/usr/bin/env node
// Teambition 版本管理契约探针（PR1）。
// 纯 Node ESM + 全局 fetch，不新增依赖，不进生产 bundle。
//
// 读环境变量：
//   OCTOPUS_TB_APP_ID / OCTOPUS_TB_APP_SECRET / OCTOPUS_TB_ORG_ID
//   OCTOPUS_TB_VERSION_BASE（默认 https://www.teambition.com）
//   OCTOPUS_TB_SESSION_COOKIE / OCTOPUS_TB_USER_TOKEN（可选会话凭据）
//   OCTOPUS_TB_PROBE_REPO_ID / OCTOPUS_TB_PROBE_VERSION_ID
//   OCTOPUS_TB_PROBE_PROJECT_ID / OCTOPUS_TB_PROBE_PLUGIN_ID
//   OCTOPUS_TB_PROBE_WRITE_NOTE=1 才允许发 CONFIRMED PUT（默认只读）
//
// 退出码：只有实际发出去的请求里至少一次 HTTP 2xx 才为 0；否则 1。

import { createHmac, randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolve(__dirname, "../fixtures/teambition-version")

const env = process.env

const APP_ID = env.OCTOPUS_TB_APP_ID
const APP_SECRET = env.OCTOPUS_TB_APP_SECRET
const ORG_ID = env.OCTOPUS_TB_ORG_ID
const BASE = env.OCTOPUS_TB_VERSION_BASE || "https://www.teambition.com"
const GATEWAY = "https://open.teambition.com/api"
const SESSION_COOKIE = env.OCTOPUS_TB_SESSION_COOKIE
const USER_TOKEN = env.OCTOPUS_TB_USER_TOKEN
const REPO_ID = env.OCTOPUS_TB_PROBE_REPO_ID
const VERSION_ID = env.OCTOPUS_TB_PROBE_VERSION_ID
const PROJECT_ID = env.OCTOPUS_TB_PROBE_PROJECT_ID
const PLUGIN_ID = env.OCTOPUS_TB_PROBE_PLUGIN_ID
const WRITE_NOTE = env.OCTOPUS_TB_PROBE_WRITE_NOTE === "1"

const secrets = [APP_SECRET, SESSION_COOKIE, USER_TOKEN].filter(Boolean)

// ── 环境校验 ────────────────────────────────────────

const required = [
  ["OCTOPUS_TB_ORG_ID", ORG_ID],
  ["OCTOPUS_TB_PROBE_REPO_ID", REPO_ID],
  ["OCTOPUS_TB_PROBE_VERSION_ID", VERSION_ID],
  ["OCTOPUS_TB_PROBE_PROJECT_ID", PROJECT_ID],
  ["OCTOPUS_TB_PROBE_PLUGIN_ID", PLUGIN_ID],
]
const missing = required.filter(([, v]) => !v).map(([k]) => k)
const hasJwt = Boolean(APP_ID && APP_SECRET && ORG_ID)
const hasSession = Boolean(SESSION_COOKIE || USER_TOKEN)
if (!hasJwt && !hasSession) {
  missing.push(
    "OCTOPUS_TB_APP_ID + OCTOPUS_TB_APP_SECRET（app JWT）或 OCTOPUS_TB_SESSION_COOKIE / OCTOPUS_TB_USER_TOKEN（会话）至少一种",
  )
}

if (missing.length > 0) {
  console.error("缺少环境变量，无法运行 Teambition 版本契约探针：")
  for (const m of missing) console.error(`  - ${m}`)
  console.error("会话凭据可选：OCTOPUS_TB_SESSION_COOKIE / OCTOPUS_TB_USER_TOKEN")
  console.error("写探针：OCTOPUS_TB_PROBE_WRITE_NOTE=1 才允许发 CONFIRMED PUT（默认只读）")
  process.exit(1)
}

// ── 脱敏（与 TS 导出 sanitizeFixture / redactSecrets 同一规则）──

function redact(text) {
  let out = String(text)
  for (const s of secrets) if (s) out = out.split(s).join("[REDACTED]")
  const lines = out.split(/\r?\n/)
  const scrubbed = lines.map((line) =>
    /^(cookie|authorization)\s*:/i.test(line.trim()) ? "[REDACTED_HEADER]" : line,
  )
  return scrubbed.join("\n").slice(0, 300)
}

const ID_KINDS = ["id_repo", "id_ver", "id_proj", "id_plugin", "id_tenant"]

function sanitizeFixture(value) {
  const idMap = new Map()
  function walk(v) {
    if (typeof v === "string") {
      if (/^https?:\/\//.test(v)) return "https://example.test/note"
      if (/^[0-9a-f]{24}$/i.test(v)) {
        const existing = idMap.get(v)
        if (existing) return existing
        const kind = ID_KINDS[idMap.size % ID_KINDS.length]
        idMap.set(v, kind)
        return kind
      }
      if (/[\u4e00-\u9fff]/u.test(v) || /^1[3-9]\d{9}$/.test(v)) return "redacted"
      return v
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object") {
      const out = {}
      for (const [key, value] of Object.entries(v)) {
        if (/cookie|token|authorization|secret|email/i.test(key)) continue
        out[key] = walk(value)
      }
      return out
    }
    return v
  }
  return walk(value)
}

// ── app JWT（与任务客户端同算法）──

function b64(o) {
  return Buffer.from(JSON.stringify(o)).toString("base64url")
}

function signAppToken() {
  const now = Math.floor(Date.now() / 1000)
  const header = b64({ alg: "HS256", typ: "JWT" })
  const payload = b64({ _appId: APP_ID, iat: now, exp: now + 3600 })
  const head = `${header}.${payload}`
  const sig = createHmac("sha256", APP_SECRET).update(head).digest("base64url")
  return `${head}.${sig}`
}

// ── 请求 ────────────────────────────────────────────

async function probe(method, url, authMode, { body, referer } = {}) {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    "x-timezone": "8",
    "x-request-id": randomUUID(),
  }
  if (ORG_ID) headers["X-Tenant-Id"] = ORG_ID
  if (authMode === "jwt") {
    headers.authorization = `Bearer ${signAppToken()}`
    headers["X-Tenant-Type"] = "organization"
  } else if (authMode === "session") {
    headers.Cookie = SESSION_COOKIE
  } else if (authMode === "user-token") {
    headers.authorization = `Bearer ${USER_TOKEN}`
  }
  if (referer) headers.Referer = referer

  const init = { method, headers }
  if (body !== undefined) init.body = JSON.stringify(body)

  let status = 0
  let text = ""
  try {
    const res = await fetch(url, init)
    status = res.status
    text = await res.text()
  } catch (cause) {
    text = `网络错误: ${cause instanceof Error ? cause.message : String(cause)}`
  }
  return { method, url, authMode, status, text }
}

// ── 探针表 ──────────────────────────────────────────

const authModes = []
if (hasJwt) authModes.push("jwt")
if (SESSION_COOKIE) authModes.push("session")
if (USER_TOKEN) authModes.push("user-token")

const probes = [
  { name: "U1", desc: "列出版本", method: "GET", url: `${BASE}/version-manage/api/v1/repositories/${REPO_ID}/versions` },
  { name: "U2", desc: "列出版本（分页变体）", method: "GET", url: `${BASE}/version-manage/api/v1/repositories/${REPO_ID}/versions?pageSize=50` },
  { name: "U3", desc: "版本详情", method: "GET", url: `${BASE}/version-manage/api/v1/repositories/${REPO_ID}/versions/${VERSION_ID}` },
  { name: "U4", desc: "仓库详情", method: "GET", url: `${BASE}/version-manage/api/v1/repositories/${REPO_ID}` },
  { name: "U5", desc: "按项目列仓库", method: "GET", url: `${BASE}/version-manage/api/v1/projects/${PROJECT_ID}/repositories` },
  { name: "U6", desc: "按插件列仓库", method: "GET", url: `${BASE}/version-manage/api/v1/projects/${PROJECT_ID}/plugins/${PLUGIN_ID}/repositories` },
  { name: "U7", desc: "Open API 是否覆盖版本插件", method: "GET", url: `${GATEWAY}/` },
]

const rows = []
let saw2xx = false
let listPathConfirmed = null

function fixtureNameFor(name) {
  switch (name) {
    case "U1": return "probe-list-versions.json"
    case "U2": return "probe-list-versions-page.json"
    case "U3": return "probe-get-version.json"
    case "U4": return "probe-get-repository.json"
    case "U6": return "probe-list-repositories.json"
    default: return `probe-${name.toLowerCase()}.json`
  }
}

async function runProbe(p, authMode, extra = {}) {
  const r = await probe(p.method, p.url, authMode, extra)
  const ok = r.status >= 200 && r.status < 300
  if (ok) saw2xx = true
  if (ok && p.name === "U1" && !listPathConfirmed) listPathConfirmed = "U1"
  if (ok && p.name === "U2" && !listPathConfirmed) listPathConfirmed = "U2"
  console.log(`${r.method} ${r.url} [${r.authMode}] -> ${r.status}`)
  console.log(`  body: ${redact(r.text).slice(0, 200)}`)
  rows.push({
    name: p.name,
    desc: p.desc,
    method: r.method,
    path: p.url.replace(BASE, "{base}"),
    authMode: r.authMode,
    status: String(r.status),
    ok: ok ? "可用" : "不可用",
  })
  if (ok && r.text) {
    try {
      const clean = sanitizeFixture(JSON.parse(r.text))
      mkdirSync(FIXTURES_DIR, { recursive: true })
      const fixtureName = fixtureNameFor(p.name)
      writeFileSync(resolve(FIXTURES_DIR, fixtureName), `${JSON.stringify(clean, null, 2)}\n`)
      console.log(`  -> 已写脱敏 fixture ${fixtureName}`)
    } catch {
      // 非 JSON 或脱敏失败不写 fixture
    }
  }
  return ok
}

for (const p of probes) {
  for (const authMode of authModes) {
    await runProbe(p, authMode)
  }
}

// ── CONFIRMED PUT note（默认只读，不开不发）──

const notePath = `/version-manage/api/v1/repositories/${REPO_ID}/versions/${VERSION_ID}/note`
const noteUrl = `${BASE}${notePath}`
const referer = `https://www.teambition.com/project/${PROJECT_ID}/plugin/${PLUGIN_ID}/repo/${REPO_ID}/version/${VERSION_ID}`

if (WRITE_NOTE) {
  const body = { note: "octopus contract probe" }
  for (const authMode of authModes) {
    await runProbe(
      { name: "PUT-note", desc: "更新版本说明（带 Referer）", method: "PUT", url: noteUrl },
      authMode,
      { body, referer },
    )
  }
  if (hasJwt) {
    await runProbe(
      { name: "PUT-note-noreferer", desc: "更新版本说明（JWT 无 Referer 对照）", method: "PUT", url: noteUrl },
      "jwt",
      { body },
    )
  }
} else {
  console.log("OCTOPUS_TB_PROBE_WRITE_NOTE 未设置，跳过 CONFIRMED PUT 写探针（默认只读）")
  rows.push({
    name: "PUT-note",
    desc: "更新版本说明",
    method: "PUT",
    path: "{base}" + notePath,
    authMode: "-",
    status: "skipped",
    ok: "未执行（只读模式）",
  })
}

// ── PROBE-RESULTS.md ───────────────────────────────

const lines = [
  "# Teambition 版本管理契约探针结果",
  "",
  `- 探针时间：${new Date().toISOString()}`,
  `- 基线：${BASE}`,
  "- 本文件由 probe-teambition-version.mjs 生成；不包含任何 cookie / token / 真实 ID",
  "",
  "| 端点 | 用途 | 方法 | 路径 | 鉴权 | 状态 | 结论 |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.name} | ${r.desc} | ${r.method} | ${r.path} | ${r.authMode} | ${r.status} | ${r.ok} |`),
  "",
]
if (listPathConfirmed) {
  lines.push(
    `- 列表路径（第一个 2xx）：${listPathConfirmed}（U1 无 query 优先；若 U2 pageSize=50 截断请记录「可能截断」）`,
  )
} else {
  lines.push("- 列表路径：未发现 2xx（U1/U2 均未确认）")
}
lines.push(`- 本次探针至少一次 2xx：${saw2xx ? "是" : "否"}`)
mkdirSync(FIXTURES_DIR, { recursive: true })
writeFileSync(resolve(FIXTURES_DIR, "PROBE-RESULTS.md"), `${lines.join("\n")}\n`)
console.log(`已写 ${resolve(FIXTURES_DIR, "PROBE-RESULTS.md")}`)

process.exit(saw2xx ? 0 : 1)