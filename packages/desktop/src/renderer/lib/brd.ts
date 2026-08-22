import { BRD_PROMPT_IDS } from "./labels.js"

export type BrdPromptDraft = {
  system: string
  user: string
}

export type BrdPromptPatchResult =
  | { prompts: Record<string, BrdPromptDraft | null>; invalid?: undefined }
  | {
      prompts: Record<string, BrdPromptDraft | null>
      invalid: { id: string; hasSystem: boolean; hasUser: boolean }
    }

export function collectBrdPromptPatch(
  drafts: Readonly<Record<string, BrdPromptDraft | undefined>>,
  clearedIds: readonly string[],
): BrdPromptPatchResult {
  const prompts: Record<string, BrdPromptDraft | null> = {}
  for (const id of BRD_PROMPT_IDS) {
    if (clearedIds.includes(id)) {
      prompts[id] = null
      continue
    }
    const draft = drafts[id]
    if (!draft) continue
    const hasSystem = draft.system.trim() !== ""
    const hasUser = draft.user.trim() !== ""
    if (!hasSystem || !hasUser) {
      return { prompts, invalid: { id, hasSystem, hasUser } }
    }
    prompts[id] = draft
  }
  return { prompts }
}
