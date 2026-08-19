# 工作台收口 + 表格 + 我的工作 + 概览

> 给 DeepSeek（或其它实现代理）的可执行设计。按第 16 节执行手册与第 12 节 PR 顺序落地，不要跳步。  
> 日期：2026-08-19  
> 状态：Approved  
> 范围：core、workflow-engine、context、desktop（Web/Electron）、CLI  
> 约束：最小改动；不引 UI 框架或甘特库；不改阶段机 / DAG / Teambition HTTP 契约（只加引擎封装）；拖看板不写 TB。

OmniPlan XML / zip / 路径算法见已落地的：

- `docs/plans/teambition-kanban-gantt-omniplan.md` §7
- `docs/plans/requirement-milestones.md` §7

**本文件覆盖的是那两份方案里还没做完的桌面工作台，外加表格、我的工作、概览。不要重做引擎里已经有的排期 / 换列 / 里程碑 / OmniPlan I/O。**

---

## 0. 交给 DeepSeek 时怎么用

把下面整段当作 **唯一系统任务** 发给 DeepSeek。不要再附 Teambition 帮助手册、不要让它「顺便发挥」。一次会话只做一个 PR。

### 0.1 粘贴给 DeepSeek 的提示词

```text
你是本仓库 octopus-workflow-typescript 的实现代理。

只执行这一份文档，按里面写的做，不要自行扩需求：
  docs/plans/workbench-table-mywork-overview.md

开工前必须先读：
  1. 本文 §0、§2、§3、§11、§16
  2. 对照代码确认 §2「已经有」的 API 确实存在，禁止重写
  3. 风格对齐相邻文件（workflow-engine/index.ts、renderer.js、web.test.ts 抽函数测）

本轮只做：PR__（改成 1 / 2 / 3 / 4 / 5 之一）
不要开始下一个 PR，不要重构无关文件，不要改 workflow.yaml。

完成标准：
  - 文档该 PR 列出的文件都改到
  - 该 PR 要求的测试都有且绿
  - 跑完：pnpm test && pnpm -r build && git diff --check
  - 用中文写一段「做了什么 / 测了什么 / 没做什么」

禁止：
  - 重写 milestone / moveRequirementPhase / OmniPlan XML
  - 看板或表格改阶段时写 Teambition
  - 调用 myTasks、做日历、工时、AI 工作区、迭代
  - 新增 npm 依赖或 UI 框架
  - 提交 /Users/ben/Documents/OmniPlan/Projects/** 
```

把 `PR__` 依次换成 `PR1` … `PR5`。PR1 完成并测试绿了再开下一轮。

### 0.2 你（人类）怎么交接

1. 工作区已有未提交改动（里程碑 / OmniPlan / README）。先让 DeepSeek **在当前工作区继续**，不要让它 `git reset`。
2. 每轮只发一个 PR 编号。它若一次做完全部五段，打回重来。
3. 每轮结束后你跑一遍 `pnpm test && pnpm -r build`，再 `pnpm web` 按 §16 对应清单点一下。
4. 两份旧方案（kanban-gantt-omniplan、requirement-milestones）里的引擎部分 **已经写进代码**。若 DeepSeek 说「要先做 schema v6/v7」，让它再读 §2。

### 0.3 和旧方案的关系

| 旧文档 | 本文件态度 |
| --- | --- |
| `teambition-kanban-gantt-omniplan.md` | 引擎 / OmniPlan I/O 已落地。UI 的「列表=卡片墙」**作废**，改成本文件的「表格」。`#project/:id/gantt` 不再当 legacy。 |
| `requirement-milestones.md` | 模型、CLI、工作区顶栏已落地。本文件只补看板/表格徽章和甘特菱形。 |
| 本文件 | 唯一的 B 线实现规格。冲突时以本文件为准。 |

---

## 1. 目标与成功标准

把项目页做成 Teambition 式工作台，并补手册里还缺、且适合 Octopus 的三块：

1. **收口工作台**：项目页顶栏 **看板 / 表格 / 甘特 / 概览 / 设置**；看板换列走现有 `moveRequirementPhase`；项目甘特 + OmniPlan 按钮；里程碑出现在卡片/表格/甘特。
2. **表格**：密度表，可排序，可改阶段/排期/负责人。
3. **我的工作**：Hub 一级入口，按本机身份列出指派给我的节点与我负责的需求。
4. **概览**：项目级只读仪表盘。

成功标准（全部满足才算完成）：

| # | 标准 |
| --- | --- |
| 1 | `#project/:id` 默认看板；`/table` `/gantt` `/overview` `/settings` 可深链；刷新不丢 tab |
| 2 | 拖到下一列 = `advancePhase`（门控失败回弹）；拖回前列 = `rollbackTo`；跨列前进拒绝 |
| 3 | 表格列：名称、阶段、负责人、排期、下一里程碑、节点进度、TB 状态；点表头排序 |
| 4 | Hub `#hub/mine`：设置「我是谁」后能看到 `owner` 匹配的需求 + `assignedTo` 匹配且未完成的节点 |
| 5 | 概览数字与 `listRequirementSummaries` + `listProjectMilestones` + Heinrich 合计一致 |
| 6 | 项目甘特可改需求/节点排期；菱形可拖里程碑日期；可导入导出 OmniPlan `.oplx` |
| 7 | 工作区里程碑条保持现有行为 |
| 8 | `pnpm test`、`pnpm -r build`、`git diff --check` 通过 |

### 非目标（禁止做）

- 日历、工时字段、工作区「运行 AI」、迭代、项目级里程碑、保存的筛选器
- TB 子任务、排期/执行人回写、`myTasks`、看板拖拽写 TB
- 用 TB 工作流状态当看板列
- 企业账号 / 权限（「我是谁」只是本机字符串）
- 引入 React/Vue、重写 `gantt.js`、提交真实 OmniPlan 工程文件
- 改 `workflow.yaml` DAG 或 12 个 AI 模块契约

---

## 2. 现状（实现前必须对照代码，不要凭记忆）

引擎与 RPC **已经有**，禁止重写：

| 能力 | 位置 |
| --- | --- |
| `plannedStart/End`、schema v7、`milestones` | `packages/core/src/workflow.ts` |
| `updateRequirementSchedule` / `moveRequirementPhase` | `packages/workflow-engine/src/index.ts` |
| 里程碑 CRUD + `listProjectMilestones` | 同上；CLI `octopus milestone` |
| OmniPlan 导入导出 + `setProjectOmniPlanMeta` | engine + `packages/integration/src/omniplan.ts` |
| 上述方法的 Web/Electron RPC | `web.ts` / `main.ts` / `browser-api.js` |
| 工作区里程碑条 | `index.html` `#requirementMilestoneBar` + `renderer.js` |

**本文件要补的缺口：**

| 缺口 | 证据 |
| --- | --- |
| 项目 tab / 深链 | `routeFromHash()` 把 `#project/:id/gantt` 当 `legacyProject`；`web.test.ts` 仍断言这一点 |
| 看板 markup / DnD | `#projectView` 仍是 `#requirementCards` 卡片墙 |
| `gantt.js` `mode: "requirements"`、里程碑菱形 | 无 `kind: "milestone"` |
| 需求 `owner` | `WorkflowState` / `RequirementSummary` 无此字段 |
| 节点指派 API | `assignedTo` 只能经 `importTasks` 写入 |
| 我的工作 / 概览 API | 不存在 |
| 本机身份 | `OctopusConfig` 无 `identity` |

OmniPlan XML 已在 integration。本文件只补 UI 按钮、Web buffer、覆盖确认。

---

## 3. 关键决策

1. **没有「列表」tab。** 看板已经是卡片。表格取代旧方案的列表。`#project/:id/list` → `/table`。卡片上「排期」展开节点甘特不再是项目主路径；可删 `expandedScheduleId`，或改成跳到 `/gantt`。
2. **我的工作在 Hub**（`#hub/mine`），不是项目 tab。
3. **概览是项目 tab，只读投影**，不另存统计表。
4. **身份是本机字符串。** `identity.name` / `OCTOPUS_ME` / 桌面输入框写入 `.octo/config.json`。匹配：trim + 大小写不敏感全等。空身份只显示引导，不列出全部未指派。
5. **需求 `owner` 升 schema v8。** 与节点 `assignedTo` 分开。表格「负责人」改 `owner`。
6. **改阶段不写 TB。** TB 列：只读徽章 + 已绑定卡的下拉（现有 `updateRequirementTeambitionStatus`）。
7. **我的工作 v1 只查本地。** 禁止调用 `myTasks`。
8. **同一时间只 mount 一个 `OctopusGantt`。** 切 tab 时 unmount / park。

---

## 4. 信息架构与路由

```text
#hub                         Hub · 项目
#hub/mine                    Hub · 我的工作
#project/:id                 项目 · 看板（默认）
#project/:id/board           同上
#project/:id/table           项目 · 表格
#project/:id/gantt           项目 · 甘特
#project/:id/overview        项目 · 概览
#project/:id/settings        项目 · 设置
#requirement/:id             需求工作区（不变）
```

`routeFromHash()` 返回：

```js
{ view: "hub", hubTab: "projects" | "mine" }
{ view: "project", projectId, projectTab: "board" | "table" | "gantt" | "overview" | "settings" }
{ view: "workspace", requirementId }
{ view: "legacyProject", projectId, redirectCandidate: true } // 仅 /graph
```

| 旧 hash | 新行为 |
| --- | --- |
| `#project/:id/gantt` | 就是甘特 tab，不再 legacy |
| `#project/:id/graph` | 仍 legacy：能 `getProject` 则去看板，否则当需求 |
| `#project/:id/list` | `replaceState` 到 `/table` |

`goToProject(id, tab?)`：默认 tab 省略 `/board`。  
`setChrome("project")` 副标题：`看板 · 表格 · 甘特 · 概览 · 设置`。

---

## 5. 数据模型

### 5.1 需求负责人

`packages/core/src/workflow.ts`：

```ts
export const CURRENT_SCHEMA_VERSION = 8

export interface WorkflowState {
  // 现有字段...
  owner?: string  // trim 后 1–80；空则 delete
}

export interface RequirementSummary {
  // 现有字段...
  owner?: string
}
```

`migrateWorkflowState`：升到 8 不改已有字段。`listRequirementSummaries` 有值才展开。

校验（引擎，中文 Error）：

- 空白 → 清除
- 超过 80 字 → 「负责人必须是 1–80 个字符」

`updateRequirement` patch 增加 `owner?: string | null`。

### 5.2 配置身份

`packages/context/src/config.ts`：

```ts
export interface IdentityConfig { name: string }

export interface OctopusConfig {
  // 现有...
  identity?: IdentityConfig
}
```

- 文件：`identity.name`
- 环境变量：`OCTOPUS_ME`（更高优先）
- `saveIdentity(storeDir, name)` 只补丁 `identity` 键，禁止重写整个 config 丢掉其它字段。空 name 删除该键。

### 5.3 我的工作

新建 `packages/core/src/my-work.ts`：

```ts
export type MyWorkKind = "requirement" | "node"

export interface MyWorkItem {
  kind: MyWorkKind
  projectId: string
  projectName: string
  requirementId: string
  requirementName: string
  phase: Phase
  owner?: string
  nextMilestone?: MilestoneSummary
  plannedEnd?: string
  nodeId?: string
  nodeName?: string
  status?: TaskStatus
  assignedTo?: string
  overdue: boolean
}

export interface MyWorkList {
  identity: string
  requirements: MyWorkItem[]
  nodes: MyWorkItem[]
}
```

- 节点：`assignedTo` 匹配且状态为 `PENDING | IN_PROGRESS | BLOCKED`
- 需求：`owner` 匹配
- 排序：逾期优先，再日期，再名称
- 需求 overdue = `nextMilestone.overdue` 或 `plannedEnd < today`
- 节点 overdue = 有 `plannedEnd` 且 `< today`

### 5.4 项目概览

```ts
export interface ProjectOverview {
  projectId: string
  projectName: string
  requirementCount: number
  byPhase: Array<{ phase: Phase; count: number }>  // PHASE_ORDER 全列，含 0
  unscheduledCount: number
  unboundTbCount: number
  milestonePlanned: number
  milestoneReached: number
  milestoneOverdue: number
  heinrich: { major: number; minor: number; trivial: number }
  readyNodeCount: number
  waitingNodeCount: number
  ownerlessCount: number
}
```

从 state 派生。`readyNodeCount` 对每个需求调现有 `getExecutionSnapshot`。不要新表。

---

## 6. 引擎 API

全部加在 `packages/workflow-engine/src/index.ts`，测试放 `index.test.ts`。

```ts
updateRequirement(
  requirementId: string,
  patch: { name?: string; description?: string; owner?: string | null },
): WorkflowState

assignNode(
  requirementId: string,
  nodeId: string,
  assignedTo: string | null,
): WorkflowState
// null/"" 清除；非空 trim 1–80；节点不存在抛「节点不存在:」

listMyWork(identity: string, projectId?: string): MyWorkList
// identity 空白 → { identity:"", requirements:[], nodes:[] }

getProjectOverview(projectId: string): ProjectOverview
```

匹配：

```ts
function identityMatches(value: string | undefined, identity: string): boolean {
  return (value ?? "").trim().toLowerCase() === identity.trim().toLowerCase()
}
```

身份读写放 `packages/context`（与 omniplan 配置同一层）：

```ts
getIdentity(storeDir?: string): string | undefined
saveIdentity(storeDir: string, name: string | null): void
```

---

## 7. RPC / CLI

`web.ts`、`main.ts`、`preload.cjs`、`browser-api.js` 同步：

| method | 参数 | 返回 |
| --- | --- | --- |
| `assignNode` | requirementId, nodeId, assignedTo \| null | `{ requirementId, nodeId, assignedTo }` |
| `listMyWork` | identity, projectId? | `MyWorkList` |
| `getProjectOverview` | projectId | `ProjectOverview` |
| `getIdentity` | — | `{ name: string \| null }` |
| `setIdentity` | name \| null | `{ name: string \| null }` |
| `exportProjectOmniPlanBuffer` | projectId | `{ fileName, base64 }` |
| `importProjectOmniPlanBuffer` | projectId, base64 | 与 import 相同统计 |

现有 `updateRequirement` RPC 放行 `owner`。不要把任意 `metadata` 打通。

CLI：

- `octopus project overview <projectId>`
- `octopus mine [--me <name>] [--project <id>]`（`--me` 缺省用 `OCTOPUS_ME` / config）
- `octopus node assign <nodeId> [name] --requirement <id>`（不传 name 则清除）

Web：导出先试路径 API，不可写则 buffer 下载；导入用 `<input type=file>`。若引擎只有 path 版，抽 `importProjectOmniPlanFromBuffer`。

---

## 8. UI

风格：`--el-*`、`.hub-toolbar`、`.hub-card`、`.tb-bar`。不引库。Markup 做成可被 `web.test.ts` 抽取的纯函数（学 `buildRequirementCardsMarkup`）。

### 8.1 Hub

```
[ 项目 ] [ 我的工作 ]     筛选框（仅项目 tab）     我是 [_______]
```

- 「我是」失焦 / Enter → `setIdentity`
- 项目 tab：现有卡片墙 + 右侧创建，不变
- 我的工作：隐藏创建侧栏

**指派给我的节点**：项目 / 需求 / 节点 / 阶段 / 状态 / 截止日期。点击进 `#requirement/:id`。逾期 `is-overdue`。

**我负责的需求**：项目 / 需求 / 阶段 / 下一里程碑 / 排期结束。点击进工作区。

空态：

- 未设身份：「在上方填写你的名字。需求负责人和节点指派会按这个名字匹配。」
- 已设无数据：「没有指派给「X」的节点或需求。」

函数：`buildMyWorkMarkup(list, { identity })`。

### 8.2 项目页骨架

```
[看板] [表格] [甘特] [概览] [设置]     筛选框（仅看板/表格）
#projectBoard | #projectTable | #projectGanttHost | #projectOverview | #projectSettings
侧栏：看板/表格显示创建需求；其余隐藏；甘特全宽
```

现有右侧 TB 表单搬进 `#projectSettings`。筛选：名称 / ID / 描述 / owner。

### 8.3 看板

`buildKanbanMarkup(items, { filter, lastCreatedId, phaseOrder, phaseLabel })`

- 列 = `PHASE_ORDER`，列头 `意向 3`，空列保留
- 卡片：名称、描述一行、进度、TB 徽章、里程碑徽章、排期、owner（有才显示）
- 打开 / 编辑 / 删除；已绑定则内嵌 TB `<select>`（阻止起拖）
- HTML5 DnD → `moveRequirementPhase`；失败 `showError`，DOM 不改
- 点击空白进工作区
- 窄屏 `flex-wrap`，仍可拖

### 8.4 表格

`buildRequirementTableMarkup(items, { filter, sortKey, sortDir, lastCreatedId })`

| 列 | 编辑 |
| --- | --- |
| 名称 | 只读，点击进工作区 |
| 阶段 | `<select>` → `moveRequirementPhase`，失败回弹 |
| 负责人 | blur → `updateRequirement({ owner })` |
| 开始 / 结束 | 成对提交；都空则清排期；只改一侧且另一侧空 → 不打 API，提示「起止日期必须成对」 |
| 里程碑 | 只读徽章 |
| 进度 | 只读 |
| TB | 已绑定：下拉；未绑定：muted |
| 操作 | 编辑名称描述 / 删除 |

默认按阶段（`PHASE_ORDER` 下标）再名称。日期空排最后。

### 8.5 甘特

扩展 `gantt.js`，不新文件。默认 `mode: "nodes"` 保持兼容。

```js
{
  mode: "nodes" | "requirements",
  requirements: [{
    id, name, phase, plannedStart, plannedEnd,
    statusLabel, progress, owner, teambitionStatusName,
    milestones: [{ id, name, date, status }],
    steps, runs, snapshot,
  }],
  projectMilestones: [{ id, requirementId, name, date, status }],
  selectedId, labels,
}
```

requirements 模式：

- 一行一需求；twistie 展开节点子行
- 需求之间不画依赖；展开后画节点 `dependsOn`
- 需求条上叠菱形（10px 旋转方；计划中空心、达成实心、逾期红）
- 顶部「项目里程碑」投影行，同日错开 6px；拖拽 → `updateMilestone({ date })`
- 未排期进底部 chip
- `onSchedule(id, schedule, kind: "requirement" | "node" | "milestone")`
- 工具条新增：导入 / 导出 OmniPlan、「添加里程碑」（未选中需求则提示）

切走甘特 tab 必须 `unmount`。

### 8.6 概览

`buildProjectOverviewMarkup(overview)`：需求数、未排期、未绑 TB、无负责人、可运行/等待手动、里程碑三项、Heinrich 三项、阶段分布表。数字只读，不做点击筛选。无需求：空态文案。

### 8.7 设置

- TB 绑定整块（从右侧搬来）
- OmniPlan：只读 `rootDir`、folder、fileName、保存、打开目录（Electron `shell.openPath`；Web 显示路径）
- 导入 / 导出（与甘特工具条同一函数）
- 覆盖已有 `.oplx` 要 `confirm`：「导出会按 Octopus 任务树重建 .oplx，未映射字段不会保留。」

### 8.8 工作区（必做指派入口）

里程碑条不改。另加：

- `#requirementOwnerBar`：`负责人 [input]` blur → `updateRequirement({ owner })`
- inspector 一行「指派」→ `assignNode`（「我的工作」的节点来源，不能只靠 CLI）

### 8.9 里程碑徽章

抽出 `milestoneBadgeHtml(item)`：

- 无里程碑：不渲染
- 有未达成：`里程碑 03-12 设计评审`；逾期 `is-overdue`
- 仅已达成：`里程碑已全部达成`

---

## 9. OmniPlan（只接 UI）

不要改 `Actual.xml` 映射，除非现有测试红。先跑 `omniplan.test.ts`。

UI 必须：

1. 目标文件已存在 → confirm（文案见 8.7）
2. 导入 toast：`更新需求 N、节点 M；未匹配 X；跳过 Y`
3. Web 无写权限走 buffer
4. 设置页改 folder/fileName → `setProjectOmniPlanMeta`

---

## 10. 测试（每个相关 PR 都要有）

| 层 | 用例 |
| --- | --- |
| migrate | v7→v8 保留 milestones 与排期，owner 缺省 |
| updateRequirement | 设/清 owner，超长抛错 |
| assignNode | 设/清/超长/节点不存在 |
| listMyWork | 空身份空列表；大小写匹配；COMPLETED 排除；projectId 过滤 |
| getProjectOverview | 空项目；阶段含 0；逾期计数；Heinrich 合计 |
| config | `OCTOPUS_ME` 覆盖文件；saveIdentity 不丢其它键 |
| routeFromHash | 新 tab；`/gantt` 不是 legacy；`/list` 解析为 table |
| buildKanbanMarkup | 空列保留、过滤、高亮 |
| buildRequirementTableMarkup | 排序、逾期、过滤 |
| buildMyWorkMarkup | 引导空态 / 有数据 |
| buildProjectOverviewMarkup | 数字渲染 |
| web RPC | 新 method 字符串存在（学现有 browser-api 断言） |
| CLI | `mine` / `node assign` / `project overview` |

DnD 不做 jsdom 全模拟。换列正确性由 `moveRequirementPhase` 单测保证（已有，不要删）。

---

## 11. 实现时禁止

- 不要提交 `/Users/ben/Documents/OmniPlan/Projects/**`
- 不要为换列手改 `currentPhase` / `phaseStatus`
- 不要把 `updateTask` 接到 DnD 或表格改阶段
- 不要新增 npm 依赖
- 不要重排无关文件、不要改 `workflow.yaml`
- Web 仍只听回环
- 不要实现 `myTasks` 合并
- 不要把「我的工作」做成第三套 `view`，它是 `hubTab`
- 不要重写已有 milestone / OmniPlan / `moveRequirementPhase`
- 不要 `git reset` / 丢弃工作区已有 WIP

---

## 12. PR 顺序（一次只做一行）

每个 PR 独立可测。结束命令：

```bash
pnpm test
pnpm -r build
git diff --check
```

| PR | 标题 | 做 | 不要做 |
| --- | --- | --- | --- |
| **PR1** | feat(core): owner、指派、我的工作、概览 | schema v8、`updateRequirement.owner`、`assignNode`、`listMyWork`、`getProjectOverview`、identity 配置、CLI、engine 单测、RPC 先挂上 | 不要改 renderer 外观 |
| **PR2** | feat(desktop): 路由 + 看板 + 设置 | `routeFromHash` 新 tab；看板 DnD；设置页迁 TB+OmniPlan；改掉 `/gantt` legacy 测试 | 不要做表格、不要改 gantt.js 双模式 |
| **PR3** | feat(desktop): 表格 | `/table`、排序、inline 阶段/日期/owner；`/list` 重定向 | 不要做甘特菱形 |
| **PR4** | feat(desktop): 项目甘特 + 菱形 + OmniPlan 按钮 | `gantt.js` dual mode；buffer；工作区 owner 条 + inspector 指派 | 不要做 Hub 我的工作页 |
| **PR5** | feat(desktop): Hub 我的工作 + 项目概览 | `#hub/mine`、身份输入、概览卡片；README 图形界面一节 | 不要回头大改看板/表格 |

顺序：**1 → 2 → 3**，然后 4 与 5 可分两次做（仍不要同一轮一起交）。

---

## 13. 关键文件

| 文件 | 哪个 PR |
| --- | --- |
| `packages/core/src/workflow.ts`、`my-work.ts`、`index.ts`、`migrate.test.ts` | 1 |
| `packages/context/src/config.ts`、`config.test.ts` | 1 |
| `packages/workflow-engine/src/index.ts`、`index.test.ts` | 1（PR4 若缺 buffer 再动薄封装） |
| `packages/cli/src/commands/node.ts`、新 `mine.ts`、`project.ts`、`index.ts`、`cli.test.ts` | 1 |
| `packages/desktop/src/web.ts`、`main.ts`、`preload.cjs`、`browser-api.js`、`web.test.ts` | 1 挂 RPC，2–5 用 |
| `packages/desktop/src/renderer/index.html`、`renderer.js` | 2–5 |
| `packages/desktop/src/renderer/gantt.js` | 4 |
| `README.md` | 5（或 PR2 先改一句路由） |

OmniPlan 核心文件默认不动。

---

## 14. 风险

| 风险 | 缓解 |
| --- | --- |
| `/gantt` 旧语义 | `/graph` 仍兼容；README 写一句 |
| 表格改阶段撞门控 | 与看板同一错误文案，select 回弹 |
| 身份拼写不一致 | 忽略大小写；空态写明按全等匹配 |
| 概览 N 次 snapshot | 需求量小，B 不预优化 |
| gantt 双模式回归 | nodes 为默认；requirements 另分支 |

---

## 15. 开工检查清单（DeepSeek 每轮开头勾）

- [ ] 已读本文 §0、§2、§3、§11、§16
- [ ] 已用 grep 确认 `moveRequirementPhase` / `listMilestones` / `exportProjectOmniPlan` 存在
- [ ] 本轮只做指定的一个 PR
- [ ] 不打算 `git reset` 或还原用户 WIP
- [ ] 新引擎方法先写测试再写实现

---

## 16. DeepSeek 执行手册

批准后严格按序。每步结束跑测试。不要把后续 PR 的重构提前做进前面。

### PR1 — 数据与引擎（无 UI）

文件：core、context、workflow-engine、cli、desktop RPC（只挂方法）。

做：v8、`owner`、`assignNode`、`listMyWork`、`getProjectOverview`、`saveIdentity`、CLI。  
测：`pnpm --filter @octopus/core test`、`workflow-engine`、`context`、`cli`。  
不要改 `index.html` / `renderer.js` 外观。

### PR2 — 路由 + 看板 + 设置

文件：`index.html`、`renderer.js`、`web.test.ts`。

做：tab DOM；`routeFromHash`；`buildKanbanMarkup` + DnD；TB 表单迁设置；OmniPlan 设置字段可先只读展示。  
改测试：`#project/demo/gantt` 期望变为 `{ view:"project", projectTab:"gantt", ... }`。  
不要做表格，不要改 `gantt.js` 模型。

手工：空项目、筛选、拖到下一列、跨列前进回弹、未配 TB 时下拉走 `readableError`、窄屏换行。

### PR3 — 表格

文件：`renderer.js`、`index.html` CSS、`web.test.ts`。

做：`buildRequirementTableMarkup`、排序、inline 编辑、`/list` 重定向。  
手工：改阶段门控失败回弹、成对日期、清空排期、owner blur。

### PR4 — 甘特 + OmniPlan 按钮 + 工作区指派

文件：`gantt.js`、`renderer.js`、`index.html`、必要时 engine buffer。

做：`mode:"requirements"`、菱形、导入导出 confirm、owner 条、inspector 指派。  
验：切 tab 后只有一个 gantt 实例；nodes 模式默认行为不坏。

### PR5 — 我的工作 + 概览

文件：Hub tab、概览 markup、README「图形界面」段。

做：身份输入、`listMyWork` 两张表、`getProjectOverview` 卡片。  
手工：设「我是」后能看到刚指派的节点；概览逾期数与表格红字一致。

### 每 PR 验证

```bash
pnpm test
pnpm -r build
git diff --check
```

桌面相关再加根目录的 `web.test.ts`（已在 `pnpm test` 里）。

结束后用中文报告：改了哪些文件、测试输出、哪几条成功标准已满足、下一条 PR 是什么。
