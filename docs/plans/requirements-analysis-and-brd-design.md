# Plan: requirements-analysis-and-brd-design（按项目配置的 AI 生成/检查 BRD）

> 给实现代理的可执行设计。  
> 日期：2026-08-19  
> 状态：Ready for implementation  
> 范围：`packages/core` · `packages/agent-layer` · `packages/workflow-engine` · `packages/cli` · `packages/desktop` · `workflow.yaml` · `workflow/nodes/requirements-analysis-and-brd-design/`  
> 约束：最小改动；沿用 Project.metadata / OmniPlan 设置模式与 AIAssistantModule 契约；不虚构外部仓库爬虫；提示词可按项目覆盖。

---

## 1. 目标与成功标准

按节点 README，把 `requirements-analysis-and-brd-design`（节点 `10.1`）从纯 Manual 升级为：**按项目配置采集上下文 → 用可配置提示词包驱动 AI → 生成 BRD 或检查 BRD 完善性**。

README 要求的输入/产出：

| 分类 | 字段 | 说明 |
| --- | --- | --- |
| 代码 | 小程序 / 官网 / 前端 / 后端代码路径 | 项目级可配，路径相对项目根或绝对路径 |
| 展示 | 小程序编译产物路径、官网展示域名 | 项目级可配 |
| 规范 | BRD 规范文件路径 | 项目级可配；缺省用内置默认规范摘要 |
| 产出 | BRD 地址（输出路径） | 项目级可配；缺省写到节点工作目录 `brd.md` |

用户已确认：

- **交付**：设计文档 + PR 计划（本文件即为实现方案；实施按下方 PR Plan 拆分）。
- **配置范围**：README 四类全配。
- **提示词**：可配置 prompt 模板 + **generate-brd / check-brd** 两套（一组可命名提示词，均可按项目覆盖）。

成功标准（全部满足才算完成）：

1. 项目可读写完整 BRD 源配置（代码四路径 + 展示两项 + 规范路径 + 产出路径），持久化在 `Project.metadata`，未配置时不影响现有行为。
2. 项目可覆盖一组命名提示词模板（至少含 `generate`、`check`；可扩展如 `summarize-sources`）；未覆盖时使用内置默认模板。
3. 提供引擎 API + CLI（及设置页）完成：配置读写、**生成提示词预览**、**生成 BRD**、**检查 BRD**。
4. 节点 `requirements-analysis-and-brd-design` 在 `workflow.yaml` 中声明 AI 动作（或等价可执行能力），`node run` / 专用 CLI 可触发 generate 或 check；结果写入配置的 BRD 产出路径，并登记 `ArtifactType.BRD`。
5. AI 模块不依赖工作流状态对象本身：上下文由调用方根据项目配置组装后以文本传入（符合现有 `AIAssistantModule` 契约）。
6. 验证：`pnpm -r build`、相关单测通过；Web 设置页手动验证配置读写与提示词预览（若本迭代包含 UI）。

### 非目标

- 不自动 clone/拉取远程 Git；只读本地已配置路径。
- 不做全仓库无界扫描；首期对每个代码路径做**有界摘要**（见 §3.4），避免 prompt 爆限。
- 不替换现有 `REQUIREMENTS_ANALYSIS`（节点 `10.9`，面向 PRD 分解）；BRD 能力是独立助手类型。
- 不强制 PM 只能用 AI：保留人工编辑 BRD 文件后只跑 `check` 的路径。
- 不在本期改动 `brd-walkthrough` 及后续依赖链语义。

---

## 2. 现状（实现前必须对照）

| 项 | 现在 | 位置 |
| --- | --- | --- |
| 节点 README | Manual；补充「结合小程序/官网/前后端代码生成或检查 BRD」及配置注释 | `workflow/nodes/requirements-analysis-and-brd-design/README.md` |
| DAG 定义 | `actions: [{ type: manual }]` | `workflow.yaml` L54–62 |
| Spec 步骤 | `10.1` 无 capabilities | `packages/core/src/spec.ts` |
| Project 扩展点 | `metadata?: Record<string, string>`；OmniPlan 已用同模式 | `packages/core/src/project.ts` |
| AI 模块契约 | `execute(input: string, client)`；注册表装 12 类 | `packages/agent-layer/src/modules/*` |
| 现有需求分析 | 面向 **PRD** 分解，非 BRD | `requirements-analysis.ts` |
| 节点 AI 执行 | worker 调 `callAssistant(assistant, input)`，可写 `outputFile` | `packages/executor/src/worker.ts` |
| Artifact | 已有 `ArtifactType.BRD` | `packages/core/src/artifact.ts` |
| 设置页模式 | `setProjectOmniPlanMeta` + `renderProjectSettings` | desktop web/renderer |

---

## 3. 设计

### 3.1 项目配置模型

在 `packages/core` 新增类型与序列化约定（metadata 仍是 `Record<string, string>`，复杂结构用 **单个 JSON 字符串键**，与 `omniplanIdMap` 一致）：

**Metadata 键**：`brdDesign`（JSON）

```ts
/** 项目级 BRD 设计配置 */
interface ProjectBrdDesignConfig {
  sources: {
    miniprogramCodePath?: string
    websiteCodePath?: string
    frontendCodePath?: string
    backendCodePath?: string
    miniprogramBuildArtifact?: string  // 小程序编译产物
    websiteUrl?: string                // 官网展示域名
  }
  brdSpecPath?: string                 // BRD 规范文件
  brdOutputPath?: string               // BRD 产出地址（相对项目根或绝对）
  /** 可覆盖的提示词模板；缺省键使用内置默认 */
  prompts?: Partial<Record<BrdPromptId, BrdPromptTemplate>>
}

type BrdPromptId =
  | "summarize-sources"  // 可选：先摘要各代码源
  | "generate"           // 生成 BRD
  | "check"              // 检查完善性

interface BrdPromptTemplate {
  system: string
  /** 支持占位符，见 §3.3 */
  user: string
}
```

默认值（未配置时）：

- `brdOutputPath` → `workflow/nodes/requirements-analysis-and-brd-design/brd.md`
- `brdSpecPath` → 内置默认规范文本（常量，不强制文件存在）
- `prompts` → 内置三套默认模板
- `sources` 全空：允许只基于需求描述 + 规范生成/检查，但 CLI 应警告「未配置代码源」

校验规则：

- 路径字段：非空字符串；相对路径相对**需求的 `projectRoot`**（与 workflow 目录一致）；不要求实现时路径必须存在（生成提示词可标 missing；执行 AI 时对 missing 路径跳过并记入上下文）。
- `websiteUrl`：可选 URL/域名字符串，宽松校验（非空即可）。
- `prompts.*.system/user`：非空字符串。

引擎 API（仿 `setProjectOmniPlanMeta`）：

```ts
getProjectBrdDesignConfig(projectId): ProjectBrdDesignConfig
setProjectBrdDesignConfig(projectId, patch: DeepPartial<ProjectBrdDesignConfig>): Project
```

- `patch` 深合并；显式 `null`/空对象可清除子字段（实现时约定：`sources.miniprogramCodePath: ""` 表示删除该键）。
- 非法 JSON / 校验失败抛可读错误，不写库。

### 3.2 AI 助手类型与模块

新增内置助手（扩展枚举 + 注册表，**不占用/不覆盖**原 12 类语义）：

| Type | 用途 |
| --- | --- |
| `BRD_GENERATE` | 根据上下文生成/重写 BRD |
| `BRD_CHECK` | 根据规范与源上下文检查现有 BRD 完善性 |

实现文件：

- `packages/core/src/agent.ts` — 枚举与中文标签
- `packages/agent-layer/src/modules/brd-generate.ts`
- `packages/agent-layer/src/modules/brd-check.ts`
- `registry.ts` 注册

模块仍只接收**已渲染好的** `input`（及可选通过约定：input 首段可含 system 覆盖——**不推荐**）。更好做法：

**提示词渲染在模块外完成**（engine/CLI 层），模块使用默认 system，或扩展模块接口支持可选 `system`——为最小改动：

推荐路径（兼容现有 `execute(input, client)`）：

1. Engine 用项目模板渲染出 `{ system, prompt }`。
2. 新增薄封装 `client.ask({ system, prompt })` 的专用模块：若 `input` 为 JSON envelope：

```json
{ "system": "...", "prompt": "..." }
```

模块检测到合法 envelope 则拆开调用；否则把整段当 user prompt，用内置 system。这样不改 `AIAssistantModule` 契约，worker/`callAssistant` 仍传单字符串。

测试：单元测 envelope 解析、默认 system 回退、注册完整性。

### 3.3 提示词包（一组可配置提示词）

内置默认提示词（中文，可被项目覆盖）至少三套：

1. **`summarize-sources`**（可选前置）  
   - 输入：单源文件树/关键文件摘要  
   - 输出：该源与需求相关的能力要点  
2. **`generate`**  
   - 角色：资深 PM / BRD 作者  
   - 要求：按 BRD 规范结构输出完整 Markdown BRD；结合代码与展示信息；标明假设与待确认项  
3. **`check`**  
   - 角色：BRD 评审  
   - 要求：对照规范与源上下文，输出缺口列表、风险、优先级建议；不要无根据地重写全文（除非用户后续要求）

**占位符**（在 `user` 模板中替换）：

| 占位符 | 含义 |
| --- | --- |
| `{{requirementName}}` | 需求名 |
| `{{requirementDescription}}` | 需求描述 |
| `{{brdSpec}}` | 规范全文或默认规范 |
| `{{sourcesSummary}}` | 各代码/展示源的有界摘要 |
| `{{existingBrd}}` | 已有 BRD 内容（check / 增量 generate） |
| `{{websiteUrl}}` | 官网域名 |
| `{{miniprogramBuildArtifact}}` | 产物路径说明 |

提供纯函数：

```ts
renderBrdPrompt(template, vars): { system: string; prompt: string }
buildDefaultBrdPrompts(): Record<BrdPromptId, BrdPromptTemplate>
resolveBrdPrompts(config): Record<BrdPromptId, BrdPromptTemplate> // 默认 ⊕ 覆盖
```

「生成一组提示词」对外行为：

- `previewBrdPrompts(projectId, requirementId, mode)` → 返回已渲染的 `{ id, system, prompt }[]`（不调用 AI）。
- CLI：`octopus brd prompts` 打印或 `--json` 输出；可 `--write` 写到节点目录 `prompts/` 便于人工改后再跑。

### 3.4 上下文采集（有界）

新增 `packages/workflow-engine`（或小模块 `packages/agent-layer` 旁的纯函数包内 helper）`gatherBrdSourceContext(config, projectRoot)`：

对每个已配置代码路径：

- 若路径不存在 → 记 `missing: true`
- 否则收集：顶层目录列表 + 有限个「高信号」文件内容片段（如 `README*`、`package.json`、路由/页面入口名）；单源字符上限（建议 8–12KB）、全局上限（建议 40–60KB），超出截断并标注。

展示源：

- `miniprogramBuildArtifact`：存在则列目录/关键文件名；不读大二进制。
- `websiteUrl`：只把 URL 字符串写入上下文（首期**不**抓取网页）。

规范：

- 读 `brdSpecPath` 文本；失败则用内置默认规范。

已有 BRD：

- 读 `brdOutputPath`（或节点默认路径）；不存在则 `existingBrd` 为空。

### 3.5 编排：生成 / 检查

引擎方法：

```ts
previewBrdPrompts(projectId, requirementId, options?: { includeSummarize?: boolean }): BrdRenderedPrompt[]
generateBrd(projectId, requirementId, options?: { dryRun?: boolean }): { outputPath: string; result: string; promptsUsed: ... }
checkBrd(projectId, requirementId, options?: { dryRun?: boolean }): { reportPath: string; result: string; promptsUsed: ... }
```

流程：

**generate**

1. Load project config + requirement state  
2. Gather context  
3. （可选）对每个源跑 `summarize-sources` 或一次合并 summarize——首期默认**跳过独立 summarize 调用**，把 `sourcesSummary` 直接塞进 `generate`，降低成本和复杂度；`includeSummarize: true` 时再启用多步  
4. Render `generate` 模板 → `callAssistant(BRD_GENERATE, envelope)`  
5. 写入 `brdOutputPath`；`addArtifact(BRD, ...)`  
6. 返回结果摘要

**check**

1. 同上采集；必须能读到 `existingBrd`，否则报错提示先 generate 或放入文件  
2. Render `check` → `BRD_CHECK`  
3. 写入同目录 `brd-check-report.md`（固定相对产出目录）；不覆盖 BRD 正文  
4. 可选登记 Artifact（类型可用现有或 notes；首期写入文件 + capability/run 摘要即可）

`dryRun`：只返回渲染后的 prompts，不调 AI、不写文件（与 `previewBrdPrompts` 对齐）。

### 3.6 工作流节点接线

**`workflow.yaml`** — 将节点动作从纯 manual 改为可执行 AI（保留 PM 人工确认空间）：

方案 A（推荐，最小）：节点仍以 manual 为主完成态，另增 CLI/`step` 能力；DAG 完成仍靠 `node complete`。

方案 B：`actions` 改为 AI（generate），`outputFile: brd.md`——但 check 与双模式不好用单一 action 表达。

**推荐采用 A + 显式 overlay/动作扩展**：

```yaml
- key: requirements-analysis-and-brd-design
  ...
  actions:
    - type: manual
      instructions: "配置项目 BRD 源与提示词后，使用 octopus brd generate|check；确认 brd.md 后标记完成"
```

并在 `spec.ts` 为 `10.1` 增加可选 capabilities（若引擎 step 路径仍使用）：

```ts
capabilities: [
  ai("BRD_GENERATE", { outputFile: "brd.md" }),
  ai("BRD_CHECK", { outputFile: "brd-check-report.md" }),
]
```

注意：`workflow.yaml` 的 node actions 与 `spec.ts` capabilities 是两套并行模型；以 **CLI `brd` 子命令 + engine 方法** 为权威执行入口，避免 worker 在缺少项目配置组装时直接裸调 assistant。

若希望 `node run` 也能跑：为该节点增加 `custom` action `brd.generate` / `brd.check`，在内置 plugin/host 注册 handler，内部调 engine 编排。首期可只做 CLI；PR2 再挂 custom action。

### 3.7 CLI

`packages/cli/src/commands/brd.ts`：

```text
octopus brd config <projectId> [--json]              # 查看
octopus brd config set <projectId> --miniprogram ... --website-code ... --frontend ... --backend ...
                         --miniprogram-artifact ... --website-url ...
                         --spec ... --output ...
octopus brd prompts <projectId> [requirementId] [--mode generate|check|all] [--write] [--json]
octopus brd prompt-set <projectId> --id generate --system-file s.md --user-file u.md
octopus brd generate [requirementId] [--project <id>] [--dry-run] [--json]
octopus brd check [requirementId] [--project <id>] [--dry-run] [--json]
```

`requirementId` 解析复用 `resolveRequirementId`；`projectId` 可从 requirement 反查。

### 3.8 Desktop / Web 设置页

在 `renderProjectSettings()` 增加「BRD 设计」面板（与 OmniPlan 并列）：

- 表单字段对应 `sources.*`、`brdSpecPath`、`brdOutputPath`
- 「提示词」区：下拉选择 `generate` / `check` / `summarize-sources`，编辑 system/user，保存走 `setProjectBrdDesignConfig`
- 「预览提示词」按钮：调用 `previewBrdPrompts`（需当前项目下选一个需求，或仅预览未渲染模板）

API：`getProjectBrdDesignConfig` / `setProjectBrdDesignConfig` / `previewBrdPrompts` 经 web.ts + preload + browser-api 暴露。

浏览器验证（实施时强制）：设置保存 → 刷新回读；非法路径/空 prompt 错误提示；与 OmniPlan/Teambition 面板无回归。

### 3.9 节点 README 更新

实现后把注释块落成「配置说明」：

- 项目配置字段表
- CLI 示例
- 默认提示词位置 / 覆盖方式
- 产出文件约定

---

## 4. Key Decisions

1. **配置存在 Project.metadata[`brdDesign`] JSON**，不新建表——与 OmniPlan 一致，迁移成本低。  
2. **新助手 `BRD_GENERATE` / `BRD_CHECK`**，不复用 `REQUIREMENTS_ANALYSIS`——避免 PRD/BRD 语义混用。  
3. **提示词渲染在 engine，模块吃 JSON envelope**——不改 `AIAssistantModule` 签名。  
4. **权威入口是 `octopus brd *` + engine API**；节点保持 manual 完成态，避免 worker 缺上下文。  
5. **首期有界本地摘要，不抓官网页面、不读大二进制产物**。  
6. **一组提示词 = 命名模板字典**，项目 Partial 覆盖；支持 `prompts` 预览与落盘。

---

## 5. 测试与验收

| 层 | 用例 |
| --- | --- |
| core | metadata 序列化/深合并/校验；默认 prompts 键齐全 |
| agent-layer | 两模块注册；envelope 与纯文本；标签存在 |
| workflow-engine | gather 截断与 missing；generate/check 写文件与 artifact；dryRun 不调 AI（假 client）；未配置源时警告但不炸 |
| cli | config set/get；prompts --json；generate/check 参数解析（可用假 engine） |
| desktop | API case 注册；设置页含字段（源码断言 + 浏览器手工） |

命令：`pnpm -r build`、相关包 `vitest`、`pnpm verify`（若改动面允许）。

---

## 6. 风险与后续

- **Token/超时**：多仓摘要过大 → 严格执行有界截断；可后续加「只索引路径列表」模式。  
- **双模型（yaml actions vs spec capabilities）**：文档写清以 CLI 为准，避免实现时改错入口。  
- **后续**：官网抓取、小程序产物解析、summarize 多步默认开启、节点 custom action 挂载、`node run` 一键生成。

---

## 7. PR Plan

### PR1 — 配置模型与默认提示词
- **Files**: `packages/core`（类型、默认规范/模板、校验）、`packages/workflow-engine`（get/set BrdDesignConfig）、单测  
- **Deps**: 无  
- **描述**: 落地 `ProjectBrdDesignConfig` 与 metadata 读写，不含 AI 调用

### PR2 — AI 模块 + 上下文采集 + generate/check 编排
- **Files**: `packages/core/agent.ts`、`packages/agent-layer/modules/brd-*.ts`、registry、`workflow-engine` gather/preview/generate/check、artifact 写入、单测  
- **Deps**: PR1  
- **描述**: 假 AIClient 测全流程；真实 claude 不进 CI

### PR3 — CLI `octopus brd`
- **Files**: `packages/cli/src/commands/brd.ts`、index 挂载、cli 测试  
- **Deps**: PR2  
- **描述**: config / prompts / generate / check

### PR4 — Desktop 设置页 + 节点文档 / workflow 文案
- **Files**: desktop web/main/preload/renderer、`workflow.yaml` instructions、`workflow/nodes/.../README.md`  
- **Deps**: PR1（UI 可先接 config；预览按钮依赖 PR2）  
- **描述**: 设置面板与浏览器验证；README 配置说明

建议合并顺序：PR1 → PR2 → PR3 → PR4。PR4 的预览若需提前展示，可与 PR3 并行（worktree）。

---

## 8. 实施时验证清单

- [ ] 空配置项目：行为与现网一致  
- [ ] 配齐四类源 + 规范 + 产出：`brd prompts` 含替换后的上下文片段  
- [ ] `brd generate` 写出 BRD；`brd check` 写出报告且不覆盖 BRD  
- [ ] 覆盖 `prompts.generate.user` 后预览可见自定义文案  
- [ ] 设置页保存/清除/回读  
- [ ] `pnpm -r build` + 相关测试通过  
