# 提取计划：Teambition 集成 + Magento 安全监控

目标：把 `demo/d1m-coder` 的 Teambition 操作能力、`demo/magento-security-watcher` 的监控能力，
提炼为符合本仓库（pnpm workspace, TypeScript, `@octopus/*` 包）架构的核心代码，集成进
`packages/integration`（和必要时的 `packages/task-library`）。

不要整体搬迁两个 demo 项目；只提取"能力"本身，按本仓库现有接口风格（`IntegrationService` /
`IntegrationResult`，见 `packages/integration/src/index.ts`）重写。demo 目录保留原样作为参考，
不删除、不修改。

---

## Part A — Teambition 集成（源：demo/d1m-coder/server/src/providers/tb.ts）

### A0. 前置阅读
- `demo/d1m-coder/server/src/providers/tb.ts`（核心逻辑）
- `demo/d1m-coder/server/src/providers/tb-fake.ts`（fallback 数据结构，用作 mock 参考）
- `demo/d1m-coder/server/src/types.ts`（`TbTask` / `WorkflowStatus` / `ChildTask` / `TbMember` / `TaskUpdate` 等类型）
- `demo/d1m-coder/server/src/config.ts`（认证配置字段）

### A1. 新建 `packages/integration/src/teambition.ts`
按 `git.ts` 的写法（`export class XxxClient implements IntegrationService` + 独立 config 接口）实现：

1. **类型移植**：从 `types.ts` 搬 `TbTask`、`WorkflowStatus`、`ChildTask`、`TbMember`、`TaskUpdate` 到本文件顶部（去掉 Rust/CLI 无关字段，保留字段名不变以减少心智负担）。
2. **配置对象** `TeambitionIntegrationConfig`：
   - `appId`, `appSecret`, `orgId`（必填三件套，全部存在才视为 enabled）
   - `gatewayBase`（默认 `https://open.teambition.com/api`）
   - `refStrategy`（`prefix` | `shortid` | `tql`，默认 `prefix`）
   - `timeoutMs`
3. **认证**：移植 `signAppToken`（HS256 JWT，`node:crypto` 的 `createHmac`，无需引入第三方 jwt 库，和原实现保持一致），以及请求头拼装（`Authorization`、`X-Tenant-Id`、`X-Tenant-Type`、写操作附加 `x-operator-id`）。
4. **`tbRequest`/`tbGet` 等低层 helper** → 私有方法 `request()`，保留"HTTP 恒 200、真实错误在 body.code"这个 TB 网关的怪癖处理逻辑。
5. **对外方法**（映射为 class 方法，返回 `IntegrationResult`，`data` 里放具体结果）：
   - `resolveTask(ref, projectId?)` ← `tbResolveTask`
   - `resolveProject(prefix)` ← `tbResolveProject`
   - `updateTask(update: TaskUpdate)` ← `tbUpdateTask`（保留"最多4个独立PUT"的实现，不要合并成一个假批量接口）
   - `taskParticipants(taskId)` ← `tbTaskParticipants`
   - `myTasks(userId, projectId?)` ← `tbMyTasks`
   - `taskChildren(parentTaskId)` ← `tbTaskChildren`
   - `projectStatuses(projectId)` ← `tbProjectStatuses`
   - `searchMembers(query)` ← `tbSearchMembers`
   - `resolveMember(emailOrName)` ← `tbResolveMember`
   - **不迁移** `tbProbe*` 系列（纯调试用途，与生产集成无关）
6. **`healthCheck()`**：ping `resolveProject` 或做一次轻量 GET，凭据缺失时返回 `success:false`。
7. **降级策略**：不移植 `tb-fake.ts` 的整套 fake provider；改为让调用方在 `appId/appSecret/orgId` 缺失时自行判断是否要用 mock（保持单一职责，别把 fake 逻辑塞进 client 里）。

### A2. 导出
在 `packages/integration/src/index.ts` 末尾追加：
```ts
export { TeambitionClient, createTeambitionClient } from "./teambition.js"
export type { TeambitionIntegrationConfig, TbTask, WorkflowStatus, ChildTask, TbMember, TaskUpdate } from "./teambition.js"
```
同时在文件顶部按现有风格补一个 `TeambitionIntegration extends IntegrationService` 接口声明（对齐 `GitIntegration`/`SonarQubeIntegration` 的写法），列出上面 A1.5 的方法签名。

### A3. 测试
新建 `packages/integration/src/teambition.test.ts`：
- 用 `vitest` + 手写 fetch mock（不要引入新依赖），覆盖：JWT 签名可解码校验 header/payload、`resolveTask` 三种策略分支、`updateTask` 在只传部分字段时只发对应的 PUT 请求数、凭据缺失时 `healthCheck` 返回失败。
- 参考 `packages/integration` 现有测试写法（若无现存 `.test.ts`，参考 `packages/core/src/*.test.ts` 风格）。

### A4. 不迁移的部分（明确排除）
- Rust CLI（`cli/`）、VSCode 插件（`plugin/`）、server 的 HTTP 路由层（`index.ts`）、`d1m init/checkout/push/status` 等命令编排逻辑 — 这些是 d1m 自己的产品逻辑，不是"Teambition 操作能力"本身，本仓库没有对应的宿主（没有 git-branch-driven CLI 概念）。
- `D1M_AUTH_TOKEN` 等 d1m 自身的服务间鉴权，与 Teambition 无关。

---

## Part B — 安全监控能力（源：demo/magento-security-watcher）

### B0. 前置阅读
- `demo/magento-security-watcher/src/magento_security_watcher/matcher.py`（版本比对 + 内容指纹比对的核心判定逻辑）
- `demo/magento-security-watcher/src/magento_security_watcher/sources.py`（公告抓取/CVE提取）
- `demo/magento-security-watcher/src/magento_security_watcher/scan.py`、`ingest.py`
- `demo/magento-security-watcher/config/settings.yaml`

### B1. 定位差异
原项目是纯 Python 独立服务（抓 Adobe 公告 → 比对客户 Magento 代码库 → 企业微信告警），
和本仓库（TS workflow 引擎，做项目管理/阶段流程编排）领域不同、语言不同。**不做逐行迁移**，
只提取"监控集成"这一层能力，对齐 `packages/integration/src/index.ts` 里已有的
`MonitoringIntegration` 接口占位（目前只有 `registerAlert`，过于简单）。

### B2. 新建 `packages/integration/src/security-watch.ts`
实现一个轻量的"外部安全监控适配器"，不重新实现 Python 那套抓取/比对逻辑，而是把
magento-security-watcher **当作外部服务**来对接（因为它本身可以独立部署、跑 cron）：

1. `SecurityWatchClient implements MonitoringIntegration`：
   - `getLatestBulletins(): Promise<IntegrationResult>` — 读取 watcher 暴露的只读 web API
     （`GET /api/bulletins` 等，需先确认 `demo/magento-security-watcher/src/magento_security_watcher/web/app.py` 实际路由；若没有 JSON API 只有页面渲染，则改为直接读取 `data/reports/bulletins/*.md` + `data/db/watcher.sqlite`，用 `better-sqlite3` 只读打开，这两种方式二选一，取决于目标部署形态，需要向用户确认）
   - `getProjectFindings(projectId): Promise<IntegrationResult>` — 读取某项目最新扫描结果（对应 `data/reports/projects/<id>/SUMMARY.md`）
   - `registerAlert(serviceName, duration)` — 保留原接口签名不变（已在 index.ts 定义）
2. **不要**在 TypeScript 里重写 `matcher.py` 的版本比对/指纹比对算法——那是 Python 生态特定的（依赖 `composer.lock` 解析），跨语言重写属于过度工程，且原 Python 服务本身已经是可独立运行、可部署的完整产品。

### B3. 提取的是"设计模式"而非代码
把以下判定/调度逻辑作为**设计参考**写入 `packages/integration/docs/security-watch-notes.md`（简短，仅记录决策依据，不是完整文档）：
- 增量扫描策略（已 fixed/not_applicable 的跳过，除非 `--full`）
- 双层证据判定（版本范围 + 内容指纹）
- 反幻觉校验（CVE 必须真实出现在公告原文 + 年份容差校验）— 如果本仓库未来做"AI 生成结果的自动核验"，这是可复用的思路
- cron 驱动、无内置调度器的设计（避免长驻进程状态）

### B4. 明确排除
- 不迁移 Python 源码本身；`demo/magento-security-watcher` 继续作为独立可部署服务存在。
- 不新增 Python 依赖到本 TS 仓库。
- 若最终确认 watcher 没有 JSON API，B2 的 `getLatestBulletins`/`getProjectFindings` 实现方式需要用户先拍板（sqlite 直读 vs 新增一个小的 FastAPI JSON 端点），**执行到这一步时先停下来问用户**，不要自行假设。

---

## 执行顺序建议
1. Part A（Teambition）——依赖明确、目标包已有同类实现模式（`git.ts`），可以直接做。
2. Part B（安全监控）——先做 B1 调研确认 watcher 是否有 JSON API，若没有，回来问用户选型，再动手。

## 验收标准
- `pnpm -r exec tsc --noEmit` 通过
- `pnpm test` 覆盖新增的 `teambition.test.ts`（以及 B 部分若有代码）
- `packages/integration/src/index.ts` 导出的新接口与现有 `GitIntegration` 风格一致（`IntegrationResult` 返回值、`healthCheck()` 方法）
- demo/ 目录内容不做任何修改
