# Magento2 Security Watcher

Debian 上运行的 Magento2 安全情报与项目扫描工具：**Bulletin → RiskItem → Finding**，版本层 + 内容指纹核验，企微通知可去重。AI 只负责叙述与指纹草案，不裁定是否已修。

设计说明见 [`docs/superpowers/specs/2026-07-21-magento-security-watcher-design.md`](docs/superpowers/specs/2026-07-21-magento-security-watcher-design.md)。

## 功能

- `ingest`：采集官方公告（或本地 fixture）→ 拆 RiskItem → NVD / 补丁 → 指纹 → 报告
- `scan`：git 拉取配置分支（假定含 vendor）→ 对照 RiskItem 出 Finding（版本层 + 可选内容指纹）
- 公告详情解析 **Affected / Solution** 版本表，写入 `packages`，支持 Magento `2.4.x-pN` 精确比对
- `notify`：按**项目**一条汇总推企微（`alert_state` 去重）；`ingest --notify-new` 按**公告**一条情报摘要；详情页可手动强制发送
- Web：公告详情页展示公告级 LLM 分析（业务影响、修复方式、参考链接）与关联风险
- `status`：本地查看汇总

## 快速开始

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

cp config/settings.yaml.example config/settings.yaml
cp config/projects.yaml.example config/projects.yaml
cp .env.example .env
# 编辑 projects.yaml；密钥写在项目根目录 `.env`（勿提交）

msw ingest
msw scan --project demo-shop --local-workspace /path/to/magento --notify
msw status
```

### Debian 服务器初始化注意

不要把本机（macOS）的 `.venv` 同步到 Linux。若已同步，会报：

`No such file or directory: '.../.venv/bin/python'`

在服务器上重建：

```bash
cd /data/www/D1M/magento-security-watcher
rm -rf .venv
# Debian 若缺 venv 模块：sudo apt install python3-venv python3-pip
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -e ".[dev]"
```

项目支持 Python **3.9+**（Debian 11 自带 3.9 可用）。若系统只有更旧版本，需自行安装 3.9 及以上。

SFTP 的 `ignore` 已包含 `.venv`，避免再次上传本机虚拟环境。
### 公告源说明

默认索引为 Adobe 官方 Magento 产品安全页：

`https://helpx.adobe.com/security/products/magento.html`

若旧配置仍指向 Experience League `ka-21520` 等失效链接，会出现 **404**，请更新 `advisory.bulletin_list_url`。  
网络不稳时可设 `advisory.fixture_dir: tests/fixtures/advisories` 做离线入库。对 `adobe.com` 会优先使用系统 `curl`（部分环境 Python httpx 易超时）。

### 环境变量 / `.env`

密钥放在项目根目录的 **`.env`**（已 gitignore），`msw` 会从该文件读取；也可继续用系统环境变量（优先于 `.env`）。

```bash
cp .env.example .env
# 编辑 WECOM_WEBHOOK_URL / MSW_LLM_API_KEY 等
```

| 变量 | 用途 |
|------|------|
| `MSW_ROOT` | 项目根目录（可选） |
| `OPENAI_API_KEY` / `MSW_LLM_API_KEY` | LLM（需 `llm.enabled: true`） |
| `NVD_API_KEY` | NVD 提速与提高配额（可选）；CVE 结果会缓存在 `data/cache/nvd/`，TTL 见 `nvd.cache_ttl_days` |
| `WECOM_WEBHOOK_URL` | 企微机器人 Webhook |
| `MAGENTO_REPO_PUBLIC_KEY` / `MAGENTO_REPO_PRIVATE_KEY` | 下载需鉴权的 isolated patch（可选） |

## CLI

```bash
msw ingest [--notify-new] [--from-html FILE] [--skip-existing] [--risks ID ...]
msw clear (--risks ID … | --year-mismatch | --placeholders) [--yes]
msw scan [--notify/--no-notify] [--full] [--project ID] [--local-workspace DIR] [-v]
# 默认增量：跳过上次已为 fixed / not_applicable 的风险；--full 全量重扫
# -v / --verbose：每条风险判定、git 命令等 DEBUG 日志；也可用 msw -v scan
msw notify [--project ID]          # = scan --notify（仍会扫；企微按项目一条）
msw notify-pending [--project ID]  # 只按最新 Finding + alert_state 补发（按项目一条），不扫描
msw status [--limit 20]
msw serve [--host HOST] [--port PORT]
```

### Web 看板（只读）

内网查看 SQLite 中的项目扫描结果与风险情报（FastAPI + Jinja2），无登录；靠 `web.allowed_cidrs` IP 白名单限制访问。空白名单 = 仅本机 loopback。`/health` 同样受白名单约束。页面不提供 ingest/scan 触发。

```bash
# config/settings.yaml 中配置 web.allowed_cidrs 后：
msw serve
# 浏览器打开 http://127.0.0.1:8080/
```

字体默认走 Google Fonts CDN（IBM Plex）。若服务器不能出网，可改为本地 `@font-face`（把 woff2 放到 `web/static/fonts/` 并改 `app.css` / `base.html`）。

`projects.yaml` 里 git URL 若含 token，界面会脱敏，不会回显明文。

## 测试

```bash
pytest -q
```
