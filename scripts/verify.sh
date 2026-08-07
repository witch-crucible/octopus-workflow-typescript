#!/usr/bin/env bash
set -euo pipefail

# 统一执行编译、测试和静态检查，提交前使用同一套验证入口。
pnpm build
pnpm test
pnpm lint
