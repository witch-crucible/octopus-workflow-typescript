# Octopus Workflow 优化方案：宽松模式 + Agent 模式 + BRD 前后变化追踪

> 本文档为 implementation 阶段的正式优化方案，覆盖三项核心能力：需求变化宽松模式（默认提醒不拦截）、Agent 模式全流程自动化（manual 自动过+留痕）、BRD review 前后变化追踪（文件级 diff）。方案来源：plan 文件 §3 设计，结合实勘代码展开。

---

## 1. 背景与现状

### 1.1 需求变化无专用流程

当前系统对"需求变更"没有专门的失效/重跑流程，只具备以下零散能力：

- `updateRequirement(name/description/owner)`：`packages/workflow-engine/src/index.ts` 第 659–685 行，仅补丁 `requirementName/description/owner` 字段，不触发任何下游失效。
- `rollbackTo(targetPhase)`：同文件第 1610–1680 行，只翻转 `phaseStatus/currentPhase`，不重置下游 `COMPLETED` 步骤。
- `advancePhase`：同文件第 1508–1607 行，生成下一阶段步骤，不清理上一阶段残留。
- `createNode`：同文件第 1149–1192 行，只检查节点唯一性和依赖合法性。
- `workflow.yaml/overlay` 编辑 + `brd generate|optimize|check`：文件级操作，不做状态失效。

**问题**：当需求名称/描述被修改、BRD 被重新生成、或工作流定义被 overlay 替换时，已 `COMPLETED` 的下游步骤和已产出的 Artifact 仍然保持"已完成"状态，系统无任何提示或标记，导致流程与实际脱节。

### 1.2 结构严格、语义宽松

- **结构严格**：`packages/context/src/workflow.ts` 第 139–158 行的 `nodeSchema` 使用 Zod `.strict()` 校验，要求 kebab-case 英文节点键、英文 name/description；第 317–353 行的 `validateWorkflowDefinition` 检测重复节点、缺失依赖和依赖环。
- **语义宽松**：`packages/context/src/config.ts` 第 160–164 行的 `DEFAULT_CONFIG.workflow` 设置 `strictPermissions: false` + `aiGatingEnabled: false`，默认双关；`--force` 可 bypass 依赖（`packages/workflow-engine/src/execution.ts` 第 155–157 行）；`SKIPPED == done`（第 113–117 行 `allDone` 判断）；BRD 重跑不 dirty 下游。

**问题**：结构层面的严格校验与语义层面的宽松执行并存，缺乏中间态——"我知道变了，但只提醒不拦截"。

### 1.3 执行双平面

系统存在两套执行平面，互不打通：

- **`step run`（capability plane）**：`packages/workflow-engine/src/index.ts` 第 1240–1310 行 `runStepCapabilities`，同步执行 AI/集成/Heinrich 能力，无 NodeRun 记录、无日志、无事件。
- **`node run`（worker plane）**：`packages/workflow-engine/src/execution.ts` 第 139–221 行 `runNode`，detached worker 异步执行，有 NodeRun/events/logs。
- **`runWorkflow`**：同文件第 399–439 行，前台阻塞 loop，遇到 manual 节点即 `PAUSED`，`advancePhase` 需人工另调，无 daemon、无 auto-advance、无 dry-run。

**问题**：双平面导致观测性不一致；`runWorkflow` 无法自动穿越 manual 节点和阶段边界。

### 1.4 BRD/Review 无拦截

- `10.1 brd` 节点为 manual + Hermes headless（`workflow/nodes/requirements-analysis-and-brd-design/src/index.ts` 第 136–192 行 `runBrdOptimize`）。
- Reviews 全靠 `node complete [--force]` 人工签收（`packages/workflow-engine/src/execution.ts` 第 223–253 行 `completeManualNode`）。
- `ai-code-review(50.5)` fail→BLOCKED 是唯一硬门（`packages/workflow-engine/src/index.ts` 第 1286–1296 行 `crossReviewFailure`）。

**问题**：BRD 生成/优化/检查全流程无自动化拦截或辅助推进机制。

### 1.5 追踪链断裂

- `createArtifact()`：`packages/workflow-engine/src/index.ts` 第 2253–2283 行，只 `state.artifacts.push()`，不回填 `step.artifactIds`。
- `runBrdCheck`：`workflow/nodes/requirements-analysis-and-brd-design/src/index.ts` 第 194–231 行，零 Artifact 产出。
- worker ai 路径：`packages/executor/src/worker.ts` + `ai-output.ts`，零 Artifact。
- `ACTION_FINISHED.payload`：只有 500 字 summary。
- `Artifact`：`packages/core/src/artifact.ts` 第 57–80 行，无 `parentArtifactId/source{runId,eventSequence,fileHash,commitSha,sessionId}`。
- `brd.md`：覆盖写、无备份/hash。
- `ArtifactType`：同文件第 13–38 行，无 `CODE_REVIEW/RISK_REPORT/BRD_CHECK_REPORT`。
- Review 报告在 `workflow/nodes/<key>/reviews/<reqId>/`（gitignored）与 `.octo/octopus.sqlite` 审计分家。

**问题**：`node show --json` 链路断裂（`step.artifactIds` 始终为空），BRD 变化无历史可追溯。

---

## 2. 需求变化宽松模式（默认 loose，只提醒不拦截）

### 2.1 新增 `RequirementChangeMode` 类型

在 `packages/context/src/config.ts` 中扩展 `OctopusConfig.workflow`：

```typescript
// config.ts 新增类型
export type RequirementChangeMode = "loose" | "strict"

// OctopusConfig.workflow 接口扩展
export interface OctopusConfig {
  workflow: {
    strictPermissions: boolean
    aiGatingEnabled: boolean
    heinrichThreshold: number
    /** 需求变化处理模式：loose 只提醒不拦截，strict 保留现有拦截 */
    changeMode: RequirementChangeMode  // 默认 "loose"
  }
}

// DEFAULT_CONFIG 扩展
export const DEFAULT_CONFIG: OctopusConfig = {
  workflow: {
    strictPermissions: false,
    aiGatingEnabled: false,
    heinrichThreshold: 3,
    changeMode: "loose",  // 新增
  },
  // ...
}

// configFileSchema 扩展（第 110–116 行）
workflow: z.object({
  strictPermissions: z.boolean().optional(),
  aiGatingEnabled: z.boolean().optional(),
  heinrichThreshold: z.number().optional(),
  changeMode: z.enum(["loose", "strict"]).optional(),  // 新增
}).optional(),
```

### 2.2 触发点（loose 下一律不 throw）

| 触发点 | 文件位置 | 当前行为 | loose 行为 |
|--------|---------|---------|-----------|
| `WorkflowEngine.updateRequirement()` | `packages/workflow-engine/src/index.ts` 第 659–685 行 | 直接补丁字段 | 追加 `REQUIREMENT_CHANGED` 事件 + 生成影响报告 |
| `rollbackTo()` | 同文件第 1610–1680 行 | 翻转 phaseStatus | 追加 `REQUIREMENT_CHANGED` 事件 + 生成影响报告 |
| BRD 重生成/optimize | `workflow/nodes/requirements-analysis-and-brd-design/src/index.ts` 第 93–192 行（经由 `WorkflowEngine.generateBrd/optimizeBrd` 第 2893–2916 行） | 覆盖写 brd.md | 追加 `BRD_UPDATED` 事件 + 生成影响报告 |
| `workflow.yaml/overlay` 重载 | `packages/context/src/workflow.ts` 第 290–299 行 `loadResolvedWorkflowDefinition` + 第 399–404 行 `syncWorkflowWorkspace` | 直接替换定义 | 追加 `REQUIREMENT_CHANGED` 事件 + 生成影响报告 |

### 2.3 提醒载体 = 事件 + 报告

#### 2.3.1 WorkflowEvent 类型扩展

在 `packages/core/src/execution.ts` 第 145–151 行扩展：

```typescript
export interface WorkflowEvent {
  readonly type:
    | "RUN_QUEUED"
    | "RUN_STARTED"
    | "ACTION_STARTED"
    | "ACTION_FINISHED"
    | "HEARTBEAT"
    | "RUN_FINISHED"
    | "RUN_FAILED"
    | "RUN_CANCELED"
    | "INTEGRATION_HEALTH"
    | "REQUIREMENT_CHANGED"  // 新增：需求名称/描述/owner 变化
    | "BRD_UPDATED"          // 新增：BRD 文件被重生成/优化
    | "ARTIFACT_CREATED"     // 新增：制品创建
  // ...
}
```

> 复用现有 `appendEvent/eventsAfter`（`packages/workflow-engine/src/execution.ts` 第 441–455 行、第 316–318 行），`packages/context/src/sqlite-persistence.ts` 无需改表，`payload_json` 透传。

#### 2.3.2 影响报告生成

计算下游影响集 = `dependsOn` 传递闭包中仍为 `COMPLETED` 的 steps + 关联 artifacts（`state.artifacts` 按 phase/node 过滤），生成 `change-impact-report.md`：

```markdown
# 需求变化影响报告

- 触发：REQUIREMENT_CHANGED（name: "旧名" → "新名"）
- 时间：2025-01-01T00:00:00Z
- 事件序列：#42

## 受影响步骤（COMPLETED 状态）
| 节点 | 阶段 | 状态 | 依赖路径 |
|------|------|------|---------|
| 10.4-prd-design | DESIGN | COMPLETED | 10.1 → 10.4 |

## 受影响制品
| 制品 | 类型 | 阶段 | 文件路径 |
|------|------|------|---------|
| art_xxx | BRD | INTENTION | workflow/nodes/.../brd.md |

## 建议操作
- 评估是否需要重跑上述步骤
- 使用 `node show --json <nodeId>` 查看详情
```

报告落 `workflow/nodes/<key>/change-impact-report-<eventSequence>.md`，同时可选创建 Artifact（type `OTHER`，title 固定前缀 `[change-impact]` 便于过滤）。

#### 2.3.3 下游标记（不翻 COMPLETED）

不对 `COMPLETED` 翻状态（避免破坏现有语义），而是在 `StepRuntime.notes` 追加 `stale-by-change:<eventSequence>` + 报告链接：

```typescript
// 在 transactionalUpdate 中追加
step.notes = `${step.notes ?? ""} stale-by-change:${eventSequence} report:change-impact-report-${eventSequence}.md`.trim()
```

`status/show` 透出 stale 标记即可（解析 notes 中的 `stale-by-change:` 前缀）。

### 2.4 strict 语义

保留现有拦截（`checkAdvanceGate` 第 1476–1505 行 + `checkStageDependencies` 第 1433–1452 行 + `createNode` phase 检查第 1154–1173 行 + 格式校验），`changeMode: 'strict'` 时在上述触发点抛 `WorkflowError`（复用 `packages/core/src/errors.ts`，不新增错误类）。

---

## 3. Agent 模式（全流程自动化，manual 自动过+留痕）

### 3.1 `agentMode` 开关

#### 3.1.1 配置层

`packages/context/src/config.ts` 扩展：

```typescript
export interface OctopusConfig {
  workflow: {
    // ... 现有字段
    /** Agent 模式开关：AI 自动完成 manual 节点 */
    agentMode: boolean  // 默认 false
  }
}

// DEFAULT_CONFIG
workflow: {
  // ...
  agentMode: false,  // 新增
}

// configFileSchema
workflow: z.object({
  // ...
  agentMode: z.boolean().optional(),  // 新增
}).optional(),
```

#### 3.1.2 CLI 层

`packages/cli/src/commands/workflow.ts` 第 36–66 行 `workflow run` 子命令扩展：

```typescript
workflow
  .command("run")
  .description("自动并行运行所有 READY 节点")
  .argument("[requirementId]", "需求 ID")
  .option("--max-parallel <count>", "最大并发数", "4")
  .option("--force", "忽略未完成依赖")
  .option("--agent-mode", "Agent 模式：AI 自动完成 manual 节点")  // 新增
  .option("--json", "以 JSON 输出")
  .action(async (requirementId, options) => {
    // ...
    const snapshot = await engine.runWorkflow(pid, {
      maxParallel,
      force: options.force,
      agentMode: options.agentMode === true,  // 透传
    })
    // ...
  })
```

#### 3.1.3 Desktop 透参

`packages/desktop/src/main.ts` + `web.ts` IPC 白名单加 `agentMode`，`renderer/lib/octopus.ts` 透参即可（只透参，不重构视图）。

### 3.2 核心语义

#### 3.2.1 `runWorkflow({agentMode})`

`packages/workflow-engine/src/execution.ts` 第 399–439 行 `runWorkflow` 扩展：

```typescript
export interface RunWorkflowOptions {
  readonly maxParallel?: number
  readonly pollIntervalMs?: number
  readonly force?: boolean
  readonly agentMode?: boolean   // 新增：Agent 模式
  readonly autoAdvance?: boolean  // 新增：自动推进阶段
}
```

`agentMode=true` 隐含 `autoAdvance=true`：
- READY→phase advance→next READY 打通（现在 `advancePhase` 需人工另调）。
- waiting（全 manual）节点不再 park，直接走"AI 自动完成"路径。

#### 3.2.2 AI 自动完成 = `completeManualNode` 的受审计变体

在 `packages/workflow-engine/src/execution.ts` 第 223–253 行 `completeManualNode` 旁新增 `completeManualNodeAsAgent`：

```typescript
async completeManualNodeAsAgent(
  requirementId: string,
  nodeId: string,
): Promise<WorkflowState> {
  const state = await this.transactionalUpdate(requirementId, (current) => {
    const step = current.steps.find((candidate) => candidate.id === nodeId)
    if (!step) throw new Error(`节点不存在: ${nodeId}`)
    if (!(step.actions ?? []).every((action) => action.type === "manual")) {
      throw new Error(`节点 ${nodeId} 不是手动节点`)
    }
    step.status = TaskStatus.COMPLETED
    step.completedAt = new Date().toISOString()
    step.updatedAt = new Date().toISOString()
    step.completedBy = "agent"  // 新增字段：留痕
    step.notes = `[agent-auto] AI 自动完成 manual 节点`
    return current
  })
  await this.executions.appendEvent({
    requirementId,
    nodeId,
    type: "RUN_FINISHED",
    payload: { manual: true, agent: true, status: "SUCCEEDED" },  // agent 标记
    createdAt: new Date().toISOString(),
  })
  return state
}
```

调用 `AIClient.callAssistant`（`packages/agent-layer/src/index.ts`，复用现有 module；若无 prompt 模板则用 `DOCUMENT_SYNC` 兜底 + 节点 instructions 拼接，MVP 不新增 module），失败则按现有语义 `BLOCKED+notes`。

#### 3.2.3 高风险节点强制风险附件

以下节点同样自动过，但强制附加风险评估附件：

| 节点 key | 节点名称 | 风险附件类型 |
|----------|---------|-------------|
| `go-live-check 50.7a` | Go Live Check | `RELEASE_RISK_ASSESSMENT` 输出写文件 + 报告链接 |
| `magento-release-risk-assessment 50.8` | Magento Release Risk | `RELEASE_RISK_ASSESSMENT` 输出写文件 + 报告链接 |
| `sql-execution-and-risk-check 50.7` | SQL Execution & Risk | `SQL_RISK_CHECK` 输出写文件 + 报告链接 |

在最终汇总中标红（控制台输出 `\x1b[31m` 红色标记或 JSON 中 `riskLevel: "high"` 字段）。

#### 3.2.4 失败策略

单节点 `FAILED` 不 halt 整链（同层继续），最终返回 agent 运行汇总：

```typescript
interface AgentRunSummary {
  status: "COMPLETED" | "PARTIAL" | "BLOCKED"
  autoCompleted: Array<{ nodeId: string; nodeName: string; completedBy: string }>
  blocked: Array<{ nodeId: string; nodeName: string; reason: string }>
  failed: Array<{ nodeId: string; nodeName: string; error: string }>
  highRiskNodes: Array<{ nodeId: string; riskReportPath: string }>
  reportPath: string
}
```

`recoverStaleRuns`、`maxParallel/poll` 逻辑不变。

### 3.3 双平面收敛

agent 路径统一走 `node run`（worker plane，有 NodeRun/events/logs），`step run`（capability plane）不做 agent 改造。Desktop `WorkspaceView.runWorkflow()` 加 agent 开关透参即可（`renderer/lib/octopus.ts`）。

### 3.4 CLI `ai.ts` stub 不动

避免扩大范围；automation 经 `node run` / `workflow run --agent-mode` + YAML prompts 驱动。

---

## 4. BRD review 前后变化追踪（文件级 diff 为核心）

### 4.1 快照机制

在 `workflow/nodes/requirements-analysis-and-brd-design/src/index.ts` 的 `runBrdGenerate` 和 `runBrdOptimize` 中，写 `brd.md` 前执行：

```typescript
import { createHash } from "node:crypto"
import { readFileSync, copyFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

interface BrdSnapshot {
  timestamp: string
  previousSha: string  // 不存在则记 "none"
  newSha: string
  shortSha: string
  historyPath: string
}

async function snapshotBrdBeforeWrite(
  absoluteOutputPath: string,
  projectRoot: string,
): Promise<BrdSnapshot> {
  const historyDir = join(dirname(absoluteOutputPath), "history")
  mkdirSync(historyDir, { recursive: true })

  const previousSha = existsSync(absoluteOutputPath)
    ? createHash("sha256").update(readFileSync(absoluteOutputPath)).digest("hex")
    : "none"

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const shortSha = previousSha === "none" ? "initial" : previousSha.slice(0, 8)
  const historyPath = join(historyDir, `brd-${timestamp}-${shortSha}.md`)

  if (existsSync(absoluteOutputPath)) {
    copyFileSync(absoluteOutputPath, historyPath)
  }

  return { timestamp, previousSha, newSha: "", shortSha, historyPath }
}
```

### 4.2 `brd-optimization-trace.json` 字段清单

```json
{
  "runId": "run_1704067200000_abc123",
  "hermesSessionId": "ses_xyz789",
  "requirementId": "req_123",
  "skill": "brd-generator",
  "skillVersion": "1.0.0",
  "model": "claude-sonnet-4-20250514",
  "tokens": { "input": 12000, "output": 8000 },
  "cost": { "usd": 0.028 },
  "timestamps": {
    "startedAt": "2025-01-01T00:00:00Z",
    "finishedAt": "2025-01-01T00:02:30Z"
  },
  "filePaths": {
    "output": "workflow/nodes/requirements-analysis-and-brd-design/brd.md",
    "history": "workflow/nodes/requirements-analysis-and-brd-design/history/brd-2025-01-01T00-00-00Z-initial.md",
    "trace": "workflow/nodes/requirements-analysis-and-brd-design/brd-optimization-trace.json"
  },
  "fileHashes": {
    "previousSha": "none",
    "newSha": "a1b2c3d4..."
  },
  "quality": {
    "issues": 3,
    "deltas": 12,
    "stopReason": "completed"
  }
}
```

### 4.3 Artifact 链扩展

#### 4.3.1 `Artifact` 接口扩展

`packages/core/src/artifact.ts` 第 57–80 行：

```typescript
export interface Artifact {
  id: ArtifactId
  type: ArtifactType
  title: string
  description: string
  phase: Phase
  version: string
  createdBy: Role
  createdAt: string
  updatedAt: string
  filePath?: string
  content?: string
  // 新增字段
  parentArtifactId?: string  // 父制品 ID（版本链）
  source?: {
    runId?: string           // 来源运行 ID
    eventSequence?: number   // 来源事件序列
    fileHash?: string        // 文件 sha256
    commitSha?: string       // git commit SHA
    sessionId?: string       // Hermes/AI session ID
  }
}
```

#### 4.3.2 `ArtifactType` 扩展

`packages/core/src/artifact.ts` 第 13–38 行：

```typescript
export enum ArtifactType {
  // ... 现有类型
  BRD_CHECK_REPORT = "BRD_CHECK_REPORT",  // 新增
  // CODE_REVIEW / RISK_REPORT 暂用 OTHER + title 前缀，避免 migration 范围膨胀
}
```

#### 4.3.3 `createArtifact` 版本递增 + 回填 + 事件

`packages/workflow-engine/src/index.ts` 第 2253–2283 行 `createArtifact` 改为：

```typescript
async createArtifact(
  requirementId: string,
  params: {
    type: ArtifactType
    title: string
    description: string
    phase: Phase
    createdBy: Role
    content?: string
    filePath?: string
    parentArtifactId?: string  // 新增
    source?: Artifact["source"] // 新增
    stepId?: string            // 新增：回填目标步骤
  },
): Promise<WorkflowState> {
  return this.transactionalUpdate(requirementId, (current) => {
    // 版本递增：查找同 (type, title) 链的最新版本
    const siblings = current.artifacts.filter(
      (a) => a.type === params.type && a.title === params.title
    )
    const latestVersion = siblings.length > 0
      ? siblings.reduce((max, a) => {
          const v = a.version.split(".").map(Number)
          const m = max.split(".").map(Number)
          return v[0] > m[0] || (v[0] === m[0] && v[1] > m[1]) ? a.version : max
        }, "0.0.0")
      : "0.0.0"
    const [major, minor] = latestVersion.split(".").map(Number)
    const nextVersion = `${major}.${minor + 1}.0`

    const artifact: Artifact = {
      id: ArtifactId(`art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      type: params.type,
      title: params.title,
      description: params.description,
      phase: params.phase,
      version: nextVersion,  // 递增
      createdBy: params.createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(params.content !== undefined ? { content: params.content } : {}),
      ...(params.filePath !== undefined ? { filePath: params.filePath } : {}),
      ...(params.parentArtifactId !== undefined ? { parentArtifactId: params.parentArtifactId } : {}),
      ...(params.source !== undefined ? { source: params.source } : {}),
    }

    current.artifacts.push(artifact)

    // 回填 step.artifactIds（现 index.ts:1802,2078 初始化后从未追加）
    if (params.stepId) {
      const step = current.steps.find((s) => s.id === params.stepId)
      if (step) {
        step.artifactIds = [...(step.artifactIds ?? []), artifact.id]
      }
    }

    return current
  })
  // 注意：ARTIFACT_CREATED 事件在 transactionalUpdate 之后 emit
}
```

#### 4.3.4 `runBrdCheck` 注册 Artifact

`workflow/nodes/requirements-analysis-and-brd-design/src/index.ts` 第 194–231 行 `runBrdCheck` 扩展：

```typescript
export async function runBrdCheck(
  input: BrdNodeInput,
  runtime: BrdNodeRuntime,
  options?: { dryRun?: boolean },
): Promise<BrdCheckResult> {
  // ... 现有逻辑
  // 写报告后注册 Artifact
  await runtime.createArtifact(input.requirementId, {
    type: ArtifactType.BRD_CHECK_REPORT,  // 新增类型
    title: `[brd-check] ${input.requirementName}`,
    description: "BRD 完善性检查报告",
    phase: Phase.INTENTION,
    createdBy: Role.AI,
    content: response.result.slice(0, 4_000),
    filePath: reportPath,
    source: {
      fileHash: createHash("sha256").update(response.result).digest("hex"),
      sessionId: runtime.sessionId,
    },
  })
  // ...
}
```

#### 4.3.5 `ACTION_FINISHED` payload 扩展

`packages/executor/src/worker.ts` + `ai-output.ts`，ai 输出注册 Artifact（含 `fileHash`），code-review 额外记录 `git rev-parse HEAD + git diff --stat` 进 `ACTION_FINISHED.payload`：

```typescript
// worker.ts executeAction 中
const payload: Record<string, unknown> = {
  summary: result.summary.slice(0, 500),  // 保留现有
  // 新增字段
  hashes: {
    outputSha: createHash("sha256").update(outputContent).digest("hex"),
  },
  commit: await execSync("git rev-parse HEAD").toString().trim(),
  diffStat: await execSync("git diff --stat HEAD~1").toString(),
  sessionId: aiResponse.sessionId,
}
```

> `ai-code-review` YAML 不加 `input`，worker 侧取 git 上下文，避免改 YAML schema。

### 4.4 查询能力

#### 4.4.1 CLI `brd history/diff`

`packages/cli/src/commands/brd.ts` 新增子命令：

```typescript
// brd history：列出 BRD 快照历史
brd
  .command("history")
  .description("列出 BRD 生成/优化历史")
  .argument("[requirementId]", "需求 ID")
  .option("--json", "以 JSON 格式输出")
  .action(async (requirementId, options) => {
    // 读取 history/ 目录 + brd-optimization-trace.json
    // 输出：时间戳、sha、token 消耗、quality 摘要
  })

// brd diff：对比两个版本
brd
  .command("diff")
  .description("对比 BRD 两个版本")
  .argument("[requirementId]", "需求 ID")
  .option("--from <sha>", "起始版本 sha")
  .option("--to <sha>", "目标版本 sha（默认最新）")
  .action(async (requirementId, options) => {
    // 读取 history/ 中对应文件，输出 unified diff 或统计
  })
```

#### 4.4.2 `node show --json` 查询

已有 `artifactIds+capabilityRuns+runs` 直接受益（`step.artifactIds` 回填后自动关联）。

### 4.5 目录约定

```
workflow/nodes/requirements-analysis-and-brd-design/
├── brd.md                          # 当前 BRD（覆盖写）
├── brd-optimization-trace.json     # 最新 trace
├── history/
│   ├── brd-2025-01-01T00-00-00Z-initial.md
│   ├── brd-2025-01-02T12-00-00Z-a1b2c3d4.md
│   └── ...
└── change-impact-report-42.md      # 需求变化影响报告（如适用）
```

---

## 5. 文件变更清单

### 5.1 变更清单表（plan §4 的 12 项）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `packages/core/src/execution.ts` | `WorkflowEvent.type` += `REQUIREMENT_CHANGED/BRD_UPDATED/ARTIFACT_CREATED` |
| 2 | `packages/core/src/artifact.ts` | `Artifact` += `parentArtifactId/source`；`ArtifactType` += `BRD_CHECK_REPORT` |
| 3 | `packages/context/src/config.ts` | `workflow` += `changeMode:'loose'`、`agentMode:false` 默认 |
| 4 | `packages/workflow-engine/src/index.ts` | `updateRequirement/rollbackTo/generateBrd|optimizeBrd/createArtifact/advancePhase`（loose 事件+报告；artifact 版本递增+回填+事件；agent autoAdvance） |
| 5 | `packages/workflow-engine/src/execution.ts` | `runWorkflow({agentMode,autoAdvance})` + AI 自动完成 manual（含 `completedBy:'agent'` 留痕 + 高风险附件 + continueOnError 汇总） |
| 6 | `packages/context/src/workflow.ts` | overlay/definition 重载时 loose 只报告不拦截 |
| 7 | `workflow/nodes/requirements-analysis-and-brd-design/src/index.ts` | 写前快照 + `brd-optimization-trace.json` + check 注册 Artifact |
| 8 | `packages/executor/src/worker.ts` + `ai-output.ts` | ai 输出注册 Artifact；`ACTION_FINISHED.payload` += hashes/session/commit/diff-stat |
| 9 | `packages/cli/src/commands/workflow.ts, brd.ts` | `--agent-mode`；`brd history/diff` |
| 10 | `packages/desktop/src/main.ts, web.ts, renderer/lib/octopus.ts` | IPC 白名单 + UI 开关透参 `agentMode`（只透参，不重构视图） |
| 11 | `docs/optimization-loose-agent-brd-trace.md` | **本文档** |
| 12 | 各包 `*.test.ts`（沿现有同目录 `*.test.ts` + Vitest 约定） | changeMode loose/strict、agent auto-complete 留痕、快照+artifact 链回归测试 |

### 5.2 不碰清单

- `sqlite` 表结构（`payload_json` 透传，无需 migration）
- `ai.ts` stub（避免扩大范围）
- `workflow/shared/`（保持为空，不引入共享库）
- `spec.ts` 九阶段定义
- `hermes/skills/brd-generator` Skill 合约
- `pnpm-lock.yaml`、`dist/`、`node_modules/`、`.octo/`

### 5.3 验证步骤

#### 5.3.1 自动化验证

```bash
pnpm build   # TypeScript 编译通过
pnpm test    # 新增回归测试必过
pnpm lint    # ESLint/Prettier 通过
pnpm verify  # repo AGENTS.md 约定（build+test+lint 聚合）
```

#### 5.3.2 手动验证（4 项）

1. **BRD 二次 optimize → 快照+trace+artifact 链+diff 可读**
   ```bash
   octopus brd optimize <requirementId>   # 首次生成
   octopus brd optimize <requirementId>   # 二次优化
   octopus brd history <requirementId>    # 应列出 2+ 条记录
   octopus brd diff <requirementId>       # 应输出版本间差异
   octopus node show <nodeId> --json      # artifactIds 应非空
   ```

2. **`updateRequirement` loose 下流程不中断且有事件+影响报告**
   ```bash
   octopus requirement update <id> --name "新名称"
   octopus requirement events <id>    # 应包含 REQUIREMENT_CHANGED
   ls workflow/nodes/*/change-impact-report-*.md  # 应存在
   ```

3. **`workflow run --agent-mode` 全绿到 COMPLETED，manual 节点均有留痕**
   ```bash
   octopus workflow run <id> --agent-mode --json
   # 检查输出：autoCompleted 包含 manual 节点，completedBy=agent
   octopus node show <manualNodeId> --json  # notes 含 [agent-auto]
   ```

4. **`changeMode:'strict'` 切回后原拦截恢复**
   ```bash
   # 修改 .octo/config.json: workflow.changeMode = "strict"
   octopus requirement update <id> --name "另一名称"
   # 应抛出 WorkflowError 或阶段拦截
   ```

#### 5.3.3 变更范围确认

```bash
git diff --stat  # 确认仅包含上述 12 项文件
git status --short  # 确认无 dist/node_modules/.octo 及锁文件意外改动
```

---

## 附录 A：关键文件与函数速查

| 文件 | 函数/位置 | 当前职责 | 改动要点 |
|------|----------|---------|---------|
| `packages/core/src/execution.ts:145` | `WorkflowEvent.type` | 事件类型定义 | 新增 3 种事件类型 |
| `packages/core/src/artifact.ts:57` | `Artifact` 接口 | 制品模型 | 新增 `parentArtifactId/source` |
| `packages/core/src/artifact.ts:13` | `ArtifactType` 枚举 | 制品类型 | 新增 `BRD_CHECK_REPORT` |
| `packages/context/src/config.ts:160` | `DEFAULT_CONFIG.workflow` | 默认配置 | 新增 `changeMode/agentMode` |
| `packages/workflow-engine/src/index.ts:659` | `updateRequirement` | 需求更新 | loose 追加事件+报告 |
| `packages/workflow-engine/src/index.ts:1610` | `rollbackTo` | 阶段回退 | loose 追加事件+报告 |
| `packages/workflow-engine/src/index.ts:2253` | `createArtifact` | 制品创建 | 版本递增+回填+事件 |
| `packages/workflow-engine/src/index.ts:2893` | `generateBrd/optimizeBrd` | BRD 生成 | 追加 BRD_UPDATED 事件 |
| `packages/workflow-engine/src/execution.ts:223` | `completeManualNode` | 手动完成 | 新增 agent 变体 |
| `packages/workflow-engine/src/execution.ts:399` | `runWorkflow` | 工作流调度 | 新增 agentMode/autoAdvance |
| `packages/context/src/workflow.ts:290` | `loadResolvedWorkflowDefinition` | 定义加载 | loose 只报告不拦截 |
| `workflow/nodes/.../index.ts:93` | `runBrdGenerate/runBrdOptimize` | BRD 生成 | 写前快照+trace |
| `workflow/nodes/.../index.ts:194` | `runBrdCheck` | BRD 检查 | 注册 Artifact |
| `packages/cli/src/commands/workflow.ts:36` | `workflow run` CLI | 运行入口 | 新增 `--agent-mode` |
| `packages/cli/src/commands/brd.ts:36` | `buildBrdCommands` | BRD 命令 | 新增 `history/diff` |

---

## 附录 B：状态机示意

### B.1 需求变化处理

```
                    ┌─────────────────────────────────────┐
                    │         需求变化触发点               │
                    │  updateRequirement / rollbackTo /    │
                    │  BRD regenerate / overlay reload     │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │     config.workflow.changeMode?      │
                    └──────┬──────────────────┬───────────┘
                           │                  │
                      loose │             strict │
                           │                  │
              ┌────────────▼────────┐  ┌──────▼──────────────┐
              │ 1. 正常执行原逻辑   │  │ 1. 正常执行原逻辑    │
              │ 2. 追加事件        │  │ 2. 抛 WorkflowError  │
              │ 3. 生成影响报告    │  │    (拦截)            │
              │ 4. 下游 notes 标记 │  └──────────────────────┘
              │    stale           │
              └────────────────────┘
```

### B.2 Agent 模式 manual 节点处理

```
┌──────────────────────────────────────────────────────────────┐
│              runWorkflow({ agentMode: true })                 │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 1. recoverStaleRuns                                     │ │
│  │ 2. getSnapshot → readyNodeIds + waitingNodeIds          │ │
│  │ 3. 对 readyNodeIds → runNode (worker plane)             │ │
│  │ 4. 对 waitingNodeIds (全 manual):                       │ │
│  │    ├─ 高风险节点 → AI 自动完成 + 强制风险附件 + 标红    │ │
│  │    └─ 普通 manual → AI 自动完成 (completedBy: agent)    │ │
│  │ 5. activeRuns=0 && readyNodeIds=0?                      │ │
│  │    ├─ 否 → 继续轮询                                     │ │
│  │    └─ 是 → 返回 AgentRunSummary                         │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### B.3 BRD 快照与 trace 流程

```
┌──────────────────────────────────────────────────────────────┐
│              runBrdGenerate / runBrdOptimize                  │
│                                                              │
│  1. gather(input) → context                                  │
│  2. renderPrompts → promptsUsed                              │
│  3. callAssistant / runHermesSkill → response                │
│  4. snapshotBrdBeforeWrite:                                  │
│     ├─ 计算旧文件 sha256 (不存在则 "none")                   │
│     ├─ 拷贝到 history/brd-<ts>-<shortsha>.md                 │
│     └─ 返回 snapshot 元数据                                  │
│  5. writeFileSync(brd.md)                                    │
│  6. 计算新文件 sha256                                        │
│  7. 写 brd-optimization-trace.json                           │
│  8. createArtifact (type=BRD, source.fileHash=newSha)        │
│  9. emit BRD_UPDATED 事件                                    │
└──────────────────────────────────────────────────────────────┘
```

---

## 附录 C：回滚策略

若 implementation 发现 `step.artifactIds` 回填有并发冲突（`runStepCapabilities` 第 1304–1309 行已有 optimistic-concurrency guard），沿用同一 guard 重试：

```typescript
// 在 createArtifact 的事务中
return this.transactionalUpdate(requirementId, (current) => {
  // ... 创建 artifact
  if (params.stepId) {
    const step = current.steps.find((s) => s.id === params.stepId)
    if (step) {
      step.artifactIds = [...(step.artifactIds ?? []), artifact.id]
    }
  }
  return current
})
// transactionalUpdate 内部已有乐观并发校验，冲突时抛错由调用方重试
```

其他回滚点：
- `changeMode` 默认 `loose`，用户可随时切回 `strict` 恢复拦截。
- `agentMode` 默认 `false`，需显式开启，不影响现有流程。
- `Artifact` 新增字段均为 optional，旧数据兼容。
- `brd-optimization-trace.json` 为追加文件，不影响现有 BRD 读取。
