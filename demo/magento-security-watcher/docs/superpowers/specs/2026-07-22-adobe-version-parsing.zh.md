# Adobe APSB 版本表解析 → 精确版本判定

**日期：** 2026-07-22  
**状态：** 已实现  

## 目标

从 Adobe Magento/Commerce 安全公告的 **Affected Versions** / **Solution** 表提取包约束，写入每个 CVE RiskItem 的 `packages`，使 scan 能给出 `fixed` / `vulnerable` / `not_applicable`，而非因缺证据而 `unknown`。

## 行为

1. 详情页 HTML 解析产品行 → composer 包名（CE / EE / B2B 等）
2. `2.4.8-p5 and earlier` → `affected_versions: "<=2.4.8-p5"`，`fixed_version: "2.4.8-p6"`（-p 递增，便于对齐 composer.lock）
3. Solution 中的 `2.4.8-2026-jul` 写入 `recommended_min_versions`
4. 同一公告 CVE 共用公告级版本约束；Notes 含 B2B 时优先 B2B 包
5. Magento 版本比较支持 `-pN` 与 `-YYYY-mon`（不依赖 packaging 的 PEP440）

## 非目标

内容指纹自动生成、AI 裁定 fixed/vulnerable、声明层（composer-patches）。
