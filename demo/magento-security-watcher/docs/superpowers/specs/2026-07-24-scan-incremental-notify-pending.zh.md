# Scan 增量跳过 + notify-pending

日期：2026-07-24

## 目标

1. 加速日常 `msw scan`：默认跳过上次已为 `fixed` / `not_applicable` 的风险。
2. 支持不扫代码、只按最新 Finding + `alert_state` 去重补发企微通知。

## 行为

### Scan 增量（默认）

- 仍：git sync、inventory。
- 对每个项目，取最新 Finding；若某 `risk_id` 状态为 `fixed` 或 `not_applicable`，本轮不 `match`、不写新 Finding、不调项目叙事 LLM。
- 无历史 Finding 的 risk（含新入库）一律扫描。
- `--full`：不跳过，行为与旧版一致。
- 跳过项在 Web 上继续显示上次结论。

### `msw notify-pending`

- 不 git / match / LLM。
- 读取启用项目的最新 Finding，对 `vulnerable` / `unknown` / `fixed`（与 `scan --notify` 一致）调用现有 `notify_finding` + `alert_state` 去重。
- `msw notify` 保持旧行为（= `scan --notify`）。

## CLI

```text
msw scan [--full] [--notify/--no-notify] [--project ID] ...
msw notify-pending [--project ID]
msw notify   # 不变：全量语义上的 scan --notify（默认仍走增量 match，除非 --full）
```

说明：`msw notify` 经 `scan --notify` 进入，默认也享受增量跳过；需要全量再扫再通知时用 `msw scan --full --notify`。

## 非目标

- 不按 git commit 自动强制全量（本次不做 C）。
- 不强制重发（忽略去重）。
- 不改 Web UI。
