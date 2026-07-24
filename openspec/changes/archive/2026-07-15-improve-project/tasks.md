## 1. 基础改进

- [x] 1.1 确认 `.gitignore` 已包含 `.octo/`、`.octo_engine_test/` 等运行时目录
- [x] 1.2 验证 `pnpm build` / `pnpm lint` 当前基线（发现依赖缺失，待用户授权安装）

## 2. 测试覆盖

- [x] 2.1 在 `workflow-engine` 增加边界场景单测：无项目状态查询、未知任务更新
- [x] 2.2 在 `workflow-engine` 增加清单与海因里希场景断言测试
- [x] 2.3 在 `workflow-engine` 增加阶段门禁正向/负向测试用例
- [x] 2.4 运行 `pnpm test` 并修复失败用例

## 3. CLI 可靠性与输出

- [x] 3.1 统一 CLI 命令失败处理，确保错误时输出到 stderr 并退出码为 1
- [x] 3.2 检查并补齐 `phase`、`task`、`checklist`、`heinrich`、`status` 的 `--json` 输出一致性
- [x] 3.3 对异常输入（未知阶段、非法状态）增加错误提示与退出码

## 4. 配置与集成

- [x] 4.1 扩展配置读取，确保 `storeDir` / `ai.model` / `ai.timeout` 覆盖环境变量与文件配置
- [x] 4.2 在 Git integration 增加仓库根目录、当前分支、变更文件列表基础能力
- [x] 4.3 为 Git 能力增加基础健康检查与错误返回

## 5. 验证

- [x] 5.1 运行 `pnpm build` / `pnpm test` / `pnpm lint` 全量验证
- [x] 5.2 手工验证关键命令：`init`、`status`、`phase advance`、`ai ask --json`
