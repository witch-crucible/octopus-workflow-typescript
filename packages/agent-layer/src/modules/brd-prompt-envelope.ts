/**
 * BRD 提示词 envelope —— 兼容 AIAssistantModule 单字符串 input。
 *
 * 合法 JSON `{ "system": "...", "prompt": "..." }` 时拆开调用；
 * 否则整段作为 user prompt，使用模块默认 system。
 */

import type { AIRequest } from "@octopus/core/agent.js"

export interface BrdPromptEnvelope {
  system: string
  prompt: string
}

export function parseBrdPromptEnvelope(input: string, fallbackSystem: string): AIRequest {
  const trimmed = input.trim()
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { system?: unknown }).system === "string" &&
        typeof (parsed as { prompt?: unknown }).prompt === "string" &&
        (parsed as { system: string }).system.trim() !== "" &&
        (parsed as { prompt: string }).prompt.trim() !== ""
      ) {
        return {
          system: (parsed as { system: string }).system,
          prompt: (parsed as { prompt: string }).prompt,
        }
      }
    } catch {
      // fall through to plain text
    }
  }
  return { system: fallbackSystem, prompt: input }
}
