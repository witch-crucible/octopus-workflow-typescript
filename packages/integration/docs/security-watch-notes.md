# Security Watch 设计参考

从 `demo/magento-security-watcher`（Python 独立服务）提取的设计模式，供本仓库未来集成参考。

---

## 增量扫描策略

watcher 每次扫描时，对已判定 `fixed` / `not_applicable` 的 risk item 跳过重扫，
除非传入 `--full` 标志。判断依据是 finding 的 `evidence_fingerprint` 哈希：

1. 读取 findings 表，按 project + risk 取最新一条。
2. 若 remediation_status 为 fixed / not_applicable 且 fingerprint 未变 → 跳过。
3. 其余情况（vulnerable / unknown / 新 risk / fingerprint 变化）→ 重新匹配。

这个策略避免每次扫描重复执行 composer.lock 版本比对和内容指纹匹配，
在 CVE 多发期（Adobe 每月安全更新）能显著降低单次扫描耗时。

---

## 双层证据判定

每个 risk item 的判定由两层证据构成，只有两层都确认才算 "vulnerable"：

### 第一层：版本范围匹配
- 解析 `composer.lock` 中受影响包的 installed version。
- 与 RiskItemAnalysis.packages\[].affected_versions 比较。
- 版本号用 semver 比较，支持 `>=1.2.3, <2.0.0` 等范围表达式。
- 注意：composer.lock 不是总能获取（CI 环境下可能需要手动触发 composer install）。

### 第二层：内容指纹匹配
- 对可疑文件计算内容哈希（SHA256 of normalized content）。
- 与 RiskItemAnalysis.fingerprints\[].before/after 比较。
- 支持 filename glob pattern。
- 内容指纹比版本范围更可靠（补丁可能 backport 到旧版本）。

两层证据独立收集，最终判定逻辑：
- 版本匹配 + 指纹匹配 → vulnerable
- 版本匹配 + 指纹不匹配 → vulnerable（降级至 low/medium）
- 版本不匹配 + 指纹匹配 → 异常（可能为 backport），标记为 unknown
- 版本不匹配 + 指纹不匹配 → not_applicable（或 fixed 若之前 vulnerable）

---

## 反幻觉校验

watcher 在告警生成阶段做以下校验，防止 AI/LLM 生成虚假 CVE 信息：

1. **CVE 存在性校验**：CVE ID 必须出现在 Adobe 官方公告原文中（`raw_text`）。
   从公告原文用正则提取 CVE ID，与 AI 生成的风险分析交叉比对。
   不一致时丢弃 AI 结果，降级使用 NVD 数据或标注 `source_missing`。

2. **年份容差校验**：CVE 年份须在公告发布前后合理范围内。
   例如 2026 年的公告不应包含 CVE-2023-xxxxx（除非是 NVD 补录）。

3. **证据可回溯性**：每条告警都附带 `evidence_json`，包含原始版本信息和指纹匹配结果，
   便于人工溯源验证 AI 判定。

---

## 架构决策

### Cron 驱动，无内置调度器
watcher 自身没有常驻调度器，扫描/告警由 cron 触发：
- `ingest` → 每天抓取 Adobe 公告，更新 risk items
- `scan` → 每项目每 6 小时扫描一次
- `notify` → 每项目每 30 分钟检查未通知的告警

优势：进程即用即走，无状态泄漏风险，部署简单（crontab + systemd timer）。

### 数据层独立
SQLite 是唯一权威数据源，reports/ 目录中的 `.md` / `.json` 文件为缓存视图，
可由 SQLite 重新生成。本集成通过直接读取 SQLite 获取结构化数据，
不依赖 watcher 的 HTTP 服务。

### 权限最小化
本集成只读打开 SQLite（`PRAGMA readonly`），写操作仍走 watcher 自身 CLI/API。
