import assert from "node:assert/strict"
import test from "node:test"
import {
  canonicalGitRemote,
  gitRemoteFingerprint,
  inspectGitProjectIdentity
} from "../src/project-identity.js"

function gitFixture(remote) {
  return async (args) => {
    const command = args.slice(2).join(" ")
    if (command === "rev-parse --show-toplevel") return { stdout: "/repo\n" }
    if (command === "config --get remote.origin.url") return { stdout: `${remote}\n` }
    if (command === "rev-list --max-parents=0 HEAD") return { stdout: "root-b\nroot-a\n" }
    if (command === "rev-parse HEAD") return { stdout: "deadbeef\n" }
    if (command === "branch --show-current") return { stdout: "feature/continuity\n" }
    if (command === "status --porcelain=v1 --untracked-files=all") return { stdout: " M src/app.js\n" }
    throw new Error(`Unexpected git command: ${command}`)
  }
}

test("HTTPS and SCP remotes produce the same opaque repository fingerprint without credentials", async () => {
  const httpsRemote = "https://secret-token@github.com/OpenAI/Harness-Remote.git"
  const sshRemote = "git@github.com:OpenAI/Harness-Remote.git"

  assert.equal(canonicalGitRemote(httpsRemote), "github.com/OpenAI/Harness-Remote")
  assert.equal(canonicalGitRemote(sshRemote), "github.com/OpenAI/Harness-Remote")
  assert.equal(gitRemoteFingerprint(httpsRemote), gitRemoteFingerprint(sshRemote))

  const identity = await inspectGitProjectIdentity("/repo", { runGit: gitFixture(httpsRemote) })
  assert.equal(identity.vcs, "git")
  assert.equal(identity.version, 1)
  assert.match(identity.repositoryFingerprint, /^[a-f0-9]{64}$/)
  assert.match(identity.historyFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(identity.head, "deadbeef")
  assert.equal(identity.branch, "feature/continuity")
  assert.equal(identity.dirty, true)
  assert.equal(JSON.stringify(identity).includes("secret-token"), false)
  assert.equal(JSON.stringify(identity).includes("github.com"), false)
})

test("root commit ordering does not change the history fingerprint", async () => {
  const first = await inspectGitProjectIdentity("/repo", { runGit: gitFixture("git@github.com:owner/repo.git") })
  const second = await inspectGitProjectIdentity("/repo", {
    runGit: async (args) => {
      const command = args.slice(2).join(" ")
      if (command === "rev-list --max-parents=0 HEAD") return { stdout: "root-a\nroot-b\n" }
      return gitFixture("git@github.com:owner/repo.git")(args)
    }
  })
  assert.equal(first.historyFingerprint, second.historyFingerprint)
})

test("missing optional metadata stays unverified instead of inventing equivalence", async () => {
  const identity = await inspectGitProjectIdentity("/repo", {
    runGit: async (args) => {
      const command = args.slice(2).join(" ")
      if (command === "rev-parse --show-toplevel") return { stdout: "/repo\n" }
      if (command === "status --porcelain=v1 --untracked-files=all") return { stdout: "" }
      throw new Error("metadata unavailable")
    }
  })
  assert.deepEqual(identity, { version: 1, vcs: "git", dirty: false })
})

test("a path that is no longer a Git worktree has no identity", async () => {
  const identity = await inspectGitProjectIdentity("/gone", {
    runGit: async () => { throw new Error("not a git repository") }
  })
  assert.equal(identity, null)
})
