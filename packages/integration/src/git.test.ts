import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import { GitClient } from "./git.js"

const GIT_ENV_KEYS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8" })
}

function initRepo(dir: string): void {
  runGit(dir, ["init", "-b", "main"])
}

function commitFile(dir: string, filename: string, content: string, message: string): string {
  writeFileSync(join(dir, filename), content)
  runGit(dir, ["add", filename])
  runGit(dir, ["commit", "-m", message])
  return runGit(dir, ["rev-parse", "HEAD"]).trim()
}

function logBranches(dir: string, ref: string): string {
  return runGit(dir, ["log", ref, "--oneline", "--format=%s"])
}

describe("GitClient", () => {
  let tmpDir: string
  let envBackup: Record<string, string | undefined>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-test-"))
    envBackup = {}
    for (const key of GIT_ENV_KEYS) {
      envBackup[key] = process.env[key]
    }
    process.env["GIT_AUTHOR_NAME"] = "Test User"
    process.env["GIT_AUTHOR_EMAIL"] = "test@example.com"
    process.env["GIT_COMMITTER_NAME"] = "Test User"
    process.env["GIT_COMMITTER_EMAIL"] = "test@example.com"
  })

  afterEach(() => {
    for (const key of GIT_ENV_KEYS) {
      const value = envBackup[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function createClient(cwd?: string): GitClient {
    return new GitClient({ cwd: cwd ?? tmpDir })
  }

  describe("mergeBranches", () => {
    it("merges source into target and leaves main untouched", async () => {
      initRepo(tmpDir)
      commitFile(tmpDir, "base.txt", "base", "feat: base")

      runGit(tmpDir, ["checkout", "-b", "feature-a"])
      const commitA = commitFile(tmpDir, "a.txt", "a", "feat: a")

      runGit(tmpDir, ["checkout", "main"])
      runGit(tmpDir, ["checkout", "-b", "feature-b"])
      commitFile(tmpDir, "b.txt", "b", "feat: b")

      runGit(tmpDir, ["checkout", "main"])
      const result = await createClient().mergeBranches("feature-a", "feature-b")

      expect(result.success).toBe(true)
      expect(result.message).toContain("feature-a")
      expect(logBranches(tmpDir, "feature-b")).toContain("feat: a")
      expect(logBranches(tmpDir, "main")).not.toContain("feat: a")
      expect(runGit(tmpDir, ["branch", "--show-current"]).trim()).toBe("main")
      expect(runGit(tmpDir, ["rev-parse", "feature-b"]).trim()).not.toBe(commitA)
    })

    it("returns success:false when target branch does not exist", async () => {
      initRepo(tmpDir)
      commitFile(tmpDir, "base.txt", "base", "feat: base")
      runGit(tmpDir, ["checkout", "-b", "feature-a"])
      commitFile(tmpDir, "a.txt", "a", "feat: a")
      runGit(tmpDir, ["checkout", "main"])

      const result = await createClient().mergeBranches("feature-a", "no-such-branch")

      expect(result.success).toBe(false)
      expect(result.error).toBeTruthy()
      expect(runGit(tmpDir, ["branch", "--show-current"]).trim()).toBe("main")
    })

    it("returns success:false with error message on merge conflict", async () => {
      initRepo(tmpDir)
      commitFile(tmpDir, "file.txt", "base", "feat: base")

      runGit(tmpDir, ["checkout", "-b", "feature-a"])
      commitFile(tmpDir, "file.txt", "from-a", "feat: a")

      runGit(tmpDir, ["checkout", "main"])
      runGit(tmpDir, ["checkout", "-b", "feature-b"])
      commitFile(tmpDir, "file.txt", "from-b", "feat: b")

      runGit(tmpDir, ["checkout", "main"])
      const result = await createClient().mergeBranches("feature-a", "feature-b")

      expect(result.success).toBe(false)
      expect(result.error).toBeTruthy()
      expect(runGit(tmpDir, ["branch", "--show-current"]).trim()).toBe("main")
      expect(runGit(tmpDir, ["status", "--porcelain"]).trim()).toBe("")
    })
  })

  describe("healthCheck", () => {
    it("returns success:false when git is not available at gitPath", async () => {
      const client = new GitClient({ gitPath: join(tmpDir, "no-such-git") })
      const result = await client.healthCheck()
      expect(result.success).toBe(false)
    })

    it("returns success:true when git is available", async () => {
      const result = await createClient().healthCheck()
      expect(result.success).toBe(true)
    })
  })
})