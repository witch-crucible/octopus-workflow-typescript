/**
 * 项目级 BRD 设计配置 —— 源路径、规范、产出地址与可覆盖提示词。
 *
 * 持久化在 Project.metadata["brdDesign"]（JSON 字符串），与 OmniPlan 元数据模式一致。
 */

/** metadata 中的配置键 */
export const BRD_DESIGN_METADATA_KEY = "brdDesign"

/** 提示词标识 */
export type BrdPromptId = "summarize-sources" | "generate" | "check"

/** 单条提示词模板 */
export interface BrdPromptTemplate {
  system: string
  /** 支持 {{placeholder}} 占位符 */
  user: string
}

/** 代码与展示源 */
export interface BrdDesignSources {
  miniprogramCodePath?: string
  websiteCodePath?: string
  frontendCodePath?: string
  backendCodePath?: string
  /** 小程序编译产物路径 */
  miniprogramBuildArtifact?: string
  /** 官网展示域名 */
  websiteUrl?: string
  /** 历史 BRD 文件或目录；每次生成时重新采集，用作结构与表达参考 */
  historicalBrdPaths?: string[]
}

/** 项目级 BRD 设计配置 */
export interface ProjectBrdDesignConfig {
  sources: BrdDesignSources
  /** BRD 规范文件路径（相对项目根或绝对） */
  brdSpecPath?: string
  /** BRD 产出路径（相对项目根或绝对） */
  brdOutputPath?: string
  /** 可覆盖的提示词；缺省键使用内置默认 */
  prompts?: Partial<Record<BrdPromptId, BrdPromptTemplate>>
}

/** 深部分更新；字符串字段传 "" 表示清除 */
export type ProjectBrdDesignConfigPatch = {
  sources?: Partial<BrdDesignSources>
  brdSpecPath?: string
  brdOutputPath?: string
  prompts?: Partial<Record<BrdPromptId, Partial<BrdPromptTemplate> | null>>
}

/** 提示词渲染变量 */
export interface BrdPromptVars {
  requirementName?: string
  requirementDescription?: string
  brdSpec?: string
  sourcesSummary?: string
  existingBrd?: string
  websiteUrl?: string
  miniprogramBuildArtifact?: string
  historicalBrds?: string
  /** 上一版本以来的实际变更（unified 行级 diff）；无历史版本时为占位说明 */
  brdChangeDiff?: string
}

/** 默认 BRD 产出路径（相对项目根） */
export const DEFAULT_BRD_OUTPUT_PATH =
  "workflow/nodes/requirements-analysis-and-brd-design/brd.md"

/** 内置默认 BRD 规范摘要（无规范文件时使用） */
export const DEFAULT_BRD_SPEC = `# BRD 规范（默认）

## 必备章节
1. 背景与目标
2. 用户与场景
3. 范围（In / Out of Scope）
4. 功能需求（可验收）
5. 非功能需求（性能、安全、兼容）
6. 依赖与约束
7. 风险与待确认项
8. 成功标准 / 验收要点

## 写作要求
- 使用 Markdown
- 需求条目可验收、可跟踪
- 明确假设与待确认项，避免把猜测写成事实
- 结合已有产品（小程序 / 官网 / 前端 / 后端）现状描述增量
`

const PROMPT_IDS: readonly BrdPromptId[] = ["summarize-sources", "generate", "check"]

/** 内置默认提示词包 */
export function buildDefaultBrdPrompts(): Record<BrdPromptId, BrdPromptTemplate> {
  return {
    "summarize-sources": {
      system:
        "你是资深产品分析师。请根据给定的代码/产物摘要，提炼与当前需求相关的现有能力、入口、数据与约束。只输出要点列表，不要编写完整 BRD。",
      user: `需求名称：{{requirementName}}
需求描述：{{requirementDescription}}

源摘要：
{{sourcesSummary}}

请输出与该需求相关的现有能力与约束要点。`,
    },
    generate: {
      system:
        "你是资深产品经理（PM）。请根据 BRD 规范、需求描述与项目源摘要，撰写完整的商业需求文档（BRD）。" +
        "输出必须是 Markdown，覆盖规范中的必备章节；结合小程序/官网/前端/后端现状描述增量；" +
        "将不确定内容明确标为「假设」或「待确认」。不要输出与 BRD 无关的开场白。",
      user: `请根据以下信息生成 BRD。

## 需求
名称：{{requirementName}}
描述：{{requirementDescription}}

## BRD 规范
{{brdSpec}}

## 项目源摘要（代码 / 展示）
{{sourcesSummary}}

## 展示信息
官网：{{websiteUrl}}
小程序产物：{{miniprogramBuildArtifact}}

## 已有 BRD（可为空；若有则在其基础上完善，不要无故删除仍有效的内容）
{{existingBrd}}

## 历史 BRD 参考
{{historicalBrds}}

历史 BRD 只用于学习结构、术语与表达习惯；其中的旧项目事实不得直接套用到当前需求。

请输出完整 BRD Markdown。`,
    },
    check: {
      system:
        "你是 BRD 评审专家。请对照 BRD 规范与项目源摘要，检查现有 BRD 的完善性。" +
        "输出必须包含前后变化对比与需求追踪链路：为每个问题分配稳定编号，" +
        "将现有 BRD 原文或现状作为「前」，将建议改写或目标状态作为「后」，且不得把建议描述成已完成变更；" +
        "追踪需求描述或项目源证据到 BRD 条款、验收标准、风险或待确认项，并关联对应问题编号。" +
        "区分明确事实、代码现状、推断与待确认内容；证据不足时标记缺口，不得编造链路。" +
        "若提供了上一版本以来的实际变更 diff，先逐条判断这些真实发生的变更是否合理、是否引入新缺口，" +
        "注意区分「已发生的实际变更」与「建议的前后对比」，不要混淆。" +
        "同时输出缺口、风险、优先级与建议补写要点，不要无根据地重写整篇 BRD。",
      user: `请检查以下 BRD 的完善性。

## 需求
名称：{{requirementName}}
描述：{{requirementDescription}}

## BRD 规范
{{brdSpec}}

## 项目源摘要
{{sourcesSummary}}

## 展示信息
官网：{{websiteUrl}}
小程序产物：{{miniprogramBuildArtifact}}

## 上一版本以来的实际变更（diff）
{{brdChangeDiff}}

## 待检查的 BRD
{{existingBrd}}

请输出检查报告（Markdown），至少包含：

1. 评审结论；
2. 本次实际变更评审（逐条判断上方 diff 中的变更是否合理、是否引入新缺口；无 diff 时说明为首次评审）；
3. 前后变化对比表（问题编号、优先级、BRD 位置、前、后、变更依据与影响）；
4. 需求追踪链路表（需求/源证据、证据类型、BRD 条款或需求编号、验收标准、风险/待确认项、关联问题编号）；
5. 缺口与风险；
6. 建议处理顺序。

第 2 项评审的是已经发生的实际变更；第 3 项的「后」仅表示建议文本或目标状态，不表示 BRD 已被修改。没有可靠依据的链路必须明确标记为「待确认」。`,
    },
  }
}

/** 空配置 */
export function createEmptyBrdDesignConfig(): ProjectBrdDesignConfig {
  return { sources: {} }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") {
    throw new Error(`${field} 必须是字符串`)
  }
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

function parsePromptTemplate(value: unknown, field: string): BrdPromptTemplate {
  if (!isPlainObject(value)) {
    throw new Error(`${field} 必须是对象`)
  }
  const system = optionalNonEmptyString(value["system"], `${field}.system`)
  const user = optionalNonEmptyString(value["user"], `${field}.user`)
  if (!system || !user) {
    throw new Error(`${field} 必须包含非空的 system 与 user`)
  }
  return { system, user }
}

function parseSources(value: unknown): BrdDesignSources {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new Error("sources 必须是对象")
  }
  const sources: BrdDesignSources = {}
  const miniprogramCodePath = optionalNonEmptyString(value["miniprogramCodePath"], "sources.miniprogramCodePath")
  const websiteCodePath = optionalNonEmptyString(value["websiteCodePath"], "sources.websiteCodePath")
  const frontendCodePath = optionalNonEmptyString(value["frontendCodePath"], "sources.frontendCodePath")
  const backendCodePath = optionalNonEmptyString(value["backendCodePath"], "sources.backendCodePath")
  const miniprogramBuildArtifact = optionalNonEmptyString(
    value["miniprogramBuildArtifact"],
    "sources.miniprogramBuildArtifact",
  )
  const websiteUrl = optionalNonEmptyString(value["websiteUrl"], "sources.websiteUrl")
  const historicalBrdPathsRaw = value["historicalBrdPaths"]
  let historicalBrdPaths: string[] | undefined
  if (historicalBrdPathsRaw !== undefined && historicalBrdPathsRaw !== null) {
    if (!Array.isArray(historicalBrdPathsRaw)) {
      throw new Error("sources.historicalBrdPaths 必须是字符串数组")
    }
    historicalBrdPaths = historicalBrdPathsRaw.map((item, index) => {
      if (typeof item !== "string" || item.trim() === "") {
        throw new Error(`sources.historicalBrdPaths[${index}] 必须是非空字符串`)
      }
      return item.trim()
    })
    historicalBrdPaths = [...new Set(historicalBrdPaths)]
  }
  if (miniprogramCodePath !== undefined) sources.miniprogramCodePath = miniprogramCodePath
  if (websiteCodePath !== undefined) sources.websiteCodePath = websiteCodePath
  if (frontendCodePath !== undefined) sources.frontendCodePath = frontendCodePath
  if (backendCodePath !== undefined) sources.backendCodePath = backendCodePath
  if (miniprogramBuildArtifact !== undefined) sources.miniprogramBuildArtifact = miniprogramBuildArtifact
  if (websiteUrl !== undefined) sources.websiteUrl = websiteUrl
  if (historicalBrdPaths && historicalBrdPaths.length > 0) {
    sources.historicalBrdPaths = historicalBrdPaths
  }
  return sources
}

/** 校验并规范化配置对象 */
export function normalizeBrdDesignConfig(raw: unknown): ProjectBrdDesignConfig {
  if (raw === undefined || raw === null) {
    return createEmptyBrdDesignConfig()
  }
  if (!isPlainObject(raw)) {
    throw new Error("brdDesign 配置必须是对象")
  }
  const config: ProjectBrdDesignConfig = {
    sources: parseSources(raw["sources"]),
  }
  const brdSpecPath = optionalNonEmptyString(raw["brdSpecPath"], "brdSpecPath")
  const brdOutputPath = optionalNonEmptyString(raw["brdOutputPath"], "brdOutputPath")
  if (brdSpecPath !== undefined) config.brdSpecPath = brdSpecPath
  if (brdOutputPath !== undefined) config.brdOutputPath = brdOutputPath

  const promptsRaw = raw["prompts"]
  if (promptsRaw !== undefined && promptsRaw !== null) {
    if (!isPlainObject(promptsRaw)) {
      throw new Error("prompts 必须是对象")
    }
    const prompts: Partial<Record<BrdPromptId, BrdPromptTemplate>> = {}
    for (const id of PROMPT_IDS) {
      if (promptsRaw[id] === undefined || promptsRaw[id] === null) continue
      prompts[id] = parsePromptTemplate(promptsRaw[id], `prompts.${id}`)
    }
    const unknownKeys = Object.keys(promptsRaw).filter((key) => !PROMPT_IDS.includes(key as BrdPromptId))
    if (unknownKeys.length > 0) {
      throw new Error(`未知提示词 id: ${unknownKeys.join(", ")}`)
    }
    if (Object.keys(prompts).length > 0) config.prompts = prompts
  }

  return config
}

/** 从 metadata 解析配置；缺省或空串返回空配置 */
export function parseBrdDesignConfigFromMetadata(
  metadata: Record<string, string> | undefined,
): ProjectBrdDesignConfig {
  const raw = metadata?.[BRD_DESIGN_METADATA_KEY]
  if (raw === undefined || raw.trim() === "") {
    return createEmptyBrdDesignConfig()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("项目 metadata.brdDesign 不是合法 JSON")
  }
  return normalizeBrdDesignConfig(parsed)
}

/** 序列化为 metadata 字符串；空配置返回 undefined（调用方可删除键） */
export function serializeBrdDesignConfig(config: ProjectBrdDesignConfig): string | undefined {
  const normalized = normalizeBrdDesignConfig(config)
  const hasSources = Object.keys(normalized.sources).length > 0
  const hasPrompts = normalized.prompts !== undefined && Object.keys(normalized.prompts).length > 0
  if (!hasSources && !normalized.brdSpecPath && !normalized.brdOutputPath && !hasPrompts) {
    return undefined
  }
  return JSON.stringify(normalized)
}

function applyStringPatch(
  current: string | undefined,
  patch: string | undefined,
): string | undefined {
  if (patch === undefined) return current
  const trimmed = patch.trim()
  return trimmed === "" ? undefined : trimmed
}

/** 深合并 patch；字符串 "" 清除对应字段；prompts[id]=null 删除该覆盖 */
export function mergeBrdDesignConfig(
  current: ProjectBrdDesignConfig,
  patch: ProjectBrdDesignConfigPatch,
): ProjectBrdDesignConfig {
  const base = normalizeBrdDesignConfig(current)
  const next: ProjectBrdDesignConfig = {
    sources: { ...base.sources },
  }

  if (patch.sources) {
    for (const key of [
      "miniprogramCodePath",
      "websiteCodePath",
      "frontendCodePath",
      "backendCodePath",
      "miniprogramBuildArtifact",
      "websiteUrl",
    ] as const) {
      if (patch.sources[key] !== undefined) {
        const value = applyStringPatch(base.sources[key], patch.sources[key])
        if (value === undefined) {
          delete next.sources[key]
        } else {
          next.sources[key] = value
        }
      }
    }
    if (patch.sources.historicalBrdPaths !== undefined) {
      const paths = patch.sources.historicalBrdPaths
        .map((item) => item.trim())
        .filter((item) => item !== "")
      if (paths.length === 0) {
        delete next.sources.historicalBrdPaths
      } else {
        next.sources.historicalBrdPaths = [...new Set(paths)]
      }
    }
  }

  const brdSpecPath = applyStringPatch(base.brdSpecPath, patch.brdSpecPath)
  const brdOutputPath = applyStringPatch(base.brdOutputPath, patch.brdOutputPath)
  if (brdSpecPath !== undefined) next.brdSpecPath = brdSpecPath
  if (brdOutputPath !== undefined) next.brdOutputPath = brdOutputPath

  const prompts: Partial<Record<BrdPromptId, BrdPromptTemplate>> = { ...(base.prompts ?? {}) }
  if (patch.prompts) {
    for (const id of PROMPT_IDS) {
      const item = patch.prompts[id]
      if (item === undefined) continue
      if (item === null) {
        delete prompts[id]
        continue
      }
      const merged = {
        ...(prompts[id] ?? buildDefaultBrdPrompts()[id]),
        ...item,
      }
      prompts[id] = parsePromptTemplate(merged, `prompts.${id}`)
    }
  }
  if (Object.keys(prompts).length > 0) next.prompts = prompts

  return normalizeBrdDesignConfig(next)
}

/** 默认提示词 ⊕ 项目覆盖 */
export function resolveBrdPrompts(
  config: ProjectBrdDesignConfig,
): Record<BrdPromptId, BrdPromptTemplate> {
  const defaults = buildDefaultBrdPrompts()
  const overrides = config.prompts ?? {}
  return {
    "summarize-sources": overrides["summarize-sources"] ?? defaults["summarize-sources"],
    generate: overrides.generate ?? defaults.generate,
    check: overrides.check ?? defaults.check,
  }
}

/** 解析有效产出路径 */
export function resolveBrdOutputPath(config: ProjectBrdDesignConfig): string {
  return config.brdOutputPath?.trim() || DEFAULT_BRD_OUTPUT_PATH
}

/** 是否配置了任一代码/展示源 */
export function hasBrdSourcesConfigured(config: ProjectBrdDesignConfig): boolean {
  const s = config.sources
  return Boolean(
    s.miniprogramCodePath ||
      s.websiteCodePath ||
      s.frontendCodePath ||
      s.backendCodePath ||
      s.miniprogramBuildArtifact ||
      s.websiteUrl,
  )
}

/** 替换 {{name}} 占位符；未知占位符保留原样 */
export function renderBrdTemplate(template: string, vars: BrdPromptVars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = vars[key as keyof BrdPromptVars]
    if (value === undefined || value === null) return ""
    return value
  })
}

/** 渲染单条提示词 */
export function renderBrdPrompt(
  template: BrdPromptTemplate,
  vars: BrdPromptVars,
): { system: string; prompt: string } {
  return {
    system: renderBrdTemplate(template.system, vars),
    prompt: renderBrdTemplate(template.user, vars),
  }
}

export const BRD_PROMPT_IDS: readonly BrdPromptId[] = PROMPT_IDS
