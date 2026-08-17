/**
 * 插件加载器 —— 解析本地路径或 node_modules 包，调用 activate，收集 overlay 与注册项。
 */

import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { aiAssistantModuleRegistry } from "@octopus/agent-layer/modules/registry.js"
import type { IntegrationService } from "@octopus/integration/index.js"
import type {
  CapabilityHandler,
  LoadedPlugin,
  OctopusPlugin,
  PluginHost,
  PluginRef,
  WorkflowOverlay,
} from "./types.js"

export function emptyPluginHost(): PluginHost {
  return {
    plugins: [],
    overlays: [],
    integrations: {},
    customHandlers: new Map(),
    kindHandlers: new Map(),
  }
}

export interface LoadPluginsOptions {
  readonly projectRoot: string
}

interface NormalizedPluginRef {
  readonly id?: string
  readonly path?: string
  readonly package?: string
  readonly enabled: boolean
  readonly options: Readonly<Record<string, unknown>>
}

function normalizeRef(ref: PluginRef): NormalizedPluginRef {
  if (typeof ref === "string") {
    const isPath = ref.startsWith(".") || isAbsolute(ref)
    return isPath
      ? { path: ref, enabled: true, options: {} }
      : { package: ref, enabled: true, options: {} }
  }
  return {
    ...(ref.id !== undefined ? { id: ref.id } : {}),
    ...(ref.path !== undefined ? { path: ref.path } : {}),
    ...(ref.package !== undefined ? { package: ref.package } : {}),
    enabled: ref.enabled !== false,
    options: ref.options ?? {},
  }
}

function isPlugin(value: unknown): value is OctopusPlugin {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<OctopusPlugin>
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && typeof candidate.version === "string"
    && typeof candidate.activate === "function"
}

function readPluginExport(moduleExport: unknown, source: string): OctopusPlugin {
  if (!moduleExport || typeof moduleExport !== "object") {
    throw new Error(`插件 ${source} 缺少 default 或 octopusPlugin 导出`)
  }
  const record = moduleExport as Record<string, unknown>
  const candidates = [record["default"], record["octopusPlugin"]]
  for (const candidate of candidates) {
    if (isPlugin(candidate)) return candidate
    if (candidate && typeof candidate === "object") {
      const nested = (candidate as Record<string, unknown>)["default"]
      if (isPlugin(nested)) return nested
      if (isPlugin((candidate as Record<string, unknown>)["octopusPlugin"])) {
        return (candidate as Record<string, unknown>)["octopusPlugin"] as OctopusPlugin
      }
    }
  }
  throw new Error(`插件 ${source} 缺少 default 或 octopusPlugin 导出`)
}

function resolvePluginHref(ref: NormalizedPluginRef, projectRoot: string): string {
  if (ref.path) {
    const absolute = isAbsolute(ref.path) ? ref.path : resolve(projectRoot, ref.path)
    if (!existsSync(absolute)) throw new Error(`插件路径不存在: ${absolute}`)
    return pathToFileURL(absolute).href
  }
  if (ref.package) {
    const require = createRequire(join(projectRoot, "package.json"))
    try {
      return pathToFileURL(require.resolve(ref.package)).href
    } catch (cause) {
      throw new Error(`无法解析插件包: ${ref.package}`, { cause })
    }
  }
  throw new Error("插件引用必须提供 path 或 package")
}

function pluginLabel(ref: NormalizedPluginRef, fallback: string): string {
  return ref.id ?? ref.package ?? ref.path ?? fallback
}

/** 按配置顺序加载插件。空列表返回空宿主，不读磁盘。 */
export async function loadPlugins(
  refs: readonly PluginRef[],
  options: LoadPluginsOptions,
): Promise<PluginHost> {
  if (refs.length === 0) return emptyPluginHost()

  const plugins: LoadedPlugin[] = []
  const overlays: WorkflowOverlay[] = []
  const integrations: Record<string, IntegrationService> = {}
  const customHandlers = new Map<string, CapabilityHandler>()
  const kindHandlers = new Map<string, CapabilityHandler>()

  for (const raw of refs) {
    const ref = normalizeRef(raw)
    if (!ref.enabled) continue
    const href = resolvePluginHref(ref, options.projectRoot)
    const label = pluginLabel(ref, href)
    let moduleExport: unknown
    try {
      moduleExport = await import(href)
    } catch (cause) {
      throw new Error(`无法加载插件: ${label}`, { cause })
    }
    const plugin = readPluginExport(moduleExport, label)
    await plugin.activate({
      projectRoot: options.projectRoot,
      options: ref.options,
      contributeOverlay(overlay) {
        overlays.push(overlay)
      },
      registerAIModule(module) {
        if (aiAssistantModuleRegistry.has(module.type)) {
          throw new Error(`插件 ${plugin.id} 不能覆盖已注册 AI 模块: ${module.type}`)
        }
        aiAssistantModuleRegistry.register(module)
      },
      registerIntegration(service) {
        if (integrations[service.name]) {
          throw new Error(`插件 ${plugin.id} 重复注册集成: ${service.name}`)
        }
        integrations[service.name] = service
      },
      registerCapability(kind, handler) {
        if (kind === "ai" || kind === "heinrich") {
          throw new Error(`禁止覆盖内置能力: ${kind}`)
        }
        if (kind === "custom") {
          throw new Error("请用自定义能力名称注册，不要覆盖 custom 分发器")
        }
        if (kind === "integration") {
          kindHandlers.set(kind, handler)
          return
        }
        if (customHandlers.has(kind)) {
          throw new Error(`自定义能力重复注册: ${kind}`)
        }
        customHandlers.set(kind, handler)
      },
    })
    plugins.push({ id: plugin.id, version: plugin.version })
  }

  return { plugins, overlays, integrations, customHandlers, kindHandlers }
}
