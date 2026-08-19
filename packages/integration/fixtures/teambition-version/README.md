# teambition-version fixtures

本目录所有 JSON 均为**伪造**样本，仅用于单元测试的静态输入，不是任何真实租户的数据。

- `list-versions.json` — 版本列表响应（信封 `result` 数组）
- `get-version.json` — 版本详情响应（信封 `result` 对象）
- `update-note-response.json` — PUT note 的响应示例

规则：

- 所有 ID 均用占位符 `id_ver` / `id_repo` / `id_proj` / `id_plugin` / `id_tenant`
- URL 一律 `https://example.test/note`
- **禁止**写入真实 cookie / token / 工程 ID（包括 `case/updateNote.md` 中的真实 ID）