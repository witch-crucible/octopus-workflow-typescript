#!/usr/bin/env node

// 确保 better-sqlite3 原生模块与目标运行时（node 或 electron）的 ABI 匹配。
// 用法：node scripts/ensure-sqlite.mjs <node|electron>
// 退出码：0 = 就绪，1 = 无法就绪，2 = 参数错误

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNPM_STORE = join(REPO_ROOT, "node_modules", ".pnpm");

// ── 参数解析 ──────────────────────────────────────────────────────────

const target = process.argv[2];
if (target !== "node" && target !== "electron") {
  console.error("用法：node scripts/ensure-sqlite.mjs <node|electron>");
  process.exit(2);
}

// ── 定位 better-sqlite3 安装 ──────────────────────────────────────────

const candidates = readdirSync(PNPM_STORE).filter((d) =>
  d.startsWith("better-sqlite3@"),
);
if (candidates.length !== 1) {
  console.error(
    `期望 node_modules/.pnpm 下恰好 1 个 better-sqlite3@ 条目，实际 ${candidates.length} 个`,
  );
  process.exit(1);
}

const bindingPath = join(
  PNPM_STORE,
  candidates[0],
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);

if (!existsSync(bindingPath)) {
  console.error(`缺少二进制文件：${bindingPath}`);
  process.exit(1);
}

// ── 加载检查 ──────────────────────────────────────────────────────────

function canLoad() {
  const code = `require(${JSON.stringify(bindingPath)})`;
  try {
    if (target === "node") {
      execFileSync(process.execPath, ["-e", code], { stdio: "ignore" });
    } else {
      execFileSync(
        "pnpm",
        [
          "--filter",
          "@octopus/desktop",
          "exec",
          "electron",
          "-e",
          code,
        ],
        {
          stdio: "ignore",
          cwd: REPO_ROOT,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
      );
    }
    return true;
  } catch {
    return false;
  }
}

if (canLoad()) {
  console.log(`better-sqlite3 已匹配 ${target}`);
  process.exit(0);
}

// ── 重建 ──────────────────────────────────────────────────────────────

console.log(`better-sqlite3 未匹配 ${target}，正在重建…`);

if (target === "node") {
  // 先尝试从根目录重建，若仍不匹配则回退到 packages/context
  try {
    execFileSync("pnpm", ["rebuild", "better-sqlite3"], {
      stdio: "inherit",
      cwd: REPO_ROOT,
    });
  } catch {
    // 根目录重建失败，继续尝试回退
  }

  if (!canLoad()) {
    try {
      execFileSync("pnpm", ["-C", "packages/context", "rebuild", "better-sqlite3"], {
        stdio: "inherit",
        cwd: REPO_ROOT,
      });
    } catch {
      console.error("node 重建失败");
      process.exit(1);
    }
  }
} else {
  try {
    execFileSync(
      "pnpm",
      ["-C", "packages/desktop", "exec", "electron-rebuild", "-f", "-w", "better-sqlite3"],
      { stdio: "inherit", cwd: REPO_ROOT },
    );
  } catch {
    console.error("electron 重建失败");
    process.exit(1);
  }
}

// ── 重建后验证 ─────────────────────────────────────────────────────────

if (!canLoad()) {
  console.error(`重建后仍无法加载 better-sqlite3（${target}）`);
  process.exit(1);
}

console.log(`better-sqlite3 已匹配 ${target}`);
