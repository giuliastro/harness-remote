import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 8_000
const MAX_GIT_OUTPUT = 1024 * 1024

async function defaultRunGit(args) {
  return execFileAsync("git", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT
  })
}

function fingerprint(namespace, value) {
  return createHash("sha256").update(`${namespace}\0${value}`).digest("hex")
}

function stripGitSuffix(value) {
  return value.replace(/\/+$/, "").replace(/\.git$/i, "")
}

/**
 * Canonicalise only for hashing. The canonical remote is deliberately never returned by the API:
 * an HTTPS remote may contain a username/token and an SSH remote may contain a local username.
 */
export function canonicalGitRemote(value) {
  const remote = String(value ?? "").trim()
  if (!remote) return ""

  // Common SCP-style SSH syntax: git@github.com:owner/repo.git. URL schemes contain a colon too,
  // but must be parsed as URLs first so credentials never become part of the repository path.
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(remote)
  if (!remote.includes("://") && scp && !/^[A-Za-z]:[\\/]/.test(remote)) {
    return `${scp[1].toLowerCase()}/${stripGitSuffix(scp[2].replace(/^\/+/, ""))}`
  }

  try {
    const parsed = new URL(remote)
    if (parsed.hostname) {
      return `${parsed.hostname.toLowerCase()}/${stripGitSuffix(parsed.pathname.replace(/^\/+/, ""))}`
    }
  } catch {
    // A local-path remote has no portable identity across machines, but hashing the normalized
    // value is still useful evidence without exposing that path to the client.
  }

  return stripGitSuffix(remote.replace(/\\/g, "/"))
}

export function gitRemoteFingerprint(value) {
  const canonical = canonicalGitRemote(value)
  return canonical ? fingerprint("git-remote-v1", canonical) : undefined
}

function historyFingerprint(value) {
  const roots = String(value ?? "")
    .split(/\r?\n/)
    .map((root) => root.trim())
    .filter(Boolean)
    .sort()
  return roots.length ? fingerprint("git-roots-v1", roots.join("\n")) : undefined
}

async function readGit(runGit, args) {
  try {
    const result = await runGit(args)
    return { ok: true, value: String(result?.stdout ?? "").trim() }
  } catch {
    return { ok: false, value: "" }
  }
}

/**
 * Read a bounded, privacy-preserving Git identity for cross-machine continuity preflight.
 *
 * This function never mutates the repository. Remote URLs are reduced to an opaque fingerprint;
 * credentials and repository URLs never cross the daemon boundary. Missing Git metadata produces a
 * partial identity rather than an invented match. A later handoff must treat missing proof as
 * unverified/fail-closed, not as equivalence.
 */
export async function inspectGitProjectIdentity(projectPath, { runGit = defaultRunGit } = {}) {
  if (typeof projectPath !== "string" || !projectPath.trim()) return null

  const root = await readGit(runGit, ["-C", projectPath, "rev-parse", "--show-toplevel"])
  if (!root.ok || !root.value) return null

  const [remote, roots, head, branch, status] = await Promise.all([
    readGit(runGit, ["-C", root.value, "config", "--get", "remote.origin.url"]),
    readGit(runGit, ["-C", root.value, "rev-list", "--max-parents=0", "HEAD"]),
    readGit(runGit, ["-C", root.value, "rev-parse", "HEAD"]),
    readGit(runGit, ["-C", root.value, "branch", "--show-current"]),
    readGit(runGit, ["-C", root.value, "status", "--porcelain=v1", "--untracked-files=all"])
  ])

  const repositoryFingerprint = remote.ok ? gitRemoteFingerprint(remote.value) : undefined
  const rootsFingerprint = roots.ok ? historyFingerprint(roots.value) : undefined

  return {
    version: 1,
    vcs: "git",
    ...(repositoryFingerprint ? { repositoryFingerprint } : {}),
    ...(rootsFingerprint ? { historyFingerprint: rootsFingerprint } : {}),
    ...(head.ok && head.value ? { head: head.value } : {}),
    ...(branch.ok && branch.value ? { branch: branch.value } : {}),
    ...(status.ok ? { dirty: Boolean(status.value) } : {})
  }
}
