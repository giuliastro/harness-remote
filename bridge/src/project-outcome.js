import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 8_000
const MAX_GIT_OUTPUT = 1024 * 1024
export const MAX_PROJECT_OUTCOME_FILES = 200
export const MAX_PROJECT_OUTCOME_PATH_LENGTH = 1024

async function defaultRunGit(args) {
  return execFileAsync("git", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT
  })
}

async function readGit(runGit, args) {
  try {
    const result = await runGit(args)
    return { ok: true, value: String(result?.stdout ?? "") }
  } catch {
    return { ok: false, value: "" }
  }
}

function safeRelativeGitPath(value) {
  const raw = String(value ?? "")
  if (!raw || raw.includes("\0") || raw.length > MAX_PROJECT_OUTCOME_PATH_LENGTH) return undefined
  const normalized = raw.replace(/\\/g, "/")
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) return undefined
  return normalized
}

/**
 * Parse `git status --porcelain=v1 -z` without shell quoting or locale-dependent arrows.
 *
 * With `-z`, rename/copy entries are emitted as `XY new-path\0old-path\0`. Only repository-relative
 * paths are returned; malformed or escaping paths are ignored rather than exposed to the client.
 */
export function parseGitPorcelainV1Z(value, { maxFiles = MAX_PROJECT_OUTCOME_FILES } = {}) {
  const fields = String(value ?? "").split("\0")
  if (fields.at(-1) === "") fields.pop()

  const files = []
  let totalFiles = 0
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field.length < 4 || field[2] !== " ") continue

    const status = field.slice(0, 2)
    const candidatePath = safeRelativeGitPath(field.slice(3))
    const renameOrCopy = status.includes("R") || status.includes("C")
    let originalPath
    if (renameOrCopy && index + 1 < fields.length) {
      originalPath = safeRelativeGitPath(fields[index + 1])
      index += 1
    }

    if (!candidatePath) continue
    totalFiles += 1
    if (files.length >= maxFiles) continue

    files.push({
      path: candidatePath,
      indexStatus: status[0],
      worktreeStatus: status[1],
      ...(originalPath ? { originalPath } : {})
    })
  }

  return {
    files,
    totalFiles,
    truncated: totalFiles > files.length
  }
}

/**
 * Read a bounded, provider-neutral outcome snapshot from the daemon-local Git worktree.
 *
 * The snapshot is intentionally metadata-only: no diff hunks, file contents, remotes, credentials,
 * absolute paths, command output or harness/provider state cross the daemon boundary. Missing Git
 * evidence stays absent instead of being invented. This function never mutates the repository.
 */
export async function inspectGitProjectOutcome(projectPath, { runGit = defaultRunGit, maxFiles = MAX_PROJECT_OUTCOME_FILES } = {}) {
  if (typeof projectPath !== "string" || !projectPath.trim()) return null

  const root = await readGit(runGit, ["-C", projectPath, "rev-parse", "--show-toplevel"])
  if (!root.ok || !root.value.trim()) return null

  const repoRoot = root.value.trim()
  const [head, branch, status] = await Promise.all([
    readGit(runGit, ["-C", repoRoot, "rev-parse", "HEAD"]),
    readGit(runGit, ["-C", repoRoot, "branch", "--show-current"]),
    readGit(runGit, ["-C", repoRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"])
  ])

  const parsed = status.ok
    ? parseGitPorcelainV1Z(status.value, { maxFiles })
    : { files: [], totalFiles: 0, truncated: false }

  return {
    version: 1,
    vcs: "git",
    ...(head.ok && head.value.trim() ? { head: head.value.trim() } : {}),
    ...(branch.ok && branch.value.trim() ? { branch: branch.value.trim() } : {}),
    ...(status.ok ? {
      dirty: parsed.totalFiles > 0,
      files: parsed.files,
      totalChangedFiles: parsed.totalFiles,
      filesTruncated: parsed.truncated
    } : {})
  }
}
