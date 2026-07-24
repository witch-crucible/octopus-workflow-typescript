/**
 * Git Integration —— 本地 Git 操作实现。
 *
 * 封装常用 Git 命令，提供符合 IntegrationService / GitIntegration 接口的实现。
 */

import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import type { IntegrationResult, GitIntegration } from "./index.js"

const execFileAsync = promisify(execFile)

/** Git 集成配置 */
export interface GitIntegrationConfig {
  /** Git 可执行文件路径 */
  gitPath?: string
  /** 默认远程名称 */
  remoteName?: string
}

const DEFAULT_CONFIG: GitIntegrationConfig = {
  gitPath: "git",
  remoteName: "origin",
}

/**
 * Git 集成实现。
 */
export class GitClient implements GitIntegration {
  readonly name = "git"
  private readonly gitPath: string
  private readonly remoteName: string

  constructor(config?: GitIntegrationConfig) {
    this.gitPath = config?.gitPath ?? DEFAULT_CONFIG.gitPath!
    this.remoteName = config?.remoteName ?? DEFAULT_CONFIG.remoteName!
  }

  /** 健康检查 —— 验证 git 是否可用 */
  async healthCheck(): Promise<IntegrationResult> {
    try {
      await execFileAsync(this.gitPath, ["--version"], { encoding: "utf-8" })
      return { success: true, message: "Git 可用" }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `Git 不可用: ${message}`, error: message }
    }
  }

  /** 获取仓库根目录 */
  async getRepoRoot(): Promise<IntegrationResult> {
    try {
      const { stdout } = await execFileAsync(this.gitPath, ["rev-parse", "--show-toplevel"], { encoding: "utf-8" })
      return { success: true, message: "获取仓库根目录成功", data: { root: stdout.trim() } }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `获取仓库根目录失败: ${message}`, error: message }
    }
  }

  /** 获取当前分支 */
  async getCurrentBranch(): Promise<IntegrationResult> {
    try {
      const { stdout } = await execFileAsync(this.gitPath, ["branch", "--show-current"], { encoding: "utf-8" })
      return { success: true, message: "获取当前分支成功", data: { branch: stdout.trim() } }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `获取当前分支失败: ${message}`, error: message }
    }
  }

  /** 获取变更文件列表 */
  async getChangedFiles(): Promise<IntegrationResult> {
    try {
      const { stdout } = await execFileAsync(this.gitPath, ["status", "--porcelain"], { encoding: "utf-8" })
      const files = stdout.trim().split("\n").filter(Boolean).map((line) => {
        const status = line.slice(0, 2)
        const path = line.slice(3)
        return { status, path }
      })
      return { success: true, message: "获取变更文件列表成功", data: { files } }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `获取变更文件列表失败: ${message}`, error: message }
    }
  }

  /** 创建发布分支 */
  async createReleaseBranch(baseBranch: string, releaseVersion: string): Promise<IntegrationResult> {
    try {
      const branchName = `release/${releaseVersion}`
      await execFileAsync(this.gitPath, ["checkout", "-b", branchName, baseBranch], { encoding: "utf-8" })
      return { success: true, message: `分支 ${branchName} 已创建`, data: { branchName, baseBranch, releaseVersion } }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `创建分支失败: ${message}`, error: message }
    }
  }

  /** 合并分支 */
  async mergeBranches(source: string, target: string): Promise<IntegrationResult> {
    try {
      await execFileAsync(this.gitPath, ["merge", "--no-ff", source, "--no-edit"], { encoding: "utf-8" })
      return { success: true, message: `${source} 已合并到 ${target}`, data: { source, target } }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return { success: false, message: `合并失败: ${message}`, error: message }
    }
  }

  /** 检查分支是否存在 */
  branchExists(name: string): boolean {
    try {
      execFileSync(this.gitPath, ["rev-parse", "--verify", name], { encoding: "utf-8" })
      return true
    } catch {
      return false
    }
  }
}

/** 创建默认 Git 集成实例 */
export function createGitClient(config?: GitIntegrationConfig): GitClient {
  return new GitClient(config)
}
