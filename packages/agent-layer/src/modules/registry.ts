/**
 * AI 模块注册表 —— 12 类 AI 辅助能力的集中装配与查询。
 *
 * 注册表在模块加载时装配全部 AIAssistantType，`callAssistant` 按类型查找并执行。
 * 缺少注册视为开发错误，不再回退到通用提示词。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIResponse } from "@octopus/core/agent.js"
import type { AIAssistantClient, AIAssistantModule } from "./types.js"
import { checklistRecommendationModule } from "./checklist-recommendation.js"
import { codeReviewModule } from "./code-review.js"
import { documentSyncModule } from "./document-sync.js"
import { effortEstimationModule } from "./effort-estimation.js"
import { meetingMinutesModule } from "./meeting-minutes.js"
import { releaseRiskAssessmentModule } from "./release-risk-assessment.js"
import { requirementsAnalysisModule } from "./requirements-analysis.js"
import { setupChecklistCheckModule } from "./setup-checklist-check.js"
import { sqlRiskCheckModule } from "./sql-risk-check.js"
import { techDebtQuantificationModule } from "./tech-debt-quantification.js"
import { techDesignReviewModule } from "./tech-design-review.js"
import { testScriptGenerationModule } from "./test-script-generation.js"

/** AI 模块注册表 */
export class AIAssistantModuleRegistry {
  private readonly modules = new Map<AIAssistantType, AIAssistantModule>()

  /** 注册模块（重复注册视为开发错误） */
  register(module: AIAssistantModule): void {
    if (this.modules.has(module.type)) {
      throw new Error(`AI 模块重复注册: ${module.type}`)
    }
    this.modules.set(module.type, module)
  }

  /** 按类型获取模块（未注册视为开发错误） */
  get(type: AIAssistantType): AIAssistantModule {
    const module = this.modules.get(type)
    if (!module) {
      throw new Error(`AI 模块未注册: ${type}`)
    }
    return module
  }

  /** 独立执行模块 */
  async execute(type: AIAssistantType, input: string, client: AIAssistantClient): Promise<AIResponse> {
    return this.get(type).execute(input, client)
  }

  /** 已注册模块列表 */
  list(): readonly AIAssistantModule[] {
    return [...this.modules.values()]
  }
}

/** 默认注册表 —— 集中装配 12 类能力 */
export const aiAssistantModuleRegistry = new AIAssistantModuleRegistry()
aiAssistantModuleRegistry.register(meetingMinutesModule)
aiAssistantModuleRegistry.register(requirementsAnalysisModule)
aiAssistantModuleRegistry.register(effortEstimationModule)
aiAssistantModuleRegistry.register(setupChecklistCheckModule)
aiAssistantModuleRegistry.register(techDesignReviewModule)
aiAssistantModuleRegistry.register(documentSyncModule)
aiAssistantModuleRegistry.register(checklistRecommendationModule)
aiAssistantModuleRegistry.register(codeReviewModule)
aiAssistantModuleRegistry.register(testScriptGenerationModule)
aiAssistantModuleRegistry.register(sqlRiskCheckModule)
aiAssistantModuleRegistry.register(releaseRiskAssessmentModule)
aiAssistantModuleRegistry.register(techDebtQuantificationModule)

/** 按类型获取模块（未注册视为开发错误） */
export function getAIAssistantModule(type: AIAssistantType): AIAssistantModule {
  return aiAssistantModuleRegistry.get(type)
}

/** 独立执行模块 */
export function executeAIAssistantModule(
  type: AIAssistantType,
  input: string,
  client: AIAssistantClient,
): Promise<AIResponse> {
  return aiAssistantModuleRegistry.execute(type, input, client)
}
