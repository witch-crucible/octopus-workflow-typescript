/**
 * OmniPlan .oplx format — parse Actual.xml, build Actual.xml, pack/unpack .oplx.
 *
 * Uses a minimal XML parser focused on the subset OmniPlan writes:
 * only elements, attributes, text content, and self-closing tags.
 * No namespace processing, no DTD, no CDATA, no entity references beyond
 * the five XML entities (&amp; &lt; &gt; &quot; &apos;).
 */

import { readZip, writeZip } from "./zip-store.js"

// ── Types ──

export interface OmniPlanTask {
  id: string
  type?: string | undefined
  title?: string | undefined
  note?: string | undefined
  effort?: number | undefined
  lockedStartDate?: string | undefined
  recalculate?: string | undefined
  staticCost?: string | undefined
  prerequisiteIds: string[]
  childIds: string[]
  assignmentRefs: Array<{ idref: string; units?: string | undefined }>
}

export interface OmniPlanDocument {
  scenarioId: string
  startDate?: string | undefined
  granularity?: string | undefined
  tasks: OmniPlanTask[]
  /** Raw XML of prototype/resource/top-task sections for round-trip preservation */
  prototypeSection: string
  resourceSection: string
  topTaskRef: string
  /** The full task element XML for tasks under top-task */
  rawTaskXml: string
}

export interface OmniPlanBuildInput {
  projectName: string
  scenarioId: string
  startDate?: string | undefined
  requirements: Array<{
    id: string
    name: string
    plannedStart?: string | undefined
    plannedEnd?: string | undefined
    nodes: Array<{
      id: string
      name: string
      nodeId: string
      requirementId: string
      plannedStart?: string | undefined
      plannedEnd?: string | undefined
      dependsOn?: string[] | undefined
    }>
    milestones?: Array<{ id: string; name: string; date: string }> | undefined
  }>
  /** Map from octopus key → OmniPlan task ID */
  idMap: Record<string, string>
}

export interface OmniPlanImportResult {
  updatedRequirements: number
  updatedNodes: number
  updatedMilestones: number
  unmatched: string[]
  skipped: string[]
  path: string
}

// ── XML escaping / unescaping ──

const XML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
}

const XML_UNESCAPE_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => XML_ESCAPE_MAP[ch] ?? ch)
}

function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => XML_UNESCAPE_MAP[`&${entity};`] ?? `&${entity};`)
}

// ── Minimal XML parser ──

interface XmlNode {
  tag: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
  selfClosing: boolean
}

function charAt(xml: string, pos: number): string {
  return xml[pos] ?? ""
}

function parseXmlNode(xml: string, pos: number): { node: XmlNode; end: number } {
  // Skip whitespace
  while (pos < xml.length && /\s/.test(charAt(xml, pos))) pos++

  // Skip processing instructions (<?xml ...?>)
  while (pos < xml.length && charAt(xml, pos) === "<" && charAt(xml, pos + 1) === "?") {
    const endPI = xml.indexOf("?>", pos + 2)
    pos = endPI >= 0 ? endPI + 2 : xml.length
    while (pos < xml.length && /\s/.test(charAt(xml, pos))) pos++
  }

  if (pos >= xml.length || charAt(xml, pos) !== "<") {
    throw new Error(`Expected '<' at position ${pos}`)
  }

  // Self-closing?
  const selfClose = charAt(xml, pos + 1) === "/"

  // Parse tag name and attributes
  pos++ // skip <
  if (selfClose) pos++ // skip /

  let tag = ""
  while (pos < xml.length && /[a-zA-Z0-9:._-]/.test(charAt(xml, pos))) {
    tag += charAt(xml, pos)
    pos++
  }

  const attrs: Record<string, string> = {}
  while (pos < xml.length) {
    while (pos < xml.length && /\s/.test(charAt(xml, pos))) pos++
    if (pos >= xml.length) break
    if (charAt(xml, pos) === ">" || charAt(xml, pos) === "/") break

    let attrName = ""
    while (pos < xml.length && /[a-zA-Z0-9:._-]/.test(charAt(xml, pos))) {
      attrName += charAt(xml, pos)
      pos++
    }
    if (attrName === "") {
      pos++ // skip unexpected char
      continue
    }

    while (pos < xml.length && /\s/.test(charAt(xml, pos))) pos++
    if (pos < xml.length && charAt(xml, pos) === "=") {
      pos++ // skip =
      while (pos < xml.length && /\s/.test(charAt(xml, pos))) pos++
      if (pos < xml.length && charAt(xml, pos) === '"') {
        pos++ // skip "
        let val = ""
        while (pos < xml.length && charAt(xml, pos) !== '"') {
          val += charAt(xml, pos)
          pos++
        }
        pos++ // skip closing "
        attrs[attrName] = val
      } else {
        // Unquoted attribute
        let val = ""
        while (pos < xml.length && !/[\s>]/.test(charAt(xml, pos))) {
          val += charAt(xml, pos)
          pos++
        }
        attrs[attrName] = val
      }
    }
  }

  // Check for self-closing
  if (charAt(xml, pos) === "/") {
    pos++ // skip /
    pos++ // skip >
    return { node: { tag, attrs, children: [], text: "", selfClosing: true }, end: pos }
  }

  pos++ // skip >

  // Parse children and text
  const children: XmlNode[] = []
  let text = ""

  while (pos < xml.length) {
    if (charAt(xml, pos) === "<") {
      if (xml.substring(pos, pos + 2) === "</") {
        // Closing tag
        pos += 2
        while (pos < xml.length && /[a-zA-Z0-9:._-]/.test(charAt(xml, pos))) pos++
        while (pos < xml.length && charAt(xml, pos) !== ">") pos++
        pos++ // skip >
        return { node: { tag, attrs, children, text, selfClosing: false }, end: pos }
      }
      if (xml.substring(pos, pos + 4) === "<!--") {
        // Comment
        const endComment = xml.indexOf("-->", pos + 4)
        pos = endComment >= 0 ? endComment + 3 : xml.length
        continue
      }
      const child = parseXmlNode(xml, pos)
      children.push(child.node)
      pos = child.end
    } else {
      // Text content
      let chunk = ""
      while (pos < xml.length && charAt(xml, pos) !== "<") {
        chunk += charAt(xml, pos)
        pos++
      }
      text += chunk
    }
  }

  return { node: { tag, attrs, children, text, selfClosing: false }, end: pos }
}

function findElement(root: XmlNode, tag: string): XmlNode | undefined {
  for (const child of root.children) {
    if (child.tag === tag) return child
  }
  return undefined
}

function findElements(root: XmlNode, tag: string): XmlNode[] {
  return root.children.filter((child) => child.tag === tag)
}

function getElementText(node: XmlNode, tag: string): string | undefined {
  const child = findElement(node, tag)
  if (!child) return undefined
  return unescapeXml(child.text)
}

// ── parseOmniPlanActual ──

export function parseOmniPlanActual(xml: string): OmniPlanDocument {
  const { node: root, end } = parseXmlNode(xml.trim(), 0)
  if (root.tag !== "scenario") {
    throw new Error(`Expected <scenario> root, got <${root.tag}>`)
  }

  const scenarioId = root.attrs["id"] ?? ""
  const startDate = getElementText(root, "start-date")
  const granularity = getElementText(root, "granularity")

  // Parse tasks
  const taskElements = findElements(root, "task")
  const tasks: OmniPlanTask[] = []

  for (const taskEl of taskElements) {
    const prerequisiteIds = findElements(taskEl, "prerequisite-task").map(
      (el) => el.attrs["idref"] ?? "",
    )
    const childIds = findElements(taskEl, "child-task").map(
      (el) => el.attrs["idref"] ?? "",
    )
    const assignmentRefs = findElements(taskEl, "assignment").map((el) => ({
      idref: el.attrs["idref"] ?? "",
      ...(el.attrs["units"] !== undefined ? { units: el.attrs["units"] } : {}),
    }))

    tasks.push({
      id: taskEl.attrs["id"] ?? "",
      type: getElementText(taskEl, "type"),
      title: getElementText(taskEl, "title"),
      note: getElementText(taskEl, "note"),
      effort: getElementText(taskEl, "effort") !== undefined
        ? Number(getElementText(taskEl, "effort"))
        : undefined,
      lockedStartDate: getElementText(taskEl, "locked-start-date"),
      recalculate: getElementText(taskEl, "recalculate"),
      staticCost: getElementText(taskEl, "static-cost"),
      prerequisiteIds,
      childIds,
      assignmentRefs,
    })
  }

  // Extract prototype/resource sections as raw XML for round-trip
  const protoXml = xml.substring(
    xml.indexOf("<prototype-task>"),
    xml.indexOf("<top-resource"),
  )
  const resourceXml = xml.substring(
    xml.indexOf("<top-resource"),
    xml.indexOf("<top-task"),
  )
  const topTaskRef = xml.substring(
    xml.indexOf("<top-task"),
    xml.indexOf("<top-task") + xml.indexOf("/>") + 2,
  )

  // Extract the task block that sits under top-task
  const topTaskIdx = xml.indexOf("<top-task")
  const taskBlockStart = xml.indexOf("<task", topTaskIdx + 50)
  const scenarioEnd = xml.lastIndexOf("</scenario>")
  const taskBlock = xml.substring(taskBlockStart, scenarioEnd)

  return {
    scenarioId,
    startDate,
    granularity,
    tasks,
    prototypeSection: protoXml,
    resourceSection: resourceXml,
    topTaskRef: topTaskRef,
    rawTaskXml: taskBlock,
  }
}

// ── Date helpers ──

/**
 * Convert YYYY-MM-DD to OmniPlan ISO format (Shanghai T02:00:00.000Z).
 */
export function dateToOmniPlanIso(dateStr: string): string {
  return `${dateStr}T02:00:00.000Z`
}

/**
 * Extract YYYY-MM-DD from OmniPlan ISO format.
 * Takes the calendar day from ISO, no timezone conversion.
 */
export function omniPlanIsoToDate(isoStr: string): string {
  return isoStr.slice(0, 10)
}

// ── Path slug ──

/**
 * Convert a project name to a safe OmniPlan folder slug.
 * Rules: NFD decompose → remove diacritics → lowercase → non-alphanumeric to '-' → compress → trim.
 */
export function slugifyProjectName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return slug
}

/**
 * Validate that a folder/file name is safe (no path traversal).
 */
export function validateOmniPlanName(name: string, kind: "folder" | "file"): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`无效的 OmniPlan ${kind}名称: "${name}"。只允许字母、数字、点、下划线和连字符。`)
  }
  if (name.includes("..")) {
    throw new Error(`OmniPlan ${kind}名称不允许包含 ".."。`)
  }
}

// ── Stable ID generation ──

/**
 * Generate a stable task ID from a key, using a simple hash.
 * Format: t-{hash} where hash is hex-encoded.
 */
export function stableTaskId(key: string): string {
  // Simple FNV-1a-like hash
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `t${Math.abs(hash).toString(36).slice(0, 8)}`
}

// ── buildOmniPlanActual ──

/**
 * Build an OmniPlan Actual.xml from the given input.
 */
export function buildOmniPlanActual(input: OmniPlanBuildInput): string {
  const lines: string[] = []
  const indent = "  "

  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<scenario xmlns="http://www.omnigroup.com/namespace/OmniPlan/v2" xmlns:opns="http://www.omnigroup.com/namespace/OmniPlan/v2" id="' + escapeXml(input.scenarioId) + '">')

  if (input.startDate) {
    lines.push(`${indent}<start-date>${escapeXml(dateToOmniPlanIso(input.startDate))}</start-date>`)
  }
  lines.push(`${indent}<granularity>days</granularity>`)

  // Prototype tasks
  lines.push(`${indent}<prototype-task>`)
  lines.push(`${indent}${indent}<task id="t-2">`)
  lines.push(`${indent}${indent}${indent}<title>${escapeXml("任务 1")}</title>`)
  lines.push(`${indent}${indent}${indent}<effort>28800</effort>`)
  lines.push(`${indent}${indent}${indent}<recalculate>duration</recalculate>`)
  lines.push(`${indent}${indent}${indent}<static-cost>0</static-cost>`)
  lines.push(`${indent}${indent}</task>`)
  lines.push(`${indent}</prototype-task>`)

  lines.push(`${indent}<prototype-task>`)
  lines.push(`${indent}${indent}<task id="t-3">`)
  lines.push(`${indent}${indent}${indent}<title>${escapeXml("里程碑 1")}</title>`)
  lines.push(`${indent}${indent}${indent}<type>milestone</type>`)
  lines.push(`${indent}${indent}${indent}<recalculate>duration</recalculate>`)
  lines.push(`${indent}${indent}${indent}<static-cost>0</static-cost>`)
  lines.push(`${indent}${indent}</task>`)
  lines.push(`${indent}</prototype-task>`)

  lines.push(`${indent}<prototype-task>`)
  lines.push(`${indent}${indent}<task id="t-4">`)
  lines.push(`${indent}${indent}${indent}<title>${escapeXml("群组 1")}</title>`)
  lines.push(`${indent}${indent}${indent}<type>group</type>`)
  lines.push(`${indent}${indent}${indent}<recalculate>duration</recalculate>`)
  lines.push(`${indent}${indent}${indent}<static-cost>0</static-cost>`)
  lines.push(`${indent}${indent}</task>`)
  lines.push(`${indent}</prototype-task>`)

  lines.push(`${indent}<prototype-resource>`)
  lines.push(`${indent}${indent}<resource id="r-2"/>`)
  lines.push(`${indent}</prototype-resource>`)

  // Resource section (from template)
  lines.push(`${indent}<top-resource idref="r-1"/>`)
  lines.push(`${indent}<resource id="r-1">`)
  lines.push(`${indent}${indent}<name>${escapeXml("项目")}</name>`)
  lines.push(`${indent}${indent}<type>Project</type>`)
  lines.push(`${indent}${indent}<schedule>`)
  for (const day of ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]) {
    lines.push(`${indent}${indent}${indent}<schedule-day day-of-week="${day}">`)
    if (day !== "sunday" && day !== "saturday") {
      lines.push(`${indent}${indent}${indent}${indent}<time-span start-time="36000" end-time="43200"/>`)
      lines.push(`${indent}${indent}${indent}${indent}<time-span start-time="46800" end-time="68400"/>`)
    }
    lines.push(`${indent}${indent}${indent}</schedule-day>`)
  }
  lines.push(`${indent}${indent}${indent}<calendar name="Overtime" editable="yes" overtime="yes"/>`)
  lines.push(`${indent}${indent}${indent}<calendar name="Time Off" editable="yes" overtime="no"/>`)
  lines.push(`${indent}${indent}</schedule>`)

  // Staff resources (minimal)
  lines.push(`${indent}${indent}<child-resource idref="r5"/>`)
  lines.push(`${indent}</resource>`)
  lines.push(`${indent}<resource id="r5">`)
  lines.push(`${indent}${indent}<name>${escapeXml("Staff")}</name>`)
  lines.push(`${indent}${indent}<type>Staff</type>`)
  lines.push(`${indent}</resource>`)

  // Top task reference
  lines.push(`${indent}<top-task idref="t-1"/>`)

  // Build task tree
  const idMap = { ...input.idMap }

  // Helper: get or create ID
  function getId(key: string): string {
    if (idMap[key]) return idMap[key]
    const id = stableTaskId(key)
    idMap[key] = id
    return id
  }

  // Root group
  const rootId = "t-1"
  lines.push(`${indent}<task id="${rootId}">`)
  lines.push(`${indent}${indent}<type>group</type>`)
  lines.push(`${indent}${indent}<recalculate>duration</recalculate>`)
  lines.push(`${indent}${indent}<static-cost>0</static-cost>`)

  // Project group
  const projectKey = `project:${input.projectName}`
  const projectId = getId(projectKey)
  lines.push(`${indent}${indent}${indent}<child-task idref="${projectId}"/>`)
  lines.push(`${indent}</task>`)

  lines.push(`${indent}<task id="${projectId}">`)
  lines.push(`${indent}${indent}<title>${escapeXml(input.projectName)}</title>`)
  lines.push(`${indent}${indent}<type>group</type>`)
  lines.push(`${indent}${indent}<recalculate>duration</recalculate>`)
  lines.push(`${indent}${indent}<static-cost>0</static-cost>`)

  // Requirements
  for (const req of input.requirements) {
    const reqKey = `requirement:${req.id}`
    const reqId = getId(reqKey)
    lines.push(`${indent}${indent}${indent}<child-task idref="${reqId}"/>`)
  }

  lines.push(`${indent}</task>`)

  // Requirement groups and their nodes
  for (const req of input.requirements) {
    const reqKey = `requirement:${req.id}`
    const reqId = getId(reqKey)

    lines.push(`${indent}<task id="${reqId}">`)
    lines.push(`${indent}${indent}<title>${escapeXml(req.name)}</title>`)
    lines.push(`${indent}${indent}<note>octopus:requirement:${escapeXml(req.id)}</note>`)
    lines.push(`${indent}${indent}<type>group</type>`)
    lines.push(`${indent}${indent}<recalculate>duration</recalculate>`)
    lines.push(`${indent}${indent}<static-cost>0</static-cost>`)

    // Locked start/effort for requirement group
    if (req.plannedStart) {
      lines.push(`${indent}${indent}<locked-start-date>${escapeXml(dateToOmniPlanIso(req.plannedStart))}</locked-start-date>`)
    }
    if (req.plannedStart && req.plannedEnd) {
      const start = new Date(req.plannedStart)
      const end = new Date(req.plannedEnd)
      const daysInclusive = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1
      lines.push(`${indent}${indent}<effort>${daysInclusive * 28800}</effort>`)
    }

    // Child tasks (milestones then nodes)
    for (const ms of req.milestones ?? []) {
      const msKey = `milestone:${req.id}:${ms.id}`
      const msId = getId(msKey)
      lines.push(`${indent}${indent}${indent}<child-task idref="${msId}"/>`)
    }
    for (const node of req.nodes) {
      const nodeKey = `node:${req.id}:${node.nodeId}`
      const nodeId = getId(nodeKey)
      lines.push(`${indent}${indent}${indent}<child-task idref="${nodeId}"/>`)
    }

    lines.push(`${indent}</task>`)

    // Milestone tasks (leaves)
    for (const ms of req.milestones ?? []) {
      const msKey = `milestone:${req.id}:${ms.id}`
      const msId = getId(msKey)

      lines.push(`${indent}<task id="${msId}">`)
      lines.push(`${indent}${indent}<title>${escapeXml(ms.name)}</title>`)
      lines.push(`${indent}${indent}<note>octopus:milestone:${escapeXml(req.id)}:${escapeXml(ms.id)}</note>`)
      lines.push(`${indent}${indent}<type>milestone</type>`)
      lines.push(`${indent}${indent}<locked-start-date>${escapeXml(dateToOmniPlanIso(ms.date))}</locked-start-date>`)
      lines.push(`${indent}${indent}<effort>0</effort>`)
      lines.push(`${indent}${indent}<recalculate>duration</recalculate>`)
      lines.push(`${indent}${indent}<static-cost>0</static-cost>`)
      lines.push(`${indent}</task>`)
    }

    // Node tasks (leaves)
    for (const node of req.nodes) {
      const nodeKey = `node:${req.id}:${node.nodeId}`
      const nodeId = getId(nodeKey)

      lines.push(`${indent}<task id="${nodeId}">`)
      lines.push(`${indent}${indent}<title>${escapeXml(node.name)}</title>`)
      lines.push(`${indent}${indent}<note>octopus:node:${escapeXml(req.id)}:${escapeXml(node.nodeId)}</note>`)
      lines.push(`${indent}${indent}<recalculate>duration</recalculate>`)
      lines.push(`${indent}${indent}<static-cost>0</static-cost>`)

      if (node.plannedStart) {
        lines.push(`${indent}${indent}<locked-start-date>${escapeXml(dateToOmniPlanIso(node.plannedStart))}</locked-start-date>`)
      }

      // Effort: compute from dates or default to 1 day
      if (node.plannedStart && node.plannedEnd) {
        const start = new Date(node.plannedStart)
        const end = new Date(node.plannedEnd)
        const daysInclusive = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1
        lines.push(`${indent}${indent}<effort>${daysInclusive * 28800}</effort>`)
      } else {
        lines.push(`${indent}${indent}<effort>28800</effort>`)
      }

      // Prerequisites
      if (node.dependsOn) {
        for (const depId of node.dependsOn) {
          const depKey = `node:${req.id}:${depId}`
          const depOmniId = getId(depKey)
          lines.push(`${indent}${indent}<prerequisite-task idref="${depOmniId}"/>`)
        }
      }

      lines.push(`${indent}</task>`)
    }
  }

  // Critical path (minimal)
  lines.push(`${indent}<critical-path root="-1" enabled="false" resources="false">`)
  lines.push(`${indent}${indent}<color space="srgb" r="1" g="0.5" b="0.5"/>`)
  lines.push(`${indent}</critical-path>`)

  lines.push("</scenario>")

  return lines.join("\n")
}

// ── TOC XML ──

/**
 * Generate __TOC.xml with the given scenario ID.
 */
export function buildTocXml(scenarioId: string): string {
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<omniplan xmlns="http://www.omnigroup.com/namespace/OmniPlan/v2" xmlns:opnx="http://www.omnigroup.com/namespace/OmniPlan/v2" file-format-version="3">')
  lines.push("  <window x=\"-1920\" y=\"307\" w=\"1920\" h=\"959\">")
  lines.push(`    <editing-scenario>${escapeXml(scenarioId)}</editing-scenario>`)
  lines.push("    <view>resource</view>")
  lines.push("    <change-tracking/>")
  lines.push("    <status-display>basic</status-display>")
  lines.push("  </window>")
  lines.push("  <project>")
  lines.push("    <next-task-id>100</next-task-id>")
  lines.push("    <next-resource-id>10</next-resource-id>")
  lines.push(`    <scenario id="${escapeXml(scenarioId)}" name="Actual" filename="Actual.xml"/>`)
  lines.push("    <date-display dates=\"true\" times=\"true\" seconds=\"false\"/>")
  lines.push("    <numbering-style>wbs</numbering-style>")
  lines.push("    <critical-path-slack>0</critical-path-slack>")
  lines.push("  </project>")
  lines.push("</omniplan>")

  return lines.join("\n")
}

// ── Changelog XML ──

function buildChangelogXml(): string {
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<changelog xmlns="http://www.omnigroup.com/namespace/OmniPlan/v2">')
  lines.push("  <version>4.0</version>")
  lines.push("</changelog>")

  return lines.join("\n")
}

// ── packOplx / unpackOplx ──

export interface PackedOplx {
  actualXml: string
  tocXml: string
  entries: Map<string, Buffer>
}

export function unpackOplx(buf: Buffer): PackedOplx {
  const entries = readZip(buf)
  const actualXml = entries.get("Actual.xml")?.toString("utf-8") ?? ""
  const tocXml = entries.get("__TOC.xml")?.toString("utf-8") ?? ""

  if (!actualXml) {
    throw new Error("ZIP 中缺少 Actual.xml")
  }

  return { actualXml, tocXml, entries }
}

export function packOplx(
  actualXml: string,
  tocXml: string,
  extra?: Map<string, Buffer>,
): Buffer {
  const entries: Array<{ name: string; data: Buffer }> = [
    { name: "Actual.xml", data: Buffer.from(actualXml, "utf-8") },
    { name: "__TOC.xml", data: Buffer.from(tocXml, "utf-8") },
  ]

  if (extra) {
    for (const [name, data] of extra) {
      if (name !== "Actual.xml" && name !== "__TOC.xml") {
        entries.push({ name, data })
      }
    }
  }

  return writeZip(entries)
}

/**
 * Resolve the OmniPlan folder for a project.
 * Priority: metadata.omniplanFolder > slug > fallback.
 */
export function resolveOmniPlanFolder(
  projectName: string,
  projectId: string,
  existingMetadata?: Record<string, string>,
): string {
  if (existingMetadata?.["omniplanFolder"]) {
    validateOmniPlanName(existingMetadata["omniplanFolder"], "folder")
    return existingMetadata["omniplanFolder"]
  }

  const slug = slugifyProjectName(projectName)
  if (slug) return slug

  // Pure Chinese or no Latin characters — use project ID suffix
  return `project-${projectId.slice(-8)}`
}

/**
 * Resolve the file name for export/import.
 * Priority: options.fileName > metadata.omniplanFileName > single .oplx in dir > sanitized name.
 */
export function resolveOmniPlanFileName(
  projectName: string,
  existingMetadata?: Record<string, string>,
  optionsFileName?: string,
  existingFiles?: string[],
): string {
  if (optionsFileName) {
    validateOmniPlanName(optionsFileName, "file")
    return `${optionsFileName}.oplx`
  }

  if (existingMetadata?.["omniplanFileName"]) {
    return existingMetadata["omniplanFileName"]
  }

  if (existingFiles && existingFiles.length === 1) {
    return existingFiles[0] ?? ""
  }

  if (existingFiles && existingFiles.length > 1) {
    throw new Error(
      `目录内存在多个 .oplx 文件: ${existingFiles.join(", ")}。请用 --file 指定目标文件。`,
    )
  }

  const sanitized = projectName.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9._-]/g, "")
  return `${sanitized}.oplx`
}
